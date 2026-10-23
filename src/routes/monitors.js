import express from 'express';
import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { db, q, get, run, now, servers, monitors, monitor, monitorConfig, localServerId } from '../db.js';
import { monitorTypes, runMonitor, runAll } from '../collectors/checks.js';
import { checkCommand, whitelistInfo } from '../collectors/restart.js';
import { newSecret, pingUrl } from './agent.js';

const f = (k, label, ph = '', num = false) => ({ k, label, ph, num });
const chk = (k, label) => ({ k, label, kind: 'checkbox' });
const sel = (k, label, opts) => ({ k, label, kind: 'select', opts });
const interval = (ph = String(cfg.checkIntervalSec)) => ({ k: 'interval_sec', label: 'Check every (sec)', ph, num: true });
const LOG_FIELDS = [f('log_kind', 'Log source (journal/file/pm2)', 'journal'), f('log_target', 'Unit / file / pm2 app', 'n8n')];

/** Offered on every type — the command list comes from RESTART_ALLOW, never free text. */
const RESTART_FIELDS = () => [
  chk('auto_restart', 'Auto-restart when down'),
  sel('restart_command', 'Restart command (whitelist)', cfg.restartAllow),
  f('max_retries', 'Max attempts', String(cfg.restartRetries), true),
  f('cooldown_minutes', 'Wait between attempts (min)', String(cfg.restartCooldownMin), true),
];

export const schema = {
  http: [f('url', 'URL *', 'https://example.com/health'), f('method', 'Method', 'GET'), f('expect_status', 'Expected statuses', '200,204'), f('keyword', 'Body must contain', 'ok'), f('bearer', 'Bearer token'), f('timeout_ms', 'Timeout ms', '10000'), f('ssl', 'TLS expiry check', '1'), interval()],
  port: [f('host', 'Host', '127.0.0.1'), f('port', 'Port *', '5432'), f('timeout_ms', 'Timeout ms', '5000'), interval()],
  systemd: [f('unit', 'Unit name *', 'n8n.service'), f('expect_sub', 'Expected SubState', 'running'), ...LOG_FIELDS, interval()],
  pm2: [f('name', 'PM2 app name *', 'api'), f('max_restarts', 'Alert above restarts', ''), ...LOG_FIELDS, interval()],
  n8n: [f('url', 'n8n base URL', 'https://n8n.example.com'), f('api_key', 'n8n API key'), f('workflow_id', 'Workflow ID'), f('window_min', 'Success window (min)', '60'), f('min_rate', 'Min success %', '100'), f('limit', 'Executions to scan', '100'), interval('300')],
  cron_heartbeat: [f('interval_min', 'Runs every (min) *', '1440'), f('grace_min', 'Grace (min)', '30')],
  backup: [f('path', 'Folder or file path *', '/var/backups/app'), f('pattern', 'File pattern (* and ?)', 'backup-*.tar.gz'), f('max_age_hours', 'Max age (hours)', '26'), f('min_size_mb', 'Min size (MB)', '10'), f('at_hour', 'Run once at hour 0-23', ''), interval('3600')],
};
for (const t of Object.keys(schema)) schema[t] = [...schema[t], ...RESTART_FIELDS()];
const required = { http: ['url'], port: ['port'], systemd: ['unit'], pm2: ['name'], cron_heartbeat: ['interval_min'], n8n: [], backup: ['path'] };

const clean = (type, input = {}) => {
  const out = {};
  for (const spec of schema[type]) {
    const v = input[spec.k];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (spec.kind === 'checkbox') { if (v === true || /^(1|true|yes|on)$/i.test(String(v))) out[spec.k] = 1; continue; }
    out[spec.k] = spec.num ? Number(v) : String(v).trim().slice(0, 400);
  }
  return out;
};

const uptimePct = (id, hours = 24) => {
  const r = get('SELECT COUNT(*) n, SUM(ok) g FROM checks WHERE monitor_id=? AND created_at>?', id, now() - hours * 36e5);
  return r.n ? { pct: Math.round((r.g / r.n) * 1000) / 10, n: r.n } : { pct: null, n: 0 };
};

export const decorate = (m) => {
  const c = monitorConfig(m);
  const up = uptimePct(m.id);
  return {
    id: m.id, name: m.name, type: m.type, enabled: !!m.enabled, server_id: m.server_id,
    config: c, ok: m.last_ok === null ? null : !!m.last_ok, ms: m.last_ms, detail: m.last_detail,
    last_check: m.last_check, down_since: m.down_since, uptime: up.pct, samples: up.n,
    ping_url: m.type === 'cron_heartbeat' && m.secret ? pingUrl(m.secret) : null,
  };
};

export const router = express.Router();

/** A monitor may not be saved armed with a command the .env whitelist would refuse. */
const restartProblem = (config) => (config.auto_restart ? (checkCommand(config.restart_command).why ?? null) : null);

router.get('/schema', (req, res) => res.json({ types: monitorTypes, schema, required, default_server: localServerId, restart: whitelistInfo() }));
router.get('/monitors', (req, res) => res.json(monitors().map(decorate)));

