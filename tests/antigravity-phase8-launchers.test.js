import { EventEmitter } from 'events';
import fs from 'fs';
import { jest } from '@jest/globals';

import { LauncherSupervisor } from '../src/core/launcher-supervisor.js';
import { DockerAwareLauncher } from '../src/core/launchers/docker-aware-launcher.js';
import { NamespaceLauncher } from '../src/core/launchers/namespace-launcher.js';
import { SystemdNotifyLauncher } from '../src/core/launchers/systemd-notify-launcher.js';
import { createWorkerMessageHandler } from '../src/services/worker-ipc.js';

function createWorker(pid = 1000) {
    const worker = new EventEmitter();
    worker.pid = pid;
    worker.send = jest.fn();
    worker.kill = jest.fn((signal) => {
        worker.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal);
    });
    return worker;
}

function createLauncher(name, overrides = {}) {
    return {
        name,
        isAvailable: jest.fn(async () => true),
        launchWorker: jest.fn(async () => createWorker()),
        shutdownWorker: jest.fn(async (worker, graceful = true) => {
            if (worker) {
                worker.emit('exit', graceful ? 0 : 137, graceful ? 'SIGTERM' : 'SIGKILL');
            }
        }),
        notifyReady: jest.fn(),
        notifyStopping: jest.fn(),
        startWatchdog: jest.fn(),
        stopWatchdog: jest.fn(),
        ...overrides,
    };
}

