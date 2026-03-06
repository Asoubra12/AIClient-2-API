/**
 * Base class for Antigravity middleware hooks.
 * Pre-hooks run before generation, post-hooks run after.
 */
export class AntigravityHook {
  /** @returns {string} Hook name for logging */
  get name() { throw new Error('Subclass must implement name getter'); }

  /** @returns {'pre'|'post'} Hook type */
  get type() { throw new Error('Subclass must implement type getter'); }

  /**
   * Execute the hook.
   * @param {Object} context - Request context
   * @param {Object} context.config - Server config (deep copy)
   * @param {Object} context.requestBody - Processed request body
   * @param {string} context.model - Model name
   * @param {string} context.provider - Provider type (e.g., 'gemini-antigravity')
   * @param {string} context.accountEmail - Account identifier
   * @param {string} context.uuid - Account UUID
   * @param {Object} [context.options] - Request-scoped options (e.g., preSelectedUuid)
   * @param {Object} [context.response] - Generation response (post-hooks only)
   * @param {Object} [context.timing] - Timing data (post-hooks only)
   * @returns {Promise<Object|void>} Optional modifications to context
   */
  async execute(context) {
    throw new Error('Subclass must implement execute()');
  }
}
