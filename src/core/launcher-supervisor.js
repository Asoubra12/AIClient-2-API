import logger from '../utils/logger.js';
import { DockerAwareLauncher } from './launchers/docker-aware-launcher.js';
import { NamespaceLauncher } from './launchers/namespace-launcher.js';
import { SimpleForkLauncher } from './launchers/simple-fork-launcher.js';
import { SystemdNotifyLauncher } from './launchers/systemd-notify-launcher.js';

const STRATEGY_ALIASES = {
    auto: 'auto',
    namespace: 'namespace',
    systemd: 'systemd',
    docker: 'docker',
    fork: 'fork',
    'simple-fork': 'fork',
};

export class LauncherSupervisor {
    constructor(options = {}) {
        this.logger = options.logger || logger;
        this.workerScript = options.workerScript;
        this.args = options.args || [];
        this.processEnv = options.processEnv || process.env;
        this.processPid = options.processPid || process.pid;
        this.processUptime = options.processUptime || (() => process.uptime());
        this.processMemoryUsage = options.processMemoryUsage || (() => process.memoryUsage());
        this.now = options.now || (() => Date.now());
        this.launchers = options.launchers || [
            new NamespaceLauncher({ logger: this.logger }),
            new SystemdNotifyLauncher({ logger: this.logger }),
            new DockerAwareLauncher({ logger: this.logger }),
            new SimpleForkLauncher({ logger: this.logger }),
        ];

        const config = options.config || {};
        this.launchStrategy = STRATEGY_ALIASES[config.launchStrategy ?? config.LAUNCH_STRATEGY ?? 'auto'] || 'auto';
        this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? config.HEARTBEAT_INTERVAL_MS ?? 30000;
        this.heartbeatMaxMisses = config.heartbeatMaxMisses ?? config.HEARTBEAT_MAX_MISSES ?? 3;
        this.maxRestartAttempts = options.maxRestartAttempts ?? config.maxRestartAttempts ?? 10;
        this.restartDelayMs = options.restartDelayMs ?? config.restartDelayMs ?? 1000;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;

        this.workerProcess = null;
        this.currentLauncher = null;
        this.heartbeatTimer = null;
        this.restartTimer = null;
        this.pendingRestart = null;
        this.expectedExit = false;
        this.workerReadyReported = false;
        this.launchersToSkipOnce = new Set();
        this.readyWaiters = new Set();

        this.workerStatus = {
            pid: null,
            startTime: null,
            restartCount: 0,
            lastRestartTime: null,
            isRestarting: false,
            isRunning: false,
            launchStrategy: null,
            lastMessageAt: null,
            lastExit: null,
            heartbeat: {
                lastPingAt: null,
                lastPongAt: null,
                missedBeats: 0,
                requestCount: 0,
                memory: null,
                cpu: null,
            },
        };
    }

    _log(level, message) {
        if (typeof this.logger?.[level] === 'function') {
            this.logger[level](`[LauncherSupervisor] ${message}`);
        }
    }

    _buildWorkerEnv() {
        return {
            ...this.processEnv,
            IS_WORKER_PROCESS: 'true',
            MASTER_PORT: this.processEnv.MASTER_PORT || '3100',
        };
    }

    _attachWorkerListeners(worker) {
        worker.on('message', (message) => {
            this.handleWorkerMessage(message);
        });

        worker.on('exit', (code, signal) => {
            this._handleWorkerExit(worker, code, signal);
        });

        worker.on('error', (error) => {
            this._log('error', `Worker process error: ${error.message}`);
        });
    }

    async _resolveCandidates() {
        if (this.launchStrategy !== 'auto') {
            const selectedLauncher = this.launchers.find(launcher => launcher.name === this.launchStrategy);
            if (!selectedLauncher) {
                throw new Error(`Unknown launch strategy '${this.launchStrategy}'`);
            }
            return [selectedLauncher];
        }

        const launchersToSkip = new Set(this.launchersToSkipOnce);
        this.launchersToSkipOnce.clear();

        const filteredLaunchers = this.launchers.filter(launcher => !launchersToSkip.has(launcher.name));
        return filteredLaunchers.length > 0 ? filteredLaunchers : this.launchers;
    }

    _resetHeartbeatState() {
        this.workerStatus.lastMessageAt = this.now();
        this.workerStatus.heartbeat.lastPingAt = null;
        this.workerStatus.heartbeat.lastPongAt = null;
        this.workerStatus.heartbeat.missedBeats = 0;
        this.workerStatus.heartbeat.requestCount = 0;
        this.workerStatus.heartbeat.memory = null;
        this.workerStatus.heartbeat.cpu = null;
    }

