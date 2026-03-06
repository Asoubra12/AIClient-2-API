import { getDb } from './sqlite.js';
import logger from '../utils/logger.js';

let _stmts = null;
let _db = null;

function stmts() {
  const db = getDb();
  if (!db) {
    throw new Error('Proxy lease store is unavailable');
  }
  if (_stmts && _db === db) return _stmts;
  _db = db;
  _stmts = {
    upsert: db.prepare(`
      INSERT INTO proxy_leases (
        provider_uuid,
        subuser_id,
        proxy_url,
        protocol,
        session_type,
        lease_state,
        last_generated_at,
        last_validated_at,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
      ON CONFLICT(provider_uuid) DO UPDATE SET
        subuser_id = excluded.subuser_id,
        proxy_url = excluded.proxy_url,
        protocol = excluded.protocol,
        session_type = excluded.session_type,
        lease_state = excluded.lease_state,
        last_generated_at = datetime('now'),
        last_validated_at = excluded.last_validated_at,
        last_error = excluded.last_error
    `),
    get: db.prepare(`SELECT * FROM proxy_leases WHERE provider_uuid = ?`),
    markError: db.prepare(`
      UPDATE proxy_leases
      SET lease_state = 'error',
          last_error = ?
      WHERE provider_uuid = ?
    `),
  };
  return _stmts;
}

export function saveProxyLease(lease = {}) {
  try {
    return stmts().upsert.run(
      lease.providerUuid,
      lease.subuserId,
      lease.proxyUrl,
      lease.protocol,
      lease.sessionType,
      lease.leaseState || 'ready',
      lease.lastValidatedAt ?? null,
      lease.lastError ?? null
    );
  } catch (err) {
    logger.debug('[ProxyLeaseStore] save failed:', err.message);
    throw err;
  }
}

export function getProxyLease(providerUuid) {
  try {
    return stmts().get.get(providerUuid) || null;
  } catch (err) {
    logger.debug('[ProxyLeaseStore] get failed:', err.message);
    throw err;
  }
}

export function markProxyLeaseError(providerUuid, message) {
  try {
    return stmts().markError.run(message, providerUuid);
  } catch (err) {
    logger.debug('[ProxyLeaseStore] markError failed:', err.message);
    throw err;
  }
}

export const proxyLeaseStore = {
  saveProxyLease,
  getProxyLease,
  markProxyLeaseError,
};
