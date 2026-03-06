import * as fs from 'fs';
import { SimpleForkLauncher } from './simple-fork-launcher.js';

export class DockerAwareLauncher extends SimpleForkLauncher {
  constructor(options = {}) {
    super(options);
    this.name = 'docker';
    this.platform = options.platform || process.platform;
    this.processPid = options.processPid || process.pid;
    this.processOn = options.processOn || process.on.bind(process);
    this.processOff = options.processOff || process.off.bind(process);
    this.fileExistsFn = options.fileExistsFn || (filePath => fs.existsSync(filePath));
    this.readFileFn = options.readFileFn || (filePath => fs.promises.readFile(filePath, 'utf8'));
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.waitpidModule = options.waitpidModule || null;
    this.loadWaitpidModule = options.loadWaitpidModule || (() => import('waitpid2'));
    this.waitpidModulePromise = null;
    this.customReapFn = options.reapFn || null;
    this.reapFn = this.customReapFn || (() => {});
    this.reaperTimer = null;
    this.signalHandlers = new Map();
  }

  async isAvailable() {
    if (this.platform !== 'linux') {
      return false;
    }

    let runningInContainer = false;
    if (this.fileExistsFn('/.dockerenv')) {
      runningInContainer = true;
    } else {
      try {
        const cgroup = await this.readFileFn('/proc/1/cgroup');
        runningInContainer = /(docker|containerd|kubepods|podman)/i.test(cgroup);
      } catch {
        runningInContainer = false;
      }
    }

    if (!runningInContainer) {
      return false;
    }

    if (this.processPid === 1) {
      await this._ensureWaitpidModule();
      if (!this.customReapFn && typeof this.waitpidModule?.waitpid !== 'function') {
        this._log('warn', 'Docker launcher requires waitpid support when running as PID 1');
        return false;
      }
    }

    return true;
  }

  _attachSignalForwarding(worker) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handler = () => {
        worker?.kill?.(signal);
      };

      this.signalHandlers.set(signal, handler);
      this.processOn(signal, handler);
    }
  }

  _detachSignalForwarding() {
    for (const [signal, handler] of this.signalHandlers.entries()) {
      this.processOff(signal, handler);
    }
    this.signalHandlers.clear();
  }

  _startReaper() {
    if (this.reaperTimer) {
      return;
    }

    this.reaperTimer = this.setIntervalFn(() => {
      try {
        this.reapFn();
      } catch (error) {
        this._log('debug', `Zombie reaper failed: ${error.message}`);
      }
    }, 10000);
    this.reaperTimer.unref?.();
  }

  _stopReaper() {
    if (!this.reaperTimer) {
      return;
    }

    this.clearIntervalFn(this.reaperTimer);
    this.reaperTimer = null;
  }

  _cleanupWorkerRuntime() {
    this._stopReaper();
    this._detachSignalForwarding();
  }

  async launchWorker(options) {
    await this._ensureWaitpidModule();
    if (this.processPid === 1 && !this.customReapFn && typeof this.waitpidModule?.waitpid !== 'function') {
      throw new Error('Docker launcher requires waitpid support when running as PID 1');
    }

    if (!this.customReapFn) {
      this.reapFn = this._createWaitpidReaper();
    }

    const worker = await super.launchWorker(options);

    if (this.processPid === 1) {
      this._log('warn', 'Running as PID 1 in a container. Install tini or dumb-init for reliable signal handling.');
      this._attachSignalForwarding(worker);
      this._startReaper();
    }

    return worker;
  }

  async shutdownWorker(worker, graceful = true) {
    this._cleanupWorkerRuntime();
    return super.shutdownWorker(worker, graceful);
  }

  handleWorkerExit() {
    this._cleanupWorkerRuntime();
  }

  async _ensureWaitpidModule() {
    if (this.waitpidModule) {
      return this.waitpidModule;
    }

    if (!this.waitpidModulePromise) {
      this.waitpidModulePromise = Promise.resolve()
        .then(() => this.loadWaitpidModule())
        .then((moduleExports) => {
          this.waitpidModule = moduleExports?.default || moduleExports;
          return this.waitpidModule;
        })
        .catch(() => null);
    }

    return this.waitpidModulePromise;
  }

  _createWaitpidReaper() {
    if (typeof this.waitpidModule?.waitpid !== 'function') {
      return () => {};
    }

    return () => {
      while (true) {
        const result = this.waitpidModule.waitpid(-1, this.waitpidModule.WNOHANG);
        const pid = Number(result?.return);
        if (!Number.isFinite(pid) || pid <= 0) {
          break;
        }
      }
    };
  }
}
