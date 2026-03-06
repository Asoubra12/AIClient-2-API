import { getDb } from './sqlite.js';
import logger from '../utils/logger.js';

let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;
  const db = getDb();
  if (!db) return null;
  _stmts = {
    upsert: db.prepare(`
      INSERT INTO quota_state (account_email, model_name, remaining_fraction, local_estimate, reset_time, last_refreshed)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_email, model_name) DO UPDATE SET
        remaining_fraction = excluded.remaining_fraction,
        local_estimate = excluded.remaining_fraction,
        reset_time = excluded.reset_time,
        last_refreshed = datetime('now')
    `),
    get: db.prepare(`SELECT * FROM quota_state WHERE account_email = ? AND model_name = ?`),
    getByAccount: db.prepare(`SELECT * FROM quota_state WHERE account_email = ?`),
    getBestAccount: db.prepare(`
      SELECT account_email, remaining_fraction, local_estimate, reset_time
      FROM quota_state
      WHERE model_name = ? AND local_estimate > 0
      ORDER BY local_estimate DESC
      LIMIT 1
    `),
    decrementLocal: db.prepare(`
      UPDATE quota_state SET local_estimate = MAX(0, local_estimate - ?)
      WHERE account_email = ? AND model_name = ?
    `),
    incrementLocal: db.prepare(`
      UPDATE quota_state SET local_estimate = MIN(1, local_estimate + ?)
      WHERE account_email = ? AND model_name = ?
    `),
    getAll: db.prepare(`SELECT * FROM quota_state ORDER BY account_email, model_name`),
  };
  return _stmts;
}

export function upsertQuota(accountEmail, modelName, remainingFraction, resetTime) {
  try {
    stmts()?.upsert.run(accountEmail, modelName, remainingFraction, remainingFraction, resetTime);
  } catch (err) {
    logger.debug('[QuotaStore] upsert failed:', err.message);
  }
}

export function getQuota(accountEmail, modelName) {
  try {
    return stmts()?.get.get(accountEmail, modelName) || null;
  } catch (err) {
    logger.debug('[QuotaStore] get failed:', err.message);
    return null;
  }
}

export function getQuotasByAccount(accountEmail) {
  try {
    return stmts()?.getByAccount.all(accountEmail) || [];
  } catch (err) {
    logger.debug('[QuotaStore] getByAccount failed:', err.message);
    return [];
  }
}

export function getBestAccountForModel(modelName) {
  try {
    return stmts()?.getBestAccount.get(modelName) || null;
  } catch (err) {
    logger.debug('[QuotaStore] getBestAccount failed:', err.message);
    return null;
  }
}

export function decrementLocalEstimate(accountEmail, modelName, amount = 0.01) {
  try {
    stmts()?.decrementLocal.run(amount, accountEmail, modelName);
  } catch (err) {
    logger.debug('[QuotaStore] decrementLocal failed:', err.message);
  }
}

export function incrementLocalEstimate(accountEmail, modelName, amount = 0.01) {
  try {
    stmts()?.incrementLocal.run(amount, accountEmail, modelName);
  } catch (err) {
    logger.debug('[QuotaStore] incrementLocal failed:', err.message);
  }
}

export function getAllQuotas() {
  try {
    return stmts()?.getAll.all() || [];
  } catch (err) {
    logger.debug('[QuotaStore] getAll failed:', err.message);
    return [];
  }
}
