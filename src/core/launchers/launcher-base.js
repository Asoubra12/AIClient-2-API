import logger from '../../utils/logger.js';

export class LauncherBase {
    constructor(name, options = {}) {
        this.name = name;
        this.logger = options.logger || logger;
    }

    async isAvailable() {
        return false;
    }

    async launchWorker() {
        throw new Error(`Launcher '${this.name}' must implement launchWorker()`);
    }

    async shutdownWorker(worker, graceful = true) {
        if (!worker) {
            return;
        }

        if (graceful && typeof worker.send === 'function') {
            try {
                worker.send({ type: 'shutdown' });
            } catch {
                // Ignore IPC failures during shutdown.
            }
        }

        if (typeof worker.kill === 'function') {
            worker.kill(graceful ? 'SIGTERM' : 'SIGKILL');
        }
    }

    notifyReady() {}

    notifyStopping() {}

    startWatchdog() {}

    stopWatchdog() {}

    _log(level, message) {
        if (typeof this.logger?.[level] === 'function') {
            this.logger[level](`[${this.name}] ${message}`);
        }
    }
}
