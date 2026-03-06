import crypto from 'crypto';
import { AntigravityHook } from './hook-base.js';
import logger from '../../utils/logger.js';

/**
 * SessionIdHook — generates a stable sessionId from the hash of
 * the system prompt + first user message. This matches real Antigravity behavior
 * where sessionId = negative int64 from SHA-256 of first user message.
 *
 * The existing generateStableSessionID() in antigravity-core.js already does this,
 * but this hook makes it available as a pipeline pre-hook so the sessionId is
 * set in the context before generation, available to telemetry post-hooks.
 */
export class SessionIdHook extends AntigravityHook {
  get name() { return 'SessionIdHook'; }
  get type() { return 'pre'; }
  get priority() { return 300; }

  async execute(context) {
    const { requestBody } = context;
    const sessionId = generateStableSessionId(requestBody);
    if (sessionId) {
      logger.debug(`[SessionIdHook] Generated sessionId: ${sessionId}`);
      return { sessionId };
    }
    return null;
  }
}

/**
 * Generate a stable session ID from the first user message content.
 * Matches the real Antigravity client: SHA-256 of first user text → negative int64 string.
 * @param {Object} payload - Request body (Antigravity format or Gemini format)
 * @returns {string|null} Session ID like "-1234567890123456789"
 */
function generateStableSessionId(payload) {
  try {
    // Antigravity format: payload.request.contents[].role === 'user'
    const contents = payload?.request?.contents || payload?.contents;
    if (!Array.isArray(contents)) return null;

    for (const content of contents) {
      if (content.role === 'user') {
        const text = content.parts?.[0]?.text;
        if (text) {
          const hash = crypto.createHash('sha256').update(text).digest();
          const n = hash.readBigUInt64BE(0) & BigInt('0x7FFFFFFFFFFFFFFF');
          return '-' + n.toString();
        }
      }
    }
  } catch (_) {
    // Fall through
  }
  return null;
}

export { generateStableSessionId };
