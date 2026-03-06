import { spawn, spawnSync } from 'child_process';
import { LauncherBase } from './launcher-base.js';

export class NamespaceLauncher extends LauncherBase {
  constructor(options = {}) {
    super('namespace', options);
    this.platform = options.platform || process.platform;
    this.execPath = options.execPath || process.execPath;
    this.shellPath = options.shellPath || '/bin/sh';
    this.spawnFn = options.spawnFn || spawn;
    this.spawnSyncFn = options.spawnSyncFn || spawnSync;
    this.probeFn = options.probeFn || null;
    this.tmpMountCommand = options.tmpMountCommand || 'mount -t tmpfs tmpfs /tmp';
  }

  async isAvailable() {
    if (this.platform !== 'linux') {
      return false;
    }

    if (this.probeFn) {
      return Boolean(await this.probeFn());
    }

    try {
      const result = this.spawnSyncFn('unshare', ['--user', 'true'], { stdio: 'ignore' });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  async launchWorker({ workerScript, args = [], env = {} }) {
    const shellCommand = `${this.tmpMountCommand} && exec "$0" "$@"`;

    return this.spawnFn('unshare', [
      '--user',
      '--map-root-user',
      '--fork',
      '--pid',
      '--mount',
      '--mount-proc',
      this.shellPath,
      '-lc',
      shellCommand,
      this.execPath,
      workerScript,
      ...args,
    ], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env,
    });
  }
}