    _startHeartbeatMonitor() {
        this._stopHeartbeatMonitor();

        this.heartbeatTimer = setInterval(() => {
            if (!this.workerProcess) {
                return;
            }

            this.workerStatus.heartbeat.lastPingAt = new Date(this.now()).toISOString();
            this.workerProcess.send?.({ type: 'heartbeat_ping' });

            const silenceMs = this.now() - (this.workerStatus.lastMessageAt || this.now());
            this.workerStatus.heartbeat.missedBeats = Math.floor(silenceMs / this.heartbeatIntervalMs);

            if (silenceMs >= this.heartbeatIntervalMs * this.heartbeatMaxMisses) {
                this._log('warn', 'Worker missed heartbeat threshold, restarting...');
                this.restartWorker();
            }
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    _stopHeartbeatMonitor() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    _waitForWorkerExit(worker, timeoutMs = this.shutdownTimeoutMs) {
        return new Promise((resolve, reject) => {
            const onExit = () => {
                clearTimeout(timeout);
                worker.removeListener?.('exit', onExit);
                resolve();
            };

            const timeout = setTimeout(() => {
                worker.removeListener?.('exit', onExit);
                reject(new Error(`Worker did not exit within ${timeoutMs}ms`));
            }, timeoutMs);
            timeout.unref?.();

            worker.once?.('exit', onExit);
        });
    }

    _settleReadyWaiters(error = null) {
        for (const waiter of this.readyWaiters) {
            clearTimeout(waiter.timeout);
            if (error) {
                waiter.reject(error);
            } else {
                waiter.resolve();
            }
        }
        this.readyWaiters.clear();
    }

    awaitWorkerReady(timeoutMs = this.heartbeatIntervalMs * this.heartbeatMaxMisses) {
        if (this.workerReadyReported) {
            return Promise.resolve();
        }

        if (!this.workerProcess) {
            return Promise.reject(new Error('No worker process is running'));
        }

        return new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                timeout: null,
            };

            waiter.timeout = setTimeout(() => {
                this.readyWaiters.delete(waiter);
                reject(new Error(`Worker did not report ready within ${timeoutMs}ms`));
            }, timeoutMs);
            waiter.timeout.unref?.();

            this.readyWaiters.add(waiter);
        });
    }

    async startWorker() {
        if (this.workerProcess) {
            return this.workerProcess;
        }

        const candidates = await this._resolveCandidates();
        let lastError = null;

        for (const launcher of candidates) {
            if (this.launchStrategy === 'auto') {
                const available = await launcher.isAvailable({
                    workerScript: this.workerScript,
                    args: this.args,
                });
                if (!available) {
                    continue;
                }
            }

            try {
                const worker = await launcher.launchWorker({
                    workerScript: this.workerScript,
                    args: this.args,
                    env: this._buildWorkerEnv(),
                });
                this.currentLauncher = launcher;
                this.workerProcess = worker;
                this.expectedExit = false;
                this.workerReadyReported = false;
                this.workerStatus.pid = worker.pid || null;
                this.workerStatus.startTime = new Date(this.now()).toISOString();
                this.workerStatus.isRunning = true;
                this.workerStatus.launchStrategy = launcher.name;
                this._resetHeartbeatState();
                this._attachWorkerListeners(worker);
                this._startHeartbeatMonitor();
                this._log('info', `Selected launch strategy '${launcher.name}'`);
                return worker;
            } catch (error) {
                lastError = error;
                this._log('warn', `Launch strategy '${launcher.name}' failed: ${error.message}`);
                if (this.launchStrategy !== 'auto') {
                    break;
                }
            }
        }

        throw lastError || new Error('No available launcher strategy could start the worker');
    }

    async stopWorker(graceful = true) {
        if (!this.workerProcess) {
            return;
        }

        const worker = this.workerProcess;
        const launcher = this.currentLauncher;
        this.expectedExit = true;
        this._stopHeartbeatMonitor();
        launcher?.notifyStopping?.();
        launcher?.stopWatchdog?.();

        const requestShutdown = async (isGraceful) => {
            const exitPromise = this._waitForWorkerExit(worker, this.shutdownTimeoutMs);
            let shutdownError = null;

            try {
                await Promise.resolve(launcher?.shutdownWorker?.(worker, isGraceful));
            } catch (error) {
                shutdownError = error;
            }

            try {
                await exitPromise;
            } catch (error) {
                throw shutdownError || error;
            }

            if (shutdownError) {
                throw shutdownError;
            }
        };

        try {
            await requestShutdown(graceful);
        } catch (error) {
            if (!graceful || !this.workerProcess) {
                throw error;
            }

            this._log('warn', `Graceful shutdown timed out, forcing worker exit: ${error.message}`);
            await requestShutdown(false);
        }
    }

