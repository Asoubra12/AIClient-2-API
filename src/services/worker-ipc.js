import logger from '../utils/logger.js';

export function createWorkerMessageHandler({ sendToMaster, gracefulShutdown, getRuntimeStats } = {}) {
    return (message) => {
        if (!message || !message.type) {
            return;
        }

        logger.info('[Worker] Received message from master:', message.type);

        switch (message.type) {
            case 'shutdown':
                logger.info('[Worker] Shutdown requested by master');
                gracefulShutdown?.();
                break;
            case 'status':
                sendToMaster?.({
                    type: 'status',
                    data: {
                        pid: process.pid,
                        uptime: process.uptime(),
                        memoryUsage: process.memoryUsage(),
                    },
                });
                break;
            case 'heartbeat_ping': {
                const stats = getRuntimeStats?.() || {};
                sendToMaster?.({
                    type: 'heartbeat_pong',
                    memory: stats.memory || process.memoryUsage(),
                    cpu: stats.cpu || process.cpuUsage(),
                    requestCount: stats.requestCount || 0,
                });
                break;
            }
            default:
                logger.info('[Worker] Unknown message type:', message.type);
        }
    };
}
