import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
export const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
export const now = () => Date.now();

db.exec(`
CREATE TABLE IF NOT EXISTS servers(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, api_key TEXT UNIQUE, is_local INTEGER DEFAULT 0, last_seen INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS metrics(id INTEGER PRIMARY KEY, server_id INTEGER, cpu REAL, mem REAL, disk REAL, load REAL, uptime INTEGER, net_in REAL, net_out REAL, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_metrics ON metrics(server_id, created_at);
CREATE TABLE IF NOT EXISTS monitors(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER DEFAULT 1, config TEXT DEFAULT '{}', secret TEXT, server_id INTEGER DEFAULT 1, last_ok INTEGER, last_ms INTEGER, last_check INTEGER, last_detail TEXT, down_since INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, monitor_id INTEGER, ok INTEGER, ms INTEGER, detail TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_checks ON checks(monitor_id, created_at);
CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY, monitor_id INTEGER, server_id INTEGER, kind TEXT, title TEXT, detail TEXT, logs TEXT, ai TEXT, started_at INTEGER, resolved_at INTEGER, state TEXT DEFAULT 'open');
CREATE INDEX IF NOT EXISTS idx_inc ON incidents(monitor_id, started_at);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS restart_log(id INTEGER PRIMARY KEY, monitor_id INTEGER, incident_id INTEGER, command TEXT, attempt INTEGER, ok INTEGER, exit_code INTEGER, output TEXT, result TEXT, started_at INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_restart ON restart_log(monitor_id, started_at);
CREATE TABLE IF NOT EXISTS backup_history(id INTEGER PRIMARY KEY, monitor_id INTEGER, file TEXT, size INTEGER, mtime INTEGER, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_bak ON backup_history(monitor_id, created_at);
CREATE TABLE IF NOT EXISTS sec_event(id INTEGER PRIMARY KEY, kind TEXT, ip TEXT, user TEXT, detail TEXT, count INTEGER DEFAULT 1, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sec ON sec_event(kind, created_at);
CREATE TABLE IF NOT EXISTS sec_known_ip(ip TEXT PRIMARY KEY, user TEXT, first_seen INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS sec_port(proto TEXT, addr TEXT, port TEXT, first_seen INTEGER, last_seen INTEGER, state TEXT DEFAULT 'open');
CREATE UNIQUE INDEX IF NOT EXISTS uq_port ON sec_port(proto, addr, port);
CREATE TABLE IF NOT EXISTS push_sub(endpoint TEXT PRIMARY KEY, keys TEXT, created_at INTEGER, sent_at INTEGER, last_error TEXT);
`);

if (!db.prepare('SELECT COUNT(*) n FROM servers').get().n) {
  db.prepare('INSERT INTO servers(name, api_key, is_local, last_seen, created_at) VALUES(?,?,1,?,?)')
    .run('localhost', crypto.randomBytes(16).toString('hex'), now(), now());
}
export const localServerId = db.prepare('SELECT id FROM servers WHERE is_local=1').get().id;

cfg.agentKeys.forEach((entry, i) => {
  const at = entry.indexOf(':');
  const name = at > 0 ? entry.slice(0, at) : `agent-${i + 1}`;
  const key = at > 0 ? entry.slice(at + 1) : entry;
  if (key) db.prepare('INSERT OR IGNORE INTO servers(name, api_key, created_at) VALUES(?,?,?)').run(name, key, now());
});

export const q = (sql, ...args) => db.prepare(sql).all(...args);
export const get = (sql, ...args) => db.prepare(sql).get(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);
export const servers = () => q('SELECT * FROM servers ORDER BY id');
export const serverName = (id) => get('SELECT name FROM servers WHERE id=?', id)?.name || `server ${id}`;
export const monitors = (onlyEnabled = false) => q(`SELECT * FROM monitors ${onlyEnabled ? 'WHERE enabled=1' : ''} ORDER BY name`);
export const monitor = (id) => get('SELECT * FROM monitors WHERE id=?', Number(id));
export const monitorConfig = (m) => { try { return JSON.parse(m.config || '{}'); } catch { return {}; } };
export const incident = (id) => get('SELECT * FROM incidents WHERE id=?', Number(id));
export const openIncidents = () => q('SELECT * FROM incidents WHERE state=? ORDER BY started_at DESC', 'open');
export const setting = (k, d) => get('SELECT value FROM settings WHERE key=?', k)?.value ?? d;
export const setSetting = (k, v) => run('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));

export const addCheck = (id, ok, ms, detail) =>
  run('INSERT INTO checks(monitor_id, ok, ms, detail, created_at) VALUES(?,?,?,?,?)', id, ok ? 1 : 0, ms, String(detail || '').slice(0, 400), now());

export function updateMonitorAfterCheck(m, ok, ms, detail, touchLast = true) {
  run('UPDATE monitors SET last_ok=?, last_ms=?, last_detail=?, down_since=?, last_check=? WHERE id=?',
    ok ? 1 : 0, ms, String(detail || '').slice(0, 400), ok ? null : m.down_since || now(), touchLast ? now() : m.last_check, m.id);
}

export function openIncident(m, kind, title, detail, logs = '') {
  const r = run('INSERT INTO incidents(monitor_id, server_id, kind, title, detail, logs, started_at, state) VALUES(?,?,?,?,?,?,?,?)',
    m.id, m.server_id || localServerId, kind, title, String(detail || '').slice(0, 2000), logs, now(), 'open');
  return get('SELECT * FROM incidents WHERE id=?', r.lastInsertRowid);
}

/** Close the newest open incident of this kind, if the monitor had one. */
export function resolveIncident(m, kind, detail) {
  const inc = get('SELECT * FROM incidents WHERE monitor_id=? AND kind=? AND state=? ORDER BY id DESC LIMIT 1', m?.id ?? 0, kind, 'open');
  if (!inc) return null;
  run('UPDATE incidents SET resolved_at=?, state=?, detail=? WHERE id=?', now(), 'resolved', detail || inc.detail, inc.id);
  return get('SELECT * FROM incidents WHERE id=?', inc.id);
}

export function prune() {
  const cutoff = now() - cfg.retentionDays * 864e5;
  run('DELETE FROM checks WHERE created_at < ?', cutoff);
  run('DELETE FROM incidents WHERE state=? AND resolved_at < ?', 'resolved', cutoff);
  run('DELETE FROM metrics WHERE created_at < ?', cutoff);
  run('DELETE FROM restart_log WHERE started_at < ?', cutoff);
  run('DELETE FROM backup_history WHERE created_at < ?', cutoff);
  run('DELETE FROM sec_event WHERE created_at < ?', cutoff);
}
setInterval(prune, 3600e3).unref();
