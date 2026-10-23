import net from 'node:net';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { cfg } from '../config.js';
import { monitorConfig, now, monitors, addCheck, updateMonitorAfterCheck } from '../db.js';
import { edge } from '../notify.js';
import { send } from '../alerts/telegram.js';
import { getLastLogs } from '../ai/logs.js';
import { explainAndSave } from '../ai/explain.js';
import { maybeRestart } from './restart.js';
import { checkBackup } from './backup.js';

const isLinux = process.platform === 'linux';
const truthy = (v, d = true) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

function sh(cmd, args, ms = 8000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms });
  if (r.error) throw new Error(`${cmd} unavailable (${r.error.code || r.error.message})`);
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
let pm2ok;
const hasPm2 = () => (pm2ok ??= (() => { try { return sh('pm2', ['-v'], 5000).code === 0; } catch { return false; } })());

async function certDays(host, port = 443) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.destroy();
      if (!c || !c.valid_to) return reject(new Error('no certificate'));
      resolve({ days: Math.floor((new Date(c.valid_to).getTime() - now()) / 864e5), issuer: c.issuer?.O || c.issuer?.CN || '' });
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('tls timeout')); });
  });
}

async function checkHttp(c) {
  if (!c.url) return { ok: false, detail: 'no url configured' };
  const ms = +c.timeout_ms || 10000;
  const t0 = now();
  const headers = { 'user-agent': 'workflow-monitor/1.0', ...(c.headers || {}) };
  if (c.bearer) headers.authorization = `Bearer ${c.bearer}`;
  const res = await fetch(c.url, {
    method: c.method || 'GET', headers, redirect: truthy(c.follow) ? 'follow' : 'manual',
    signal: AbortSignal.timeout(ms),
  });
  let ok, detail = `${res.status} ${res.statusText || ''}`.trim();
  if (c.expect_status) ok = String(c.expect_status).split(/[,\s]+/).map(Number).includes(res.status);
  else ok = res.status >= 200 && res.status < 400;
  if (ok && c.keyword) {
    const body = await res.text().catch(() => '');
    if (!body.includes(c.keyword)) { ok = false; detail = `keyword "${c.keyword}" missing in body`; }
  }
  let ssl = null;
  const u = new URL(c.url);
  if (u.protocol === 'https:' && truthy(c.ssl)) {
    ssl = await certDays(u.hostname, +u.port || 443).catch((e) => ({ days: null, err: e.message }));
    if (ssl && ssl.days !== null) {
      detail += ` · cert ${ssl.days < 0 ? 'EXPIRED' : `${ssl.days}d left`}`;
      if (ssl.days < 0) ok = false;
      else if (ssl.days <= cfg.sslWarnDays && ok) send(`⚠️ *SSL EXPIRING* ${u.hostname}\nCertificate expires in ${ssl.days} days\nIssuer: ${ssl.issuer}`).catch(() => {});
    }
  }
  return { ok, detail, ms: now() - t0 };
}

async function checkPort(c) {
  const host = c.host || '127.0.0.1', port = Number(c.port);
  if (!port) return { ok: false, detail: 'no port configured' };
  const ms = +c.timeout_ms || 5000;
  const t0 = now();
  await new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setTimeout(ms);
    s.on('connect', () => { s.destroy(); resolve(); });
    s.on('timeout', () => { s.destroy(); reject(new Error(`connect timeout after ${ms}ms`)); });
    s.on('error', (e) => { s.destroy(); reject(new Error(`${e.code || 'error'} ${e.message}`)); });
  });
  return { ok: true, detail: `${host}:${port} accepting connections`, ms: now() - t0 };
}

async function checkSystemd(c) {
  if (!c.unit) return { ok: false, detail: 'no unit configured' };
  if (!isLinux) return { skip: `systemd checks need Linux (running on ${process.platform})` };
  const t0 = now();
  const r = sh('systemctl', ['show', c.unit, '--no-pager', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'ExecMainStartTimestamp']);
  const p = Object.fromEntries(r.out.split('\n').filter(Boolean).map((l) => l.split('=').map((s) => s.trim())));
  const ok = p.ActiveState === 'active' && (!c.expect_sub || p.SubState === c.expect_sub);
  return { ok, detail: `${c.unit}: ${p.ActiveState}/${p.SubState} pid=${p.MainPID || '-'} since ${p.ExecMainStartTimestamp || '-'}`, ms: now() - t0 };
}

async function checkPm2(c) {
  if (!hasPm2()) return { skip: 'pm2 binary not found on this host' };
  if (!c.name) return { ok: false, detail: 'no pm2 app name configured' };
  const t0 = now();
  const r = sh('pm2', ['jlist'], 12000);
  let list;
  try { list = JSON.parse(r.out || '[]'); } catch { return { ok: false, detail: `cannot parse pm2 jlist (${r.code})` }; }
  const app = list.find((a) => a.name === c.name);
  if (!app) return { ok: false, detail: `pm2 app "${c.name}" not found` };
  const e = app.pm2_env || {};
  const ok = e.status === 'online' && (+c.max_restarts ? (e.restart_time || 0) <= +c.max_restarts : true);
  const up = e.pm_uptime ? Math.floor((now() - e.pm_uptime) / 60000) : null;
  return { ok, detail: `${c.name}: ${e.status}, restarts=${e.restart_time ?? '?'}, mem=${Math.round((app.monits?.memory?.heap ?? e.memory ?? 0) / 1048576)}MB${up !== null ? `, up ${up}m` : ''}`, ms: now() - t0, extra: { rate: null, pid: e.pid } };
}

