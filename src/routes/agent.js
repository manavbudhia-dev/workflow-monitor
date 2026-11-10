import express from 'express';
import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { get, run, now, setSetting } from '../db.js';
import { evaluate } from '../collectors/metrics.js';
import { edge } from '../notify.js';

export const router = express.Router();
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(+v) ? null : Math.round(+v * 10) / 10);

function agentServer(req, res, next) {
  const key = req.get('x-agent-key') || req.query.key;
  if (!key) return res.status(401).json({ error: 'missing x-agent-key' });
  const s = get('SELECT * FROM servers WHERE api_key=?', String(key));
  if (!s) return res.status(403).json({ error: 'unknown agent key' });
  req.server = s;
  next();
}

/** Remote agents push the same shape the local collector produces. */
router.post('/agent/metrics', agentServer, async (req, res) => {
  const b = req.body || {};
  const m = {
    cpu: num(b.cpu), mem: num(b.mem), disk: num(b.disk), load: num(b.load),
    uptime: b.uptime ? Math.round(+b.uptime) : null,
    net_in: num(b.net_in), net_out: num(b.net_out),
  };
  if (m.cpu === null && m.mem === null) return res.status(400).json({ error: 'no metrics in payload' });
  run('INSERT INTO metrics(server_id, cpu, mem, disk, load, uptime, net_in, net_out, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    req.server.id, m.cpu, m.mem, m.disk, m.load, m.uptime, m.net_in, m.net_out, now());
  run('UPDATE servers SET last_seen=? WHERE id=?', now(), req.server.id);
  await evaluate(req.server.id, m, +b.cores || 1);
  res.json({ ok: true, server: req.server.name });
});

/** Self-test for the install script: proves the key works without writing metrics. */
router.get('/agent/hello', agentServer, (req, res) => res.json({ ok: true, server_id: req.server.id, name: req.server.name, server_time: new Date().toISOString() }));

/**
 * Cron heartbeat: /api/ping/<secret> is the whole credential, so it can sit in
 * a crontab line. `?fail=1` lets a job report that its own run errored.
 */
router.all('/ping/:secret', async (req, res) => {
  const m = get('SELECT * FROM monitors WHERE secret=? AND type=?', req.params.secret, 'cron_heartbeat');
  if (!m) return res.status(404).json({ error: 'unknown ping url' });
  const failed = /^(1|true|yes)$/i.test(String(req.query.fail || ''));
  const msg = String(req.query.msg || '').slice(0, 200);
  const detail = failed ? `cron job reported failure: ${msg || 'no message'}` : `pinged at ${new Date().toLocaleString()}`;
  run(`UPDATE monitors SET last_check=?, last_ok=?, last_detail=?,
      down_since=CASE WHEN ? THEN COALESCE(down_since, ?) ELSE NULL END WHERE id=?`,
    now(), failed ? 0 : 1, detail, failed ? 1 : 0, now(), m.id);
  // The scheduled heartbeat check reads this, so a reported failure stays down until a good ping.
  setSetting(`hb_fail:${m.id}`, failed ? detail : '');
  if (failed) {
    await edge({ key: `mon:${m.id}`, ok: false, monitorId: m.id, serverId: m.server_id, kind: 'monitor', title: m.name, detail });
    return res.json({ ok: false, pinged: true });
  }
  await edge({ key: `mon:${m.id}`, ok: true, monitorId: m.id, serverId: m.server_id, kind: 'monitor', title: m.name, detail: 'cron job pinged on time' });
  res.json({ ok: true, pinged: true });
});

export const newSecret = () => crypto.randomBytes(12).toString('hex');
export const pingUrl = (secret) => `${cfg.publicUrl}/api/ping/${secret}`;
