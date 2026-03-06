import { getDb } from './sqlite.js';
import logger from '../utils/logger.js';

let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;
  const db = getDb();
  if (!db) return null;
  _stmts = {
    upsert: db.prepare(`
      INSERT INTO account_fingerprints (account_email, fingerprint_json)
      VALUES (?, ?)
      ON CONFLICT(account_email) DO UPDATE SET fingerprint_json = excluded.fingerprint_json
    `),
    get: db.prepare(`SELECT * FROM account_fingerprints WHERE account_email = ?`),
    delete: db.prepare(`DELETE FROM account_fingerprints WHERE account_email = ?`),
    getAll: db.prepare(`SELECT * FROM account_fingerprints`),
  };
  return _stmts;
}

export function saveFingerprint(accountEmail, fingerprint) {
  try {
    const json = typeof fingerprint === 'string' ? fingerprint : JSON.stringify(fingerprint);
    stmts()?.upsert.run(accountEmail, json);
  } catch (err) {
    logger.debug('[FingerprintStore] save failed:', err.message);
  }
}

export function getFingerprint(accountEmail) {
  try {
    const row = stmts()?.get.get(accountEmail);
    if (!row) return null;
    return JSON.parse(row.fingerprint_json);
  } catch (err) {
    logger.debug('[FingerprintStore] get failed:', err.message);
    return null;
  }
}

export function deleteFingerprint(accountEmail) {
  try {
    stmts()?.delete.run(accountEmail);
  } catch (err) {
    logger.debug('[FingerprintStore] delete failed:', err.message);
  }
}

export function getAllFingerprints() {
  try {
    const rows = stmts()?.getAll.all() || [];
    return rows.map(r => ({
      account_email: r.account_email,
      fingerprint: JSON.parse(r.fingerprint_json),
      created_at: r.created_at,
    }));
  } catch (err) {
    logger.debug('[FingerprintStore] getAll failed:', err.message);
    return [];
  }
}