async function checkN8n(c) {
  const base = String(c.url || cfg.n8nUrl || '').replace(/\/+$/, '');
  const key = c.api_key || cfg.n8nKey;
  if (!base || !key) return { ok: false, detail: 'n8n url / API key not set (config or N8N_URL + N8N_API_KEY)' };
  const t0 = now();
  const winMin = +c.window_min || 60;
  const limit = Math.min(+c.limit || 100, 100);
  const u = `${base}/executions?limit=${limit}` + (c.workflow_id ? `&workflowId=${encodeURIComponent(c.workflow_id)}` : '');
  const data = await fetch(u, { headers: { 'x-n8n-api-key': key }, signal: AbortSignal.timeout(+c.timeout_ms || 15000) })
    .then((r) => { if (!r.ok) throw new Error(`n8n API ${r.status} ${r.statusText}`); return r.json(); });
  const rows = data.data || data.executions || [];
  const cutoff = now() - winMin * 60000;
  const st = (r) => String(r.status || (r.finished ? 'success' : r.stoppedAt ? 'error' : 'running'));
  const recent = rows.filter((r) => new Date(r.startedAt || r.stoppedAt || 0).getTime() >= cutoff);
  const done = recent.filter((r) => st(r) !== 'running' && st(r) !== 'waiting');
  const bad = done.filter((r) => /error|failed|crashed|killed/.test(st(r)));
  const total = done.length;
  const rate = total ? Math.round(((total - bad.length) / total) * 1000) / 10 : 100;
  const minRate = c.min_rate !== undefined && c.min_rate !== '' ? +c.min_rate : 100;
  const ok = rate >= minRate;
  const last = bad[0] ? ` last failed #${bad[0].id} (${bad[0].mode || '?'})` : '';
  return { ok, detail: `${rate}% success, ${bad.length}/${total} failed in last ${winMin}m (min ${minRate}%).${last}`, ms: now() - t0, extra: { rate, failed: bad.length, total, ids: bad.slice(0, 5).map((r) => r.id) } };
}

async function checkHeartbeat(c, m) {
  const interval = (+c.interval_min || 60) * 60000;
  const grace = (+c.grace_min || 15) * 60000;
  if (!m.last_check) return { ok: false, detail: `no ping received yet — waiting for first hit on /api/ping/<secret>` };
  const since = now() - m.last_check;
  const late = since - interval;
  const ago = Math.round(since / 60000);
  return { ok: late <= grace, detail: `last ping ${ago}m ago, expected every ${Math.round(interval / 60000)}m (grace ${Math.round(grace / 60000)}m)` + (late > 0 ? ` — ${Math.round(late / 60000)}m overdue` : '') };
}

export const types = {
  http: checkHttp, port: checkPort, systemd: checkSystemd,
  pm2: checkPm2, n8n: checkN8n, cron_heartbeat: checkHeartbeat, backup: checkBackup,
};
export const monitorTypes = Object.keys(types);

export async function runMonitor(m) {
  const c = monitorConfig(m);
  const fn = types[m.type];
  if (!fn) return { id: m.id, error: `unknown type ${m.type}` };
  let out;
  const started = now();
  try { out = await fn(c, m); } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || '';
    out = { ok: false, detail: `${e.name}: ${e.message}${cause ? ` (${cause})` : ''}`.slice(0, 300) };
  }
  if (out.skip) return { id: m.id, name: m.name, skip: out.skip };

  const firstFailure = !out.ok && m.last_ok !== 0;
  addCheck(m.id, out.ok, out.ms ?? now() - started, out.extra ? JSON.stringify(out.extra) : out.detail);
  updateMonitorAfterCheck(m, out.ok, out.ms ?? 0, out.detail, m.type !== 'cron_heartbeat');
  const logs = firstFailure ? await getLastLogs(m, c).catch((e) => `[log capture failed: ${e.message}]`) : '';
  const res = await edge({
    key: `mon:${m.id}`, ok: out.ok, monitorId: m.id, serverId: m.server_id,
    kind: 'monitor', title: m.name, detail: out.detail, logs,
  });
  if (res?.type === 'down' && res.id) explainAndSave(res.id, { title: `${m.name} (${m.type}) is down`, detail: out.detail, logs });
  const restart = await maybeRestart(m, out, () => fn(c, m)).catch((e) => ({ error: e.message }));
  return { id: m.id, name: m.name, ok: out.ok, detail: out.detail, ms: out.ms, restart };
}

export async function runAll() {
  const out = [];
  for (const m of monitors(true)) {
    try { out.push(await runMonitor(m)); } catch (e) { out.push({ id: m.id, name: m.name, error: e.message }); }
  }
  return out;
}
