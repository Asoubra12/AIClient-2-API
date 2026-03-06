import logger from '../../utils/logger.js';

const ANTIGRAVITY_PROVIDER = 'gemini-antigravity';

function getHookPriority(hook) {
  return Number.isFinite(hook?.priority) ? hook.priority : 100;
}

class AntigravityPipeline {
  constructor() {
    /** @type {import('./hook-base.js').AntigravityHook[]} */
    this.preHooks = [];
    /** @type {import('./hook-base.js').AntigravityHook[]} */
    this.postHooks = [];
    this._initialized = false;
  }

  /**
   * Register a hook into the pipeline.
   * @param {import('./hook-base.js').AntigravityHook} hook
   */
  register(hook) {
    if (hook.type === 'pre') {
      this.preHooks.push(hook);
      this.preHooks.sort((a, b) => getHookPriority(a) - getHookPriority(b));
      logger.info(`[AntigravityPipeline] Registered pre-hook: ${hook.name}`);
    } else if (hook.type === 'post') {
      this.postHooks.push(hook);
      this.postHooks.sort((a, b) => getHookPriority(a) - getHookPriority(b));
      logger.info(`[AntigravityPipeline] Registered post-hook: ${hook.name}`);
    } else {
      logger.warn(`[AntigravityPipeline] Unknown hook type "${hook.type}" for ${hook.name}`);
    }
  }

  /**
   * Check if a provider type is Antigravity.
   * @param {string} providerType
   * @returns {boolean}
   */
  isAntigravity(providerType) {
    return providerType === ANTIGRAVITY_PROVIDER;
  }

  /**
   * Run all pre-hooks before generation.
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Modified context
   */
  async runPreHooks(context) {
    if (!this.isAntigravity(context.provider)) return context;

    for (const hook of this.preHooks) {
      try {
        const result = await hook.execute(context);
        if (result) {
          Object.assign(context, result);
        }
      } catch (err) {
        logger.warn(`[AntigravityPipeline] Pre-hook "${hook.name}" failed:`, err.message);
      }
    }
    return context;
  }

  /**
   * Run all post-hooks after generation (fire-and-forget).
   * @param {Object} context - Request context with response data
   */
  runPostHooks(context) {
    if (!this.isAntigravity(context.provider)) return;

    for (const hook of this.postHooks) {
      try {
        hook.execute(context).catch(err => {
          logger.debug(`[AntigravityPipeline] Post-hook "${hook.name}" failed:`, err.message);
        });
      } catch (err) {
        logger.debug(`[AntigravityPipeline] Post-hook "${hook.name}" sync error:`, err.message);
      }
    }
  }

  /**
   * Initialize the pipeline with all hooks.
   * Called once at startup.
   */
  async initialize() {
    if (this._initialized) return;

    try {
      const { QuotaSelectHook } = await import('./quota-select.js');
      this.register(new QuotaSelectHook());
    } catch (err) {
      logger.warn('[AntigravityPipeline] Failed to load QuotaSelectHook:', err.message);
    }

    try {
      const { ChainSetupHook } = await import('./chain-setup.js');
      this.register(new ChainSetupHook());
    } catch (err) {
      logger.warn('[AntigravityPipeline] Failed to load ChainSetupHook:', err.message);
    }

    try {
      const { SessionIdHook } = await import('./session-id.js');
      this.register(new SessionIdHook());
    } catch (err) {
      logger.warn('[AntigravityPipeline] Failed to load SessionIdHook:', err.message);
    }

    try {
      const { MetricsHook } = await import('./metrics-post.js');
      this.register(new MetricsHook());
    } catch (err) {
      logger.warn('[AntigravityPipeline] Failed to load MetricsHook:', err.message);
    }

    try {
      const { TrajectoryHook } = await import('./trajectory-post.js');
      this.register(new TrajectoryHook());
    } catch (err) {
      logger.warn('[AntigravityPipeline] Failed to load TrajectoryHook:', err.message);
    }

    this._initialized = true;
    logger.info(`[AntigravityPipeline] Initialized with ${this.preHooks.length} pre-hooks, ${this.postHooks.length} post-hooks`);
  }
}

const pipeline = new AntigravityPipeline();
export default pipeline;
export { ANTIGRAVITY_PROVIDER };