describe('Phase 8 launcher supervisor', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-06T00:00:00.000Z'));
    });

    afterEach(async () => {
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('selects launchers by probe order and honors explicit override', async () => {
        const namespaceLauncher = createLauncher('namespace', {
            isAvailable: jest.fn(async () => false),
        });
        const systemdLauncher = createLauncher('systemd');
        const forkLauncher = createLauncher('fork');

        const autoSupervisor = new LauncherSupervisor({
            workerScript: 'worker.js',
            args: ['--flag'],
            config: {
                launchStrategy: 'auto',
                heartbeatIntervalMs: 1000,
                heartbeatMaxMisses: 2,
            },
            launchers: [namespaceLauncher, systemdLauncher, forkLauncher],
        });

        await autoSupervisor.startWorker();

        expect(namespaceLauncher.isAvailable).toHaveBeenCalled();
        expect(systemdLauncher.launchWorker).toHaveBeenCalled();
        expect(forkLauncher.launchWorker).not.toHaveBeenCalled();
        expect(autoSupervisor.getStatus().worker.launchStrategy).toBe('systemd');

        const overrideSupervisor = new LauncherSupervisor({
            workerScript: 'worker.js',
            config: {
                launchStrategy: 'fork',
                heartbeatIntervalMs: 1000,
                heartbeatMaxMisses: 2,
            },
            launchers: [namespaceLauncher, systemdLauncher, forkLauncher],
        });

        await overrideSupervisor.startWorker();

        expect(forkLauncher.launchWorker).toHaveBeenCalledTimes(1);
        expect(overrideSupervisor.getStatus().worker.launchStrategy).toBe('fork');
    });

    test('falls back to the next launcher when the first available launcher fails to start', async () => {
        const namespaceLauncher = createLauncher('namespace', {
            launchWorker: jest.fn(async () => {
                throw new Error('unshare failed');
            }),
        });
        const forkLauncher = createLauncher('fork');

        const supervisor = new LauncherSupervisor({
            workerScript: 'worker.js',
            config: {
                launchStrategy: 'auto',
                heartbeatIntervalMs: 1000,
                heartbeatMaxMisses: 2,
            },
            launchers: [namespaceLauncher, forkLauncher],
        });

        await supervisor.startWorker();

        expect(namespaceLauncher.launchWorker).toHaveBeenCalled();
        expect(forkLauncher.launchWorker).toHaveBeenCalled();
        expect(supervisor.getStatus().worker.launchStrategy).toBe('fork');
    });

    test('falls back to the next launcher after a runtime crash before the worker reports ready', async () => {
        const crashingWorker = createWorker(1101);
        const fallbackWorker = createWorker(1102);
        const namespaceLauncher = createLauncher('namespace', {
            launchWorker: jest.fn(async () => crashingWorker),
        });
        const forkLauncher = createLauncher('fork', {
            launchWorker: jest.fn(async () => fallbackWorker),
        });

        const supervisor = new LauncherSupervisor({
            workerScript: 'worker.js',
            config: {
                launchStrategy: 'auto',
                heartbeatIntervalMs: 1000,
                heartbeatMaxMisses: 2,
            },
            launchers: [namespaceLauncher, forkLauncher],
            restartDelayMs: 0,
        });

        await supervisor.startWorker();
        crashingWorker.emit('exit', 1, null);

        await jest.advanceTimersByTimeAsync(0);
        if (supervisor.pendingRestart) {
            await supervisor.pendingRestart;
        }

        expect(namespaceLauncher.launchWorker).toHaveBeenCalledTimes(1);
        expect(forkLauncher.launchWorker).toHaveBeenCalledTimes(1);
        expect(supervisor.getStatus().worker.launchStrategy).toBe('fork');
    });

    test('tracks heartbeat pings and restarts workers after the configured miss threshold', async () => {
        const firstWorker = createWorker(1001);
        const secondWorker = createWorker(1002);
        const forkLauncher = createLauncher('fork', {
            launchWorker: jest.fn()
                .mockResolvedValueOnce(firstWorker)
                .mockResolvedValueOnce(secondWorker),
        });

        const supervisor = new LauncherSupervisor({
            workerScript: 'worker.js',
            config: {
                launchStrategy: 'fork',
                heartbeatIntervalMs: 1000,
                heartbeatMaxMisses: 2,
            },
            launchers: [forkLauncher],
            restartDelayMs: 0,
        });

        await supervisor.startWorker();
        supervisor.handleWorkerMessage({
            type: 'ready',
            pid: firstWorker.pid,
        });
        supervisor.handleWorkerMessage({
            type: 'heartbeat_pong',
            pid: firstWorker.pid,
            memory: { rss: 123 },
            cpu: { user: 5, system: 3 },
            requestCount: 7,
        });

        expect(supervisor.getStatus().worker.heartbeat.requestCount).toBe(7);
        expect(forkLauncher.notifyReady).toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(0);
        if (supervisor.pendingRestart) {
            await supervisor.pendingRestart;
        }

        expect(firstWorker.send).toHaveBeenCalledWith({ type: 'heartbeat_ping' });
        expect(supervisor.getStatus().worker.restartCount).toBe(1);
        expect(supervisor.getStatus().worker.pid).toBe(1002);
    });

    test('stopWorker rejects when graceful shutdown and forced termination still do not produce an actual worker exit', async () => {
        const worker = createWorker(1200);
        const forkLauncher = createLauncher('fork', {
            launchWorker: jest.fn(async () => worker),
            shutdownWorker: jest.fn(async () => {}),
        });

        const supervisor = new LauncherSupervisor({
            workerScript: 'worker.js',
            config: {
                launchStrategy: 'fork',
                heartbeatIntervalMs: 1000,
                heartbeatMaxMisses: 2,
            },
            launchers: [forkLauncher],
            shutdownTimeoutMs: 250,
        });

        await supervisor.startWorker();

        const stopPromise = supervisor.stopWorker(true);
        const stopExpectation = expect(stopPromise).rejects.toThrow('did not exit');
        await jest.advanceTimersByTimeAsync(500);

        await stopExpectation;
        expect(forkLauncher.shutdownWorker).toHaveBeenNthCalledWith(1, worker, true);
        expect(forkLauncher.shutdownWorker).toHaveBeenNthCalledWith(2, worker, false);
        expect(supervisor.getStatus().worker.isRunning).toBe(true);
        expect(supervisor.getStatus().worker.pid).toBe(1200);
    });

    test('unexpected exits run launcher cleanup before auto-restart so docker handlers do not stack', async () => {
        const firstWorker = createWorker(1301);
        const secondWorker = createWorker(1302);
        const forkFn = jest.fn()
            .mockResolvedValueOnce(firstWorker)
            .mockResolvedValueOnce(secondWorker);
        const processOn = jest.fn();
        const processOff = jest.fn();
        const setIntervalFn = jest.fn()
            .mockImplementationOnce(() => ({ id: 'reaper-1' }))
            .mockImplementationOnce(() => ({ id: 'reaper-2' }));
        const clearIntervalFn = jest.fn();
        const dockerLauncher = new DockerAwareLauncher({
            platform: 'linux',
            processPid: 1,
            fileExistsFn: () => true,
            forkFn,
            processOn,
            processOff,
            waitpidModule: {
                waitpid: jest.fn(() => ({ return: 0, exitCode: null, signalCode: null })),
                WNOHANG: 1,
            },
            setIntervalFn,
            clearIntervalFn,
        });

        const supervisor = new LauncherSupervisor({
            workerScript: 'worker.js',
            config: {
                launchStrategy: 'auto',
                heartbeatIntervalMs: 1000,
                heartbeatMaxMisses: 2,
            },
            launchers: [dockerLauncher],
            restartDelayMs: 0,
        });

        await supervisor.startWorker();
        firstWorker.emit('exit', 1, null);

        await jest.advanceTimersByTimeAsync(0);
        if (supervisor.pendingRestart) {
            await supervisor.pendingRestart;
        }

        expect(processOn).toHaveBeenCalledTimes(4);
        expect(processOff).toHaveBeenCalledTimes(2);
        expect(clearIntervalFn).toHaveBeenCalledWith({ id: 'reaper-1' });
        expect(supervisor.getStatus().worker.pid).toBe(1302);
    });
});

