import crypto from 'node:crypto';
import { cfg } from './config.js';
import { q, get, now, client, clients, monitor, monitorConfig, setting, setSetting } from './db.js';
import { sendTo } from './alerts/telegram.js';
import { sendEmail, alertEmail } from './alerts/email.js';
import { scrub } from './ai/logs.js';

/**
 * Clients: monitors and servers can belong to a client. That client then gets its own alerts (Telegram group
 * and/or email), a read-only status page behind a secret link, and a weekly report. The operator keeps getting
 * everything as before; clients never see logs, AI output, restarts or security events.
 */

export const list = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
export const newToken = () => crypto.randomBytes(18).toString('base64url');
export const statusUrl = (c) => `${cfg.publicUrl}/status/${c.status_token}`;

const TYPE = { http: 'Website / API', port: 'Service port', systemd: 'Service', pm2: 'App', n8n: 'n8n workflow', cron_heartbeat: 'Scheduled job', backup: 'Backup' };
export const typeLabel = (t) => TYPE[t] || t;

const dur = (ms) => {
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.max(1, Math.floor((ms % 36e5) / 6e4));
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/** The client a monitor or server belongs to: the monitor's own client wins, then its server's. */
export function clientFor({ monitorId, serverId }) {
  const m = monitorId ? monitor(monitorId) : null;
  if (m?.client_id) return client(m.client_id);
  const sid = serverId || m?.server_id;
  const s = sid ? get('SELECT client_id FROM servers WHERE id=?', sid) : null;
  return s?.client_id ? client(s.client_id) : undefined;
}

/** Monitors a client sees: assigned to them, or running on a server assigned to them. */
export const clientMonitors = (c) => q(`SELECT m.* FROM monitors m LEFT JOIN servers s ON s.id = m.server_id
  WHERE m.client_id = ? OR (m.client_id IS NULL AND s.client_id = ?) ORDER BY m.name COLLATE NOCASE`, c.id, c.id);
export const clientServers = (c) => q('SELECT * FROM servers WHERE client_id=? ORDER BY name', c.id);

/** Plain words for a client: no host names, logs or internal detail beyond the check result. */
function friendly(m, detail) {
  if (m?.type === 'n8n') {
    const c = monitorConfig(m);
    let x = {};
    try { x = JSON.parse(q('SELECT detail FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 1', m.id)[0]?.detail || '{}'); } catch { /* text */ }
    if (x.total) return `${x.failed} of ${x.total} runs failed in the last ${c.window_min || 60} minutes`;
  }
  return scrub(String(detail || '')).replace(/\s+/g, ' ').slice(0, 200);
}

/** Called by notify.edge() after the operator's own alert. Never throws. */
export async function clientAlert({ down, monitorId, serverId, kind, title, detail, after }) {
  try {
    if (!['monitor', 'agent'].includes(kind)) return null;
    const c = clientFor({ monitorId, serverId });
    if (!c) return null;
    const chats = list(c.telegram_chats), emails = list(c.emails);
    if (!chats.length && !emails.length) return null;
    const m = monitorId ? monitor(monitorId) : null;
    const name = m?.name || title;
    const what = m ? typeLabel(m.type) : 'Server';
    const why = kind === 'agent' ? (down ? 'The server stopped reporting' : 'The server is reporting again') : friendly(m, detail);
    const text = down
      ? `🔴 ${what} needs attention: ${name}\n${why}\nWe are on it. Live status: ${statusUrl(c)}`
      : `🟢 ${what} is working again: ${name}${after ? `\nDown for ${after}` : ''}\nLive status: ${statusUrl(c)}`;
    const rows = [[what, name], ...(down ? [['Problem', why]] : []), ...(after ? [['Down for', after]] : []), ['Time', new Date().toLocaleString()]];
    const [tg, mail] = await Promise.all([
      sendTo(chats, text),
      emails.length ? sendEmail({
        to: emails,
        subject: down ? `🔴 ${name} needs attention` : `🟢 ${name} is working again`,
        ...alertEmail({ down, title: name, rows, links: [['Open status page', statusUrl(c)]], label: down ? 'NEEDS ATTENTION' : 'WORKING AGAIN', footer: `${c.name} · monitored by ${cfg.brandName}` }),
      }) : null,
    ]);
    return { client: c.id, telegram: tg, email: mail?.sent ?? null };
  } catch (e) {
    console.error('[client alert]', e.message);
    return null;
  }
}

const uptime = (id, since) => {
  const r = get('SELECT COUNT(*) n, SUM(ok) g FROM checks WHERE monitor_id=? AND created_at>?', id, since);
  return r.n ? Math.round((r.g / r.n) * 1000) / 10 : null;
};

/** Everything the status page and the weekly report show for one client. */
export function statusData(c) {
  const t = now();
  const mons = clientMonitors(c).filter((m) => m.enabled).map((m) => {
    let rate = null;
    if (m.type === 'n8n') {
      const rows = q('SELECT detail FROM checks WHERE monitor_id=? AND created_at>? ORDER BY id DESC LIMIT 2000', m.id, t - 7 * 864e5);
      const rates = rows.map((r) => { try { return JSON.parse(r.detail).rate; } catch { return undefined; } }).filter((x) => typeof x === 'number');
      if (rates.length) rate = Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10;
    }
    return {
      id: m.id, name: m.name, type: m.type, label: typeLabel(m.type),
      ok: m.last_ok === null ? null : !!m.last_ok, last_check: m.last_check, down_since: m.down_since,
      uptime_24h: uptime(m.id, t - 864e5), uptime_7d: uptime(m.id, t - 7 * 864e5), success_7d: rate,
    };
  });
  const silence = Math.max(cfg.metricsIntervalSec * 4, 120) * 1000;
  const srv = clientServers(c).map((s) => {
    const x = get('SELECT cpu, mem, disk FROM metrics WHERE server_id=? ORDER BY id DESC LIMIT 1', s.id) || {};
    return { name: s.name, online: !!s.last_seen && t - s.last_seen <= silence, last_seen: s.last_seen, cpu: x.cpu ?? null, mem: x.mem ?? null, disk: x.disk ?? null };
  });
  const ids = mons.map((m) => m.id);
  const sids = clientServers(c).map((s) => s.id);
  const incidents = (ids.length || sids.length) ? q(`SELECT i.id, i.kind, i.title, i.started_at, i.resolved_at, i.state, m.name AS monitor
    FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id
    WHERE i.started_at > ? AND i.kind IN ('monitor','agent') AND (i.monitor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) OR (i.kind='agent' AND i.server_id IN (${sids.map(() => '?').join(',') || 'NULL'})))
    ORDER BY i.started_at DESC LIMIT 50`, t - 7 * 864e5, ...ids, ...sids).map((i) => ({
    title: i.monitor || i.title, open: i.state === 'open', started_at: i.started_at, resolved_at: i.resolved_at,
    duration: dur((i.resolved_at || t) - i.started_at),
  })) : [];
  const down = mons.filter((m) => m.ok === false).length + srv.filter((s) => !s.online).length;
  return { name: c.name, generated_at: t, all_ok: down === 0, down, monitors: mons, servers: srv, incidents };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** Server-rendered, script-free page (the app's CSP allows inline styles only). Refreshes itself every minute. */
export function statusPage(d) {
  const dot = (ok) => `<span class="d ${ok === false ? 'down' : ok ? 'up' : 'wait'}"></span>`;
  const rows = d.monitors.map((m) => `<tr><td>${dot(m.ok)}<b>${esc(m.name)}</b><small>${esc(m.label)}</small></td>
    <td>${m.ok === false ? `<span class="bad">Down${m.down_since ? ` for ${esc(dur(d.generated_at - m.down_since))}` : ''}</span>` : m.ok ? 'Working' : 'Checking…'}</td>
    <td>${pct(m.uptime_24h)}</td><td>${pct(m.uptime_7d)}</td><td>${m.type === 'n8n' ? pct(m.success_7d) : '—'}</td></tr>`).join('');
  const srv = d.servers.map((s) => `<tr><td>${dot(s.online)}<b>${esc(s.name)}</b></td><td>${s.online ? 'Online' : '<span class="bad">Not reporting</span>'}</td>
    <td>${s.cpu ?? '—'}%</td><td>${s.mem ?? '—'}%</td><td>${s.disk ?? '—'}%</td></tr>`).join('');
  const inc = d.incidents.map((i) => `<li>${dot(i.open ? false : true)}<b>${esc(i.title)}</b> — ${i.open ? `<span class="bad">ongoing, ${esc(i.duration)}</span>` : `resolved after ${esc(i.duration)}`}<small>${esc(when(i.started_at))}</small></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="60"><title>${esc(d.name)} · Status</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e5e7eb}
main{max-width:860px;margin:0 auto;padding:28px 18px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;color:#cbd5e1}
.hero{padding:18px 20px;border-radius:12px;margin-top:18px;font-weight:650;font-size:17px}
.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35)}.no{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4)}
table{width:100%;border-collapse:collapse;background:#111a2e;border-radius:10px;overflow:hidden;font-size:14px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #1e293b}th{color:#94a3b8;font-weight:600;font-size:12px}
td small,li small{display:block;color:#94a3b8;font-size:12px;margin-left:18px}
.d{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px;background:#64748b}.d.up{background:#22c55e}.d.down{background:#ef4444}
.bad{color:#f87171}ul{list-style:none;padding:0;margin:0;background:#111a2e;border-radius:10px}li{padding:10px 12px;border-bottom:1px solid #1e293b;font-size:14px}
.muted{color:#94a3b8;font-size:13px}footer{margin-top:28px;color:#64748b;font-size:12px}
@media(max-width:600px){th:nth-child(4),td:nth-child(4),th:nth-child(5),td:nth-child(5){display:none}}
</style></head><body><main>
<h1>${esc(d.name)}</h1><div class="muted">Live status · updated ${esc(when(d.generated_at))}</div>
<div class="hero ${d.all_ok ? 'ok' : 'no'}">${d.all_ok ? '✅ All systems working' : `⚠️ ${d.down} item${d.down === 1 ? '' : 's'} need${d.down === 1 ? 's' : ''} attention — we are on it`}</div>
${rows ? `<h2>Automations &amp; services</h2><table><tr><th>Name</th><th>Now</th><th>Uptime 24h</th><th>Uptime 7d</th><th>Run success 7d</th></tr>${rows}</table>` : '<p class="muted">Nothing is being monitored yet.</p>'}
${srv ? `<h2>Servers</h2><table><tr><th>Server</th><th>Now</th><th>CPU</th><th>RAM</th><th>Disk</th></tr>${srv}</table>` : ''}
<h2>Incidents · last 7 days</h2>${inc ? `<ul>${inc}</ul>` : '<p class="muted">No incidents in the last 7 days.</p>'}
<footer>Monitored by ${esc(cfg.brandName)}</footer></main></body></html>`;
}

export function weeklyReportText(c) {
  const d = statusData(c);
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const up = avg(d.monitors.map((m) => m.uptime_7d).filter((x) => x !== null));
  const runs = avg(d.monitors.map((m) => m.success_7d).filter((x) => x !== null));
  const lines = [`📊 Weekly report — ${c.name}`, ''];
  if (up !== null) lines.push(`Uptime: ${up}% across ${d.monitors.length} monitored item${d.monitors.length === 1 ? '' : 's'}`);
  if (runs !== null) lines.push(`n8n run success: ${runs}%`);
  lines.push(`Incidents: ${d.incidents.length}${d.incidents.length ? ` (${d.incidents.filter((i) => !i.open).length} resolved)` : ' 🎉'}`);
  for (const i of d.incidents.slice(0, 5)) lines.push(`• ${i.title} — ${i.open ? `ongoing (${i.duration})` : `fixed in ${i.duration}`}`);
  const weak = d.monitors.filter((m) => m.uptime_7d !== null && m.uptime_7d < 99);
  if (weak.length) { lines.push('', 'Needs a look:'); for (const m of weak.slice(0, 5)) lines.push(`• ${m.name}: ${m.uptime_7d}% uptime`); }
  lines.push('', `Live status: ${statusUrl(c)}`);
  return lines.join('\n');
}

export async function sendWeeklyReport(c) {
  const text = weeklyReportText(c);
  const chats = list(c.telegram_chats), emails = list(c.emails);
  const [tg, mail] = await Promise.all([
    sendTo(chats, text),
    emails.length ? sendEmail({ to: emails, subject: `📊 Weekly report — ${c.name}`, text, html: `<pre style="font-family:system-ui,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</pre>` }) : null,
  ]);
  return { telegram: tg, email: mail?.sent ?? null, text };
}

/** Called every minute: Mondays at SUMMARY_HOUR, once per client. */
export function maybeWeeklyReports() {
  const d = new Date();
  if (d.getDay() !== cfg.weeklyReportDay || d.getHours() !== cfg.summaryHour) return;
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  for (const c of clients()) {
    if (!c.weekly_report || (!list(c.telegram_chats).length && !list(c.emails).length)) continue;
    if (setting(`weekly:${c.id}`, '') === key) continue;
    setSetting(`weekly:${c.id}`, key);
    sendWeeklyReport(c).catch((e) => console.error('[weekly report]', e.message));
  }
}