router.post('/monitors', (req, res) => {
  const b = req.body || {};
  if (!monitorTypes.includes(b.type)) return res.status(400).json({ error: `type must be one of ${monitorTypes.join(', ')}` });
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'name is required' });
  const config = clean(b.type, b.config);
  const missing = (required[b.type] || []).filter((k) => config[k] === undefined);
  if (missing.length) return res.status(400).json({ error: `missing required field(s): ${missing.join(', ')}` });
  if (b.type === 'n8n' && !config.url && !cfg.n8nUrl) return res.status(400).json({ error: 'n8n monitor needs url (or N8N_URL in .env)' });
  const bad = restartProblem(config);
  if (bad) return res.status(400).json({ error: `auto-restart: ${bad}` });
  const secret = b.type === 'cron_heartbeat' ? newSecret() : null;
  const sid = Number(b.server_id) || localServerId;
  if (!get('SELECT id FROM servers WHERE id=?', sid)) return res.status(400).json({ error: 'unknown server_id' });
  const r = run('INSERT INTO monitors(name, type, enabled, config, secret, server_id, created_at) VALUES(?,?,?,?,?,?,?)',
    String(b.name).trim().slice(0, 120), b.type, b.enabled === false ? 0 : 1, JSON.stringify(config), secret, sid, now());
  const m = monitor(r.lastInsertRowid);
  if (b.check !== false) runMonitor(m).catch(() => {});
  res.json(decorate(m));
});

router.put('/monitors/:id', (req, res) => {
  const m = monitor(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const config = b.type && b.type !== m.type ? clean(b.type, b.config) : clean(m.type, b.config ?? monitorConfig(m));
  const missing = (required[b.type || m.type] || []).filter((k) => config[k] === undefined);
  if (missing.length) return res.status(400).json({ error: `missing required field(s): ${missing.join(', ')}` });
  const bad = restartProblem(config);
  if (bad) return res.status(400).json({ error: `auto-restart: ${bad}` });
  run('UPDATE monitors SET name=?, type=?, enabled=?, config=?, server_id=? WHERE id=?',
    String(b.name || m.name).trim().slice(0, 120), b.type || m.type, b.enabled === undefined ? m.enabled : (b.enabled ? 1 : 0),
    JSON.stringify(config), Number(b.server_id) || m.server_id, m.id);
  const fresh = monitor(m.id);
  if (b.clear_down || fresh.last_ok !== 0) run('UPDATE monitors SET down_since=NULL WHERE id=?', fresh.id);
  res.json(decorate(fresh));
});

router.delete('/monitors/:id', (req, res) => {
  const m = monitor(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const tx = db.transaction(() => {
    run('DELETE FROM monitors WHERE id=?', m.id);
    run('DELETE FROM checks WHERE monitor_id=?', m.id);
    run('UPDATE incidents SET monitor_id=NULL WHERE monitor_id=?', m.id);
  });
  tx();
  res.json({ ok: true });
});

router.post('/monitors/:id/check', async (req, res) => {
  const m = monitor(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(await runMonitor(m));
});

router.post('/check-now', async (req, res) => res.json(await runAll()));

router.post('/monitors/:id/toggle', (req, res) => {
  const m = monitor(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  run('UPDATE monitors SET enabled=? WHERE id=?', m.enabled ? 0 : 1, m.id);
  res.json(decorate(monitor(m.id)));
});

router.get('/monitors/:id/history', (req, res) => {
  const hours = Math.min(+req.query.hours || 24, 168);
  res.json(q('SELECT ok, ms, detail, created_at FROM checks WHERE monitor_id=? AND created_at>? ORDER BY id', req.params.id, now() - hours * 36e5));
});

router.get('/servers', (req, res) => res.json(q('SELECT id, name, is_local, last_seen, api_key FROM servers ORDER BY id')));

router.post('/servers', (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase().slice(0, 60);
  if (!/^[a-z0-9._-]+$/.test(name)) return res.status(400).json({ error: 'name may only contain letters, digits, dot, dash, underscore' });
  const key = crypto.randomBytes(20).toString('hex');
  try { run('INSERT INTO servers(name, api_key, created_at) VALUES(?,?,?)', name, key, now()); }
  catch { return res.status(409).json({ error: 'a server with that name already exists' }); }
  res.json({ id: get('SELECT id FROM servers WHERE name=?', name).id, name, api_key: key });
});

router.delete('/servers/:id', (req, res) => {
  const s = get('SELECT * FROM servers WHERE id=?', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.is_local) return res.status(400).json({ error: 'cannot remove the local server' });
  if (get('SELECT COUNT(*) n FROM monitors WHERE server_id=?', s.id).n) return res.status(409).json({ error: 'monitors still use this server — delete them first' });
  db.transaction(() => { run('DELETE FROM metrics WHERE server_id=?', s.id); run('DELETE FROM servers WHERE id=?', s.id); })();
  res.json({ ok: true });
});