describe('Phase 8 launcher implementations', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(async () => {
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('NamespaceLauncher uses a user namespace and tmpfs /tmp isolation without enabling network namespaces', async () => {
        const spawnFn = jest.fn();
        const launcher = new NamespaceLauncher({
            platform: 'linux',
            execPath: '/usr/bin/node',
            shellPath: '/bin/sh',
            spawnFn,
        });

        await launcher.launchWorker({
            workerScript: '/app/worker.js',
            args: ['--flag'],
            env: { TEST_ENV: '1' },
        });

        expect(spawnFn).toHaveBeenCalledWith(
            'unshare',
            expect.arrayContaining([
                '--user',
                '--map-root-user',
                '--fork',
                '--pid',
                '--mount',
                '--mount-proc',
                '/bin/sh',
                '-lc',
                expect.stringContaining('mount -t tmpfs tmpfs /tmp'),
            ]),
            expect.objectContaining({
                env: { TEST_ENV: '1' },
            })
        );

        const unshareArgs = spawnFn.mock.calls[0][1];
        expect(unshareArgs).not.toContain('--net');
    });

    test('SystemdNotifyLauncher only activates on Linux and uses the sd-notify abstraction for READY/STOPPING/WATCHDOG', async () => {
        const sdNotifyModule = {
            ready: jest.fn(),
            sendState: jest.fn(),
            watchdog: jest.fn(),
            watchdogInterval: jest.fn(() => 6000),
        };
        const setIntervalFn = jest.fn((fn) => {
            setIntervalFn.callback = fn;
            return { id: 'watchdog-timer' };
        });
        const clearIntervalFn = jest.fn();
        const launcher = new SystemdNotifyLauncher({
            platform: 'linux',
            processEnv: { NOTIFY_SOCKET: '/run/systemd/notify' },
            sdNotifyModule,
            setIntervalFn,
            clearIntervalFn,
        });

        expect(await launcher.isAvailable()).toBe(true);

        launcher.notifyReady();
        launcher.notifyStopping();
        launcher.startWatchdog();
        setIntervalFn.callback();
        launcher.stopWatchdog();

        expect(sdNotifyModule.ready).toHaveBeenCalledTimes(1);
        expect(sdNotifyModule.sendState).toHaveBeenCalledWith('STOPPING=1\n');
        expect(sdNotifyModule.watchdog).toHaveBeenCalledTimes(1);
        expect(sdNotifyModule.watchdogInterval).toHaveBeenCalledTimes(1);
        expect(clearIntervalFn).toHaveBeenCalledWith({ id: 'watchdog-timer' });

        const nonLinuxLauncher = new SystemdNotifyLauncher({
            platform: 'win32',
            processEnv: { NOTIFY_SOCKET: '/run/systemd/notify' },
            sdNotifyModule,
        });

        expect(await nonLinuxLauncher.isAvailable()).toBe(false);
    });

    test('SystemdNotifyLauncher falls back to direct Unix datagram notifications when sd-notify is unavailable', async () => {
        const sendTo = jest.fn();
        const close = jest.fn();
        class DgramSocket {
            sendTo(...args) {
                sendTo(...args);
            }

            close() {
                close();
            }
        }

        const launcher = new SystemdNotifyLauncher({
            platform: 'linux',
            processEnv: { NOTIFY_SOCKET: '@/run/systemd/notify' },
            loadSdNotifyModule: jest.fn(async () => {
                throw new Error('sd-notify missing');
            }),
            unixSocketModule: { DgramSocket },
            setIntervalFn: jest.fn((fn) => {
                launcher.watchdogCallback = fn;
                return { id: 'fallback-watchdog' };
            }),
            clearIntervalFn: jest.fn(),
        });

        expect(await launcher.isAvailable()).toBe(true);

        launcher.notifyReady();
        launcher.notifyStopping();
        launcher.startWatchdog(4000);
        launcher.watchdogCallback();
        launcher.stopWatchdog();

        expect(sendTo.mock.calls.map(call => ({
            payload: call[0].toString('utf8'),
            offset: call[1],
            length: call[2],
            path: call[3],
        }))).toEqual([
            { payload: 'READY=1\n', offset: 0, length: 8, path: '@/run/systemd/notify' },
            { payload: 'STOPPING=1\n', offset: 0, length: 11, path: '@/run/systemd/notify' },
            { payload: 'WATCHDOG=1\n', offset: 0, length: 11, path: '@/run/systemd/notify' },
        ]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('DockerAwareLauncher forwards PID 1 signals to the worker and runs the waitpid zombie reaper loop', async () => {
        const worker = createWorker(777);
        const forkFn = jest.fn(async () => worker);
        const processOn = jest.fn();
        const processOff = jest.fn();
        const waitpidModule = {
            waitpid: jest.fn()
                .mockReturnValueOnce({ return: 777, exitCode: 0, signalCode: null })
                .mockReturnValueOnce({ return: 0, exitCode: null, signalCode: null }),
            WNOHANG: 1,
        };
        const setIntervalFn = jest.fn((fn) => {
            setIntervalFn.callback = fn;
            return { id: 'reaper-timer' };
        });
        const clearIntervalFn = jest.fn();

        const launcher = new DockerAwareLauncher({
            platform: 'linux',
            processPid: 1,
            forkFn,
            processOn,
            processOff,
            waitpidModule,
            setIntervalFn,
            clearIntervalFn,
        });

        const launchedWorker = await launcher.launchWorker({
            workerScript: 'worker.js',
            args: [],
            env: {},
        });

        const sigtermHandler = processOn.mock.calls.find(call => call[0] === 'SIGTERM')[1];
        const sigintHandler = processOn.mock.calls.find(call => call[0] === 'SIGINT')[1];

        sigtermHandler();
        sigintHandler();
        setIntervalFn.callback();

        expect(launchedWorker).toBe(worker);
        expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
        expect(worker.kill).toHaveBeenCalledWith('SIGINT');
        expect(waitpidModule.waitpid).toHaveBeenNthCalledWith(1, -1, waitpidModule.WNOHANG);
        expect(waitpidModule.waitpid).toHaveBeenNthCalledWith(2, -1, waitpidModule.WNOHANG);

        await launcher.shutdownWorker(worker, true);

        expect(clearIntervalFn).toHaveBeenCalledWith({ id: 'reaper-timer' });
        expect(processOff).toHaveBeenCalledWith('SIGTERM', sigtermHandler);
        expect(processOff).toHaveBeenCalledWith('SIGINT', sigintHandler);
    });

    test('DockerAwareLauncher refuses PID 1 mode when waitpid support is unavailable', async () => {
        const forkFn = jest.fn();
        const launcher = new DockerAwareLauncher({
            platform: 'linux',
            processPid: 1,
            forkFn,
            fileExistsFn: () => true,
            loadWaitpidModule: jest.fn(async () => {
                throw new Error('waitpid missing');
            }),
        });

        expect(await launcher.isAvailable()).toBe(false);
        await expect(launcher.launchWorker({
            workerScript: 'worker.js',
            args: [],
            env: {},
        })).rejects.toThrow('waitpid support');
        expect(forkFn).not.toHaveBeenCalled();
    });
});

describe('Phase 8 worker heartbeat IPC', () => {
    test('responds to heartbeat_ping with runtime stats', () => {
        const sendToMaster = jest.fn();
        const handler = createWorkerMessageHandler({
            sendToMaster,
            gracefulShutdown: jest.fn(),
            getRuntimeStats: () => ({
                memory: { rss: 456 },
                cpu: { user: 11, system: 4 },
                requestCount: 9,
            }),
        });

        handler({ type: 'heartbeat_ping' });

        expect(sendToMaster).toHaveBeenCalledWith({
            type: 'heartbeat_pong',
            memory: { rss: 456 },
            cpu: { user: 11, system: 4 },
            requestCount: 9,
        });
    });
});

describe('Phase 8 Docker packaging', () => {
    test('Dockerfile installs tini and native build prerequisites before npm install and uses tini as entrypoint', () => {
        const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

        const installLineIndex = dockerfile.indexOf('RUN apk add --no-cache');
        const npmInstallIndex = dockerfile.indexOf('RUN npm install');
        const entrypointIndex = dockerfile.indexOf('ENTRYPOINT ["tini", "--"]');

        expect(installLineIndex).toBeGreaterThanOrEqual(0);
        expect(dockerfile).toContain('tini');
        expect(dockerfile).toContain('python3');
        expect(dockerfile).toContain('make');
        expect(dockerfile).toContain('g++');
        expect(npmInstallIndex).toBeGreaterThan(installLineIndex);
        expect(entrypointIndex).toBeGreaterThan(npmInstallIndex);
    });

    test('docker compose enables init so the common runtime paths do not run node as raw PID 1', () => {
        const composeFile = fs.readFileSync(new URL('../docker/docker-compose.yml', import.meta.url), 'utf8');
        const buildComposeFile = fs.readFileSync(new URL('../docker/docker-compose.build.yml', import.meta.url), 'utf8');

        expect(composeFile).toMatch(/init:\s*true/);
        expect(buildComposeFile).toMatch(/init:\s*true/);
    });
});
