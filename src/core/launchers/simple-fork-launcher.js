import { fork } from 'child_process';
import { LauncherBase } from './launcher-base.js';

export class SimpleForkLauncher extends LauncherBase {
    constructor(options = {}) {
        super('fork', options);
        this.forkFn = options.forkFn || fork;
    }

    async isAvailable() {
        return true;
    }

    async launchWorker({ workerScript, args = [], env = {} }) {
        return this.forkFn(workerScript, args, {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env,
        });
    }
}
