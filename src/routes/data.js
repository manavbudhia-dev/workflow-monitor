import express from 'express';
import { cfg } from '../config.js';
import { q, get, run, now, monitors, incident, localServerId } from '../db.js';
import { decorate } from './monitors.js';
import { explainIncident, explain, aiReady } from '../ai/explain.js';
import { telegramInfo, send } from '../alerts/telegram.js';
import { backupRows } from '../collectors/backup.js';
import { restartsFor, recentRestarts, whitelistInfo } from '../collectors/restart.js';

export const router = express.Router();
const clampHours = (v) => Math.min(Math.max(+v || 24, 1), 168);

router.get('/summary', (req, res) => {
  const srv = q(`SELECT s.id, s.name, s.is_local, s.last_seen, m.cpu, m.mem, m.disk, m.load, m.uptime,
      m.net_in, m.net_out, m.created_at AS metric_at
    FROM servers s
    LEFT JOIN metrics m ON m.id = (SELECT id FROM metrics WHERE server_id = s.id ORDER BY id DESC LIMIT 1)
    ORDER BY s.id`);
  const ms = monitors().map(decorate);
  const on = ms.filter((m) => m.enabled);
  res.json({
    now: now(), host: process.platform, public_url: cfg.publicUrl,
    servers: srv.map((s) => ({ ...s, stale: !s.last_seen || now() - s.last_seen > Math.max(cfg.metricsIntervalSec * 4, 120) * 1000 })),
    monitors: ms,
    counts: {
      enabled: on.length,
      down: on.filter((m) => m.ok === false).length,
      pending: on.filter((m) => m.ok === null).length,
      up: on.filter((m) => m.ok === true).length,
      disabled: ms.length - on.length,
      open_incidents: q('SELECT COUNT(*) n FROM incidents WHERE state=?', 'open')[0].n,
    },
    telegram: telegramInfo(),
    ai: { provider: cfg.aiProvider, ready: aiReady() },
    thresholds: { cpu: cfg.cpuWarnPct, mem: cfg.memWarnPct, disk: cfg.diskWarnPct, ssl_days: cfg.sslWarnDays },
    intervals: { metrics: cfg.metricsIntervalSec, checks: cfg.checkIntervalSec },
  });
});

router.get('/metrics', (req, res) => {
  const hours = clampHours(req.query.hours);
  const sid = Number(req.query.server_id) || localServerId;
  const bucket = hours > 6 ? 60000 : 15000;
  const rows = q(`SELECT CAST(created_at / ? AS INT) * ? AS t,
      ROUND(AVG(cpu), 1) cpu, ROUND(MAX(cpu), 1) cpu_max, ROUND(AVG(mem), 1) mem,
      ROUND(AVG(disk), 1) disk, ROUND(AVG(load), 2) load,
      ROUND(AVG(net_in), 2) net_in, ROUND(AVG(net_out), 2) net_out, COUNT(*) n
    FROM metrics WHERE server_id = ? AND created_at > ? GROUP BY t ORDER BY t`,
    bucket, bucket, sid, now() - hours * 36e5);
  res.json({ server_id: sid, hours, bucket_ms: bucket, points: rows.map((r) => ({ ...r, cpu: r.cpu ?? 0, mem: r.mem ?? 0, disk: r.disk ?? 0 })) });
});

function incidentList(req, res, where, args) {
  const limit = Math.min(+req.query.limit || 30, 200);
  const offset = Math.max(+req.query.offset || 0, 0);
  res.json(q(`SELECT i.id, i.monitor_id, i.kind, i.title, i.state, i.started_at, i.resolved_at, i.server_id,
      substr(i.detail, 1, 300) AS detail, length(i.logs) AS log_chars, (i.ai IS NOT NULL AND i.ai <> '') AS has_ai, m.name AS monitor
    FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id
    ${where} ORDER BY i.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset));
}

router.get('/incidents', (req, res) => {
  const state = req.query.state;
  if (state === 'open' || state === 'resolved') return incidentList(req, res, 'WHERE i.state = ?', [state]);
  if (req.query.monitor_id) return incidentList(req, res, 'WHERE i.monitor_id = ?', [Number(req.query.monitor_id)]);
  return incidentList(req, res, '', []);
});

router.get('/incidents/:id', (req, res) => {
  const inc = incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  res.json({
    ...inc,
    has_logs: !!inc.logs,
    monitor: get('SELECT * FROM monitors WHERE id=?', inc.monitor_id),
    restarts: inc.monitor_id ? restartsFor(inc.monitor_id, 20) : [],
  });
});

/** Every auto-restart attempt, newest first — the audit trail behind a restart alert. */
router.get('/restarts', (req, res) => res.json({
  ...whitelistInfo(),
  rows: req.query.monitor_id ? restartsFor(req.query.monitor_id, req.query.limit) : recentRestarts(req.query.limit),
}));

/** Last backup per backup monitor, plus the size history for the trend chart. */
router.get('/backups', (req, res) => res.json({ enabled: cfg.backupEnabled, monitors: backupRows() }));

router.post('/incidents/:id/explain', async (req, res) => {
  const out = await explainIncident(req.params.id);
  res.status(out.status || 200).json(out);
});

router.post('/incidents/:id/resolve', (req, res) => {
  const inc = incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  if (inc.state === 'resolved') return res.json({ ok: true, already: true });
  run('UPDATE incidents SET state=?, resolved_at=? WHERE id=?', 'resolved', now(), inc.id);
  res.json({ ok: true });
});

/** Success rate per n8n workflow monitor, from the recent check samples. */
router.get('/n8n', (req, res) => {
  const out = monitors().filter((m) => m.type === 'n8n').map((m) => {
    const rows = q('SELECT ok, detail, created_at FROM checks WHERE monitor_id=? AND created_at>? ORDER BY id DESC LIMIT 200', m.id, now() - 864e5);
    const samples = [];
    for (const r of rows) {
      try { const j = JSON.parse(r.detail); if (typeof j.rate === 'number') samples.push({ t: r.created_at, rate: j.rate, failed: j.failed, total: j.total }); } catch { /* plain text */ }
    }
    const avg = samples.length ? Math.round((samples.reduce((s, x) => s + x.rate, 0) / samples.length) * 10) / 10 : null;
    return {
      id: m.id, name: m.name, ok: m.last_ok === null ? null : !!m.last_ok, detail: m.last_detail,
      workflow_id: JSON.parse(m.config || '{}').workflow_id || '(all workflows)',
      current: samples[0] || null, avg_24h: avg, samples: samples.slice(0, 60).reverse(),
    };
  });
  res.json(out);
});

router.post('/selftest/telegram', async (req, res) => {
  const ok = await send(`✅ workflow-monitor self test from ${cfg.publicUrl}`);
  res.json({ sent: ok, ...telegramInfo(), note: ok ? 'Check the chat ids in TELEGRAM_CHAT_IDS.' : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS in .env and restart.' });
});

router.post('/selftest/ai', async (req, res) => {
  if (!aiReady()) return res.status(400).json({ error: `AI_PROVIDER=${cfg.aiProvider} with no AI_API_KEY` });
  const out = await explain({ title: 'self test', detail: 'The monitor asked for a test completion.', logs: 'node[123]: ECONNREFUSED 127.0.0.1:5432' });
  res.json({ provider: cfg.aiProvider, model: cfg.aiModel, reply: out });
});
