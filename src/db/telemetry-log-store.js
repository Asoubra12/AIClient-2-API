import logger from '../utils/logger.js';
import { cleanupOldTelemetry, getDb } from './sqlite.js';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 7;

let cleanupTimer = null;

function normalizeEntry(entry = {}) {
  return {
    accountEmail: entry.accountEmail || 'unknown-account',
    requestId: entry.requestId || 'unknown-request',
    model: entry.model || 'unknown-model',
  };
}

function run(statementFactory, values) {
  const db = getDb();
  if (!db) {
    return;
  }

  try {
    statementFactory(db).run(...values);
  } catch (error) {
    logger.debug(`[TelemetryLogStore] SQLite write failed: ${error.message}`);
  }
}

export function scheduleCleanup(intervalMs = CLEANUP_INTERVAL_MS, retentionDays = RETENTION_DAYS) {
  if (cleanupTimer) {
    return cleanupTimer;
  }

  cleanupTimer = setInterval(() => {
    cleanupOldTelemetry(retentionDays);
  }, intervalMs);
  cleanupTimer.unref?.();

  return cleanupTimer;
}

export function stopCleanupSchedule() {
  if (!cleanupTimer) {
    return;
  }

  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

export function ensureRequestLog(entry) {
  const normalized = normalizeEntry(entry);
  run(
    db => db.prepare(`
      INSERT INTO telemetry_log (account_email, request_id, model, metrics_sent, trajectory_sent)
      SELECT ?, ?, ?, 0, 0
      WHERE NOT EXISTS (
        SELECT 1 FROM telemetry_log
        WHERE account_email = ? AND request_id = ? AND model = ?
      )
    `),
    [
      normalized.accountEmail,
      normalized.requestId,
      normalized.model,
      normalized.accountEmail,
      normalized.requestId,
      normalized.model,
    ]
  );
}

export function markMetricsSent(entry) {
  const normalized = normalizeEntry(entry);
  run(
    db => db.prepare(`
      UPDATE telemetry_log
      SET metrics_sent = 1
      WHERE account_email = ? AND request_id = ? AND model = ?
    `),
    [normalized.accountEmail, normalized.requestId, normalized.model]
  );
}

export function markTrajectorySent(entry) {
  const normalized = normalizeEntry(entry);
  run(
    db => db.prepare(`
      UPDATE telemetry_log
      SET trajectory_sent = 1
      WHERE account_email = ? AND request_id = ? AND model = ?
    `),
    [normalized.accountEmail, normalized.requestId, normalized.model]
  );
}

export const telemetryLogStore = {
  ensureRequestLog,
  markMetricsSent,
  markTrajectorySent,
  scheduleCleanup,
  stopCleanupSchedule,
};
