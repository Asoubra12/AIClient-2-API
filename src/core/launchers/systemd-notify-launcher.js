import { SimpleForkLauncher } from './simple-fork-launcher.js';

export class SystemdNotifyLauncher extends SimpleForkLauncher {
  constructor(options = {}) {
    super(options);
    this.name = 'systemd';
    this.platform = options.platform || process.platform;
    this.processEnv = options.processEnv || process.env;
    this.sdNotifyModule = options.sdNotifyModule || null;
    this.unixSocketModule = options.unixSocketModule || null;
    this.loadSdNotifyModule = options.loadSdNotifyModule || (() => import('sd-notify'));
    this.loadUnixSocketModule = options.loadUnixSocketModule || (() => import('node-unix-socket'));
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.notifier = null;
    this.notifierPromise = null;
    this.watchdogTimer = null;
  }

  async isAvailable() {
    if (this.platform !== 'linux' || !this.processEnv.NOTIFY_SOCKET) {
      return false;
    }

    const notifier = await this._ensureNotifier();
    return Boolean(notifier);
  }

  _createUnixSocketNotifier(unixSocketModule) {
    const notifySocket = this.processEnv.NOTIFY_SOCKET;
    const DgramSocket = unixSocketModule?.DgramSocket ||
      unixSocketModule?.default?.DgramSocket ||
      unixSocketModule?.default;

    if (typeof DgramSocket !== 'function') {
      throw new Error('node-unix-socket DgramSocket is unavailable');
    }

    const socket = new DgramSocket();

    const sendDatagram = (state) => {
      const payload = Buffer.from(`${state.trim()}\n`, 'utf8');
      if (typeof socket.sendTo === 'function') {
        socket.sendTo(payload, 0, payload.length, notifySocket);
        return;
      }

      if (typeof socket.send === 'function') {
        socket.send(payload, notifySocket);
        return;
      }

      throw new Error('node-unix-socket does not expose a datagram send method');
    };

    return {
      ready: () => sendDatagram('READY=1'),
      sendState: (state) => sendDatagram(state),
      watchdog: () => sendDatagram('WATCHDOG=1'),
      close: () => socket.close?.(),
    };
  }

  async _ensureNotifier() {
    if (this.notifier) {
      return this.notifier;
    }

    if (this.sdNotifyModule) {
      this.notifier = this.sdNotifyModule;
      return this.notifier;
    }

    if (!this.notifierPromise) {
      this.notifierPromise = Promise.resolve()
        .then(() => this.loadSdNotifyModule())
        .then((moduleExports) => {
          this.notifier = moduleExports?.default || moduleExports;
          return this.notifier;
        })
        .catch(async (error) => {
          this._log('debug', `sd-notify unavailable, trying Unix socket fallback: ${error.message}`);
          const unixSocketExports = this.unixSocketModule || await this.loadUnixSocketModule();
          this.notifier = this._createUnixSocketNotifier(unixSocketExports);
          return this.notifier;
        })
        .catch((error) => {
          this._log('warn', `Systemd notify integration unavailable: ${error.message}`);
          this.notifier = null;
          return null;
        });
    }

    return this.notifierPromise;
  }

  _getNotifier() {
    return this.notifier;
  }

  _notify(state) {
    try {
      const notifier = this._getNotifier();
      if (!notifier) {
        return;
      }

      if (state === 'READY=1') {
        notifier.ready?.();
        return;
      }

      if (state === 'WATCHDOG=1') {
        notifier.watchdog?.();
        return;
      }

      notifier.sendState?.(`${state}\n`);
    } catch (error) {
      this._log('warn', `Failed to send ${state} notification: ${error.message}`);
    }
  }

  notifyReady() {
    this._notify('READY=1');
  }

  notifyStopping() {
    this._notify('STOPPING=1');
  }

  _resolveWatchdogIntervalMs(intervalMs) {
    const notifier = this._getNotifier();
    const moduleIntervalMs = Number(notifier?.watchdogInterval?.());
    if (Number.isFinite(moduleIntervalMs) && moduleIntervalMs > 0) {
      return Math.max(1000, Math.floor(moduleIntervalMs / 2));
    }

    const watchdogUsec = Number(this.processEnv.WATCHDOG_USEC);
    if (Number.isFinite(watchdogUsec) && watchdogUsec > 0) {
      return Math.max(1000, Math.floor(watchdogUsec / 2000));
    }

    return intervalMs;
  }

  startWatchdog(intervalMs) {
    this._clearWatchdogTimer();
    const resolvedIntervalMs = this._resolveWatchdogIntervalMs(intervalMs);
    if (!resolvedIntervalMs || resolvedIntervalMs <= 0) {
      return;
    }

    this.watchdogTimer = this.setIntervalFn(() => {
      this._notify('WATCHDOG=1');
    }, resolvedIntervalMs);
    this.watchdogTimer.unref?.();
  }

  _clearWatchdogTimer() {
    if (this.watchdogTimer) {
      this.clearIntervalFn(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  stopWatchdog() {
    this._clearWatchdogTimer();

    this.notifier?.close?.();
    this.notifier = null;
    this.notifierPromise = null;
  }
}
