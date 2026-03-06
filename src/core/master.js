import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { pathToFileURL } from 'url';

import logger from '../utils/logger.js';
import { isRetryableNetworkError } from '../utils/common.js';
import { LauncherSupervisor } from './launcher-supervisor.js';

const CONFIG_PATH = path.resolve(process.cwd(), 'configs/config.json');

export function loadMasterRuntimeConfig() {
    const defaults = {
        workerScript: path.resolve(process.cwd(), 'src/services/api-server.js'),
        maxRestartAttempts: 10,
        restartDelayMs: 1000,
        masterPort: parseInt(process.env.MASTER_PORT || '3100', 10),
        args: process.argv.slice(2),
        launchStrategy: 'auto',
        heartbeatIntervalMs: 30000,
        heartbeatMaxMisses: 3,
    };

    let loaded = {};
    try {
        loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`[Master] Failed to load ${CONFIG_PATH}: ${error.message}`);
        }
    }

    return {
        ...defaults,
        launchStrategy: loaded.launchStrategy ?? loaded.LAUNCH_STRATEGY ?? defaults.launchStrategy,
        heartbeatIntervalMs: loaded.heartbeatIntervalMs ?? loaded.HEARTBEAT_INTERVAL_MS ?? defaults.heartbeatIntervalMs,
        heartbeatMaxMisses: loaded.heartbeatMaxMisses ?? loaded.HEARTBEAT_MAX_MISSES ?? defaults.heartbeatMaxMisses,
    };
}

export function createSupervisor(runtimeConfig) {
    return new LauncherSupervisor({
        logger,
        workerScript: runtimeConfig.workerScript,
        args: runtimeConfig.args,
        config: {
            launchStrategy: runtimeConfig.launchStrategy,
            heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs,
            heartbeatMaxMisses: runtimeConfig.heartbeatMaxMisses,
            maxRestartAttempts: runtimeConfig.maxRestartAttempts,
            restartDelayMs: runtimeConfig.restartDelayMs,
        },
        maxRestartAttempts: runtimeConfig.maxRestartAttempts,
        restartDelayMs: runtimeConfig.restartDelayMs,
        processEnv: {
            ...process.env,
            MASTER_PORT: String(runtimeConfig.masterPort),
        },
    });
}

export function buildHealthPayload(supervisor) {
    const status = supervisor.getStatus();
    return {
        status: status.worker.isRunning && status.worker.readyReported ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        ...status,
    };
}

function writeJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

export function createMasterServer({ supervisor, port }) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const method = req.method;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (method === 'GET' && pathname === '/master/status') {
            writeJson(res, 200, supervisor.getStatus());
            return;
        }

        if (method === 'GET' && pathname === '/master/health') {
            writeJson(res, 200, buildHealthPayload(supervisor));
            return;
        }

        if (method === 'POST' && pathname === '/master/restart') {
            try {
                await supervisor.restartWorker();
                await supervisor.awaitWorkerReady?.();
                writeJson(res, 200, {
                    success: true,
                    message: 'Worker restarted successfully',
                    worker: supervisor.getStatus().worker,
                });
            } catch (error) {
                writeJson(res, 503, {
                    success: false,
                    message: error.message,
                    worker: supervisor.getStatus().worker,
                });
            }
            return;
        }

        if (method === 'POST' && pathname === '/master/stop') {
            try {
                await supervisor.stopWorker(true);
                writeJson(res, 200, {
                    success: true,
                    message: 'Worker stopped',
                    worker: supervisor.getStatus().worker,
                });
            } catch (error) {
                writeJson(res, 503, {
                    success: false,
                    message: error.message,
                    worker: supervisor.getStatus().worker,
                });
            }
            return;
        }

        if (method === 'POST' && pathname === '/master/start') {
            try {
                await supervisor.startWorker();
                await supervisor.awaitWorkerReady?.();
                writeJson(res, 200, {
                    success: true,
                    message: 'Worker started',
                    worker: supervisor.getStatus().worker,
                });
            } catch (error) {
                writeJson(res, 503, {
                    success: false,
                    message: error.message,
                    worker: supervisor.getStatus().worker,
                });
            }
            return;
        }

        writeJson(res, 404, { error: 'Not Found' });
    });

    if (port != null) {
        server.listen(port, () => {
            logger.info(`[Master] Management server listening on port ${port}`);
            logger.info('[Master] Available endpoints:');
            logger.info('  GET  /master/status  - Get master and worker status');
            logger.info('  GET  /master/health  - Health check');
            logger.info('  POST /master/restart - Restart worker process');
            logger.info('  POST /master/stop    - Stop worker process');
            logger.info('  POST /master/start   - Start worker process');
        });
    }

    return server;
}

export function setupSignalHandlers({ supervisor, server }) {
    const shutdown = async (signal) => {
        logger.info(`[Master] Received ${signal}, shutting down...`);
        await supervisor.stopWorker(true);
        await new Promise(resolve => server.close(resolve));
        process.exit(0);
    };

    process.on('SIGTERM', () => {
        shutdown('SIGTERM');
    });

    process.on('SIGINT', () => {
        shutdown('SIGINT');
    });

    process.on('uncaughtException', (error) => {
        logger.error('[Master] Uncaught exception:', error);

        if (isRetryableNetworkError(error)) {
            logger.warn('[Master] Network error detected, continuing operation...');
            return;
        }

        logger.error('[Master] Fatal error detected in master process');
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('[Master] Unhandled rejection at:', promise, 'reason:', reason);

        if (reason && isRetryableNetworkError(reason)) {
            logger.warn('[Master] Network error in promise rejection, continuing operation...');
        }
    });
}

export async function main() {
    const runtimeConfig = loadMasterRuntimeConfig();

    logger.info('='.repeat(50));
    logger.info('[Master] AIClient2API Master Process');
    logger.info('[Master] PID:', process.pid);
    logger.info('[Master] Node version:', process.version);
    logger.info('[Master] Working directory:', process.cwd());
    logger.info('='.repeat(50));

    const supervisor = createSupervisor(runtimeConfig);
    const server = createMasterServer({
        supervisor,
        port: runtimeConfig.masterPort,
    });

    setupSignalHandlers({ supervisor, server });
    await supervisor.startWorker();

    return { runtimeConfig, supervisor, server };
}

const isDirectExecution = (() => {
    if (!process.argv[1]) {
        return false;
    }

    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
})();

if (isDirectExecution) {
    main().catch(error => {
        logger.error('[Master] Failed to start:', error);
        process.exit(1);
    });
}