    async restartWorker() {
        if (this.pendingRestart) {
            return this.pendingRestart;
        }

        this.pendingRestart = (async () => {
            this.workerStatus.isRestarting = true;
            this.workerStatus.restartCount += 1;
            this.workerStatus.lastRestartTime = new Date(this.now()).toISOString();

            try {
                await this.stopWorker(true);
                if (this.restartDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.restartDelayMs));
                }
                await this.startWorker();
            } finally {
                this.workerStatus.isRestarting = false;
                this.pendingRestart = null;
            }
        })();

        return this.pendingRestart;
    }

    scheduleRestart() {
        if (this.workerStatus.restartCount >= this.maxRestartAttempts) {
            this._log('error', 'Max restart attempts reached, not restarting worker');
            return;
        }

        const delayMs = Math.min(this.restartDelayMs * Math.pow(2, this.workerStatus.restartCount), 30000);
        this.restartTimer = setTimeout(() => {
            this.restartWorker();
        }, delayMs);
        this.restartTimer.unref?.();
    }

    _handleWorkerExit(worker, code, signal) {
        const isCurrentWorker = this.workerProcess === worker || this.workerStatus.pid === worker?.pid;
        if (!isCurrentWorker) {
            return;
        }

        const launcher = this.currentLauncher;
        this._stopHeartbeatMonitor();
        launcher?.stopWatchdog?.();
        launcher?.handleWorkerExit?.(worker);
        this.workerStatus.isRunning = false;
        this.workerStatus.lastExit = {
            code,
            signal,
            at: new Date(this.now()).toISOString(),
        };
        this.workerProcess = null;
        this.currentLauncher = null;
        this.workerStatus.pid = null;
        this._settleReadyWaiters(new Error(`Worker exited before becoming ready (code: ${code}, signal: ${signal || 'none'})`));

        if (
            this.launchStrategy === 'auto' &&
            !this.expectedExit &&
            !this.workerReadyReported &&
            code !== 0 &&
            launcher?.name
        ) {
            this.launchersToSkipOnce.add(launcher.name);
        }

        if (!this.expectedExit && !this.workerStatus.isRestarting && code !== 0) {
            this._log('warn', `Worker exited unexpectedly with code ${code}, scheduling restart`);
            this.scheduleRestart();
        }

        this.expectedExit = false;
        this.workerReadyReported = false;
    }

    handleWorkerMessage(message) {
        if (!message?.type) {
            return;
        }

        this.workerStatus.lastMessageAt = this.now();

        switch (message.type) {
            case 'ready':
                this.workerReadyReported = true;
                this._settleReadyWaiters();
                this.currentLauncher?.notifyReady?.();
                this.currentLauncher?.startWatchdog?.(Math.max(1000, Math.floor(this.heartbeatIntervalMs / 2)));
                break;
            case 'restart_request':
                this.restartWorker();
                break;
            case 'heartbeat_pong':
                this.workerStatus.heartbeat.lastPongAt = new Date(this.now()).toISOString();
                this.workerStatus.heartbeat.missedBeats = 0;
                this.workerStatus.heartbeat.memory = message.memory || null;
                this.workerStatus.heartbeat.cpu = message.cpu || null;
                this.workerStatus.heartbeat.requestCount = message.requestCount || 0;
                break;
            case 'status':
                this.workerStatus.heartbeat.memory = message.data?.memoryUsage || this.workerStatus.heartbeat.memory;
                break;
            default:
                break;
        }
    }

    getStatus() {
        return {
            master: {
                pid: this.processPid,
                uptime: this.processUptime(),
                memoryUsage: this.processMemoryUsage(),
            },
            worker: {
                pid: this.workerStatus.pid,
                startTime: this.workerStatus.startTime,
                restartCount: this.workerStatus.restartCount,
                lastRestartTime: this.workerStatus.lastRestartTime,
                isRestarting: this.workerStatus.isRestarting,
                isRunning: this.workerStatus.isRunning,
                readyReported: this.workerReadyReported,
                launchStrategy: this.workerStatus.launchStrategy,
                heartbeat: { ...this.workerStatus.heartbeat },
                lastMessageAt: this.workerStatus.lastMessageAt ? new Date(this.workerStatus.lastMessageAt).toISOString() : null,
                lastExit: this.workerStatus.lastExit,
            },
        };
    }
}
