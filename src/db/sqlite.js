import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger.js';

const DEFAULT_DB_PATH = path.resolve('configs', 'antigravity.db');

let db = null;
let dbPath = null;

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_fingerprints (
  account_email TEXT PRIMARY KEY,
  fingerprint_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quota_state (
  account_email TEXT NOT NULL,
  model_name TEXT NOT NULL,
  remaining_fraction REAL NOT NULL DEFAULT 1.0,
  local_estimate REAL NOT NULL DEFAULT 1.0,
  reset_time TEXT,
  last_refreshed TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_email, model_name)
);

CREATE TABLE IF NOT EXISTS proxy_leases (
  provider_uuid TEXT PRIMARY KEY,
  subuser_id INTEGER NOT NULL,
  proxy_url TEXT NOT NULL,
  protocol TEXT NOT NULL,
  session_type TEXT NOT NULL,
  lease_state TEXT NOT NULL DEFAULT 'ready',
  last_generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_validated_at TEXT,
  last_error TEXT
);
`;

const TELEMETRY_LOG_SCHEMA = `
CREATE TABLE telemetry_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_email TEXT NOT NULL,
  request_id TEXT NOT NULL,
  model TEXT NOT NULL,
  metrics_sent INTEGER NOT NULL DEFAULT 0,
  trajectory_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const TELEMETRY_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_log(created_at);
`;

function resolveDbPath(customPath) {
  return path.resolve(customPath || DEFAULT_DB_PATH);
}

function ensureTelemetryLogTable(database) {
  const columns = database.prepare(`PRAGMA table_info(telemetry_log)`).all();
  if (columns.length === 0) {
    database.exec(TELEMETRY_LOG_SCHEMA);
    database.exec(TELEMETRY_INDEX_SCHEMA);
    return;
  }

  const columnMap = new Map(columns.map(column => [column.name, column]));
  const needsMigration =
    columnMap.get('account_email')?.notnull !== 1 ||
    columnMap.get('request_id')?.notnull !== 1 ||
    columnMap.get('model')?.notnull !== 1;

  if (!needsMigration) {
    database.exec(TELEMETRY_INDEX_SCHEMA);
    return;
  }

  database.transaction(() => {
    database.exec('DROP TABLE IF EXISTS telemetry_log__migrated;');
    database.exec(TELEMETRY_LOG_SCHEMA.replace('telemetry_log', 'telemetry_log__migrated'));

    const hasColumn = name => columnMap.has(name);
    const selectColumn = (name, fallbackSql) => (hasColumn(name) ? name : fallbackSql);
    database.exec(`
      INSERT INTO telemetry_log__migrated (
        id,
        account_email,
        request_id,
        model,
        metrics_sent,
        trajectory_sent,
        created_at
      )
      SELECT
        ${selectColumn('id', 'NULL')},
        COALESCE(${selectColumn('account_email', "'unknown-account'")}, 'unknown-account'),
        COALESCE(${selectColumn('request_id', "'unknown-request'")}, 'unknown-request'),
        COALESCE(${selectColumn('model', "'unknown-model'")}, 'unknown-model'),
        COALESCE(${selectColumn('metrics_sent', '0')}, 0),
        COALESCE(${selectColumn('trajectory_sent', '0')}, 0),
        COALESCE(${selectColumn('created_at', "datetime('now')")}, datetime('now'))
      FROM telemetry_log;
    `);
    database.exec('DROP TABLE telemetry_log;');
    database.exec('ALTER TABLE telemetry_log__migrated RENAME TO telemetry_log;');
    database.exec(TELEMETRY_INDEX_SCHEMA);
  })();

  logger.info('[SQLite] Migrated telemetry_log to the current schema');
}

function initializeDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.exec(CORE_SCHEMA);
  ensureTelemetryLogTable(database);
  logger.info('[SQLite] Database initialized at ' + databasePath);
  return database;
}

export function getDb(customPath) {
  const targetPath = resolveDbPath(customPath);
  if (db && dbPath === targetPath) return db;

  if (db && dbPath !== targetPath) {
    closeDb();
  }

  try {
    db = initializeDatabase(targetPath);
    dbPath = targetPath;
    return db;
  } catch (err) {
    logger.warn('[SQLite] Failed to initialize database, falling back to in-memory:', err.message);
    try {
      db = new Database(':memory:');
      db.exec(CORE_SCHEMA);
      ensureTelemetryLogTable(db);
      dbPath = ':memory:';
      return db;
    } catch (memErr) {
      logger.error('[SQLite] In-memory fallback also failed:', memErr.message);
      return null;
    }
  }
}

export function closeDb() {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (_) { /* ignore */ }
    try {
      db.close();
    } catch (_) { /* ignore */ }
    db = null;
    dbPath = null;
  }
}

export function cleanupOldTelemetry(days = 7, customPath) {
  const database = getDb(customPath);
  if (!database) return;
  try {
    database.prepare(
      `DELETE FROM telemetry_log WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(days);
  } catch (err) {
    logger.debug('[SQLite] Telemetry cleanup failed:', err.message);
  }
}
