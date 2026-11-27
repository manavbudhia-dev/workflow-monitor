import { cfg } from './config.js';
import { q, openIncident, resolveIncident, monitor, serverName, localServerId } from './db.js';
import { send } from './alerts/telegram.js';
import { pushPing } from './alerts/push.js';
import { scrub } from './ai/logs.js';
import { sendEmail, alertEmail } from './alerts/email.js';
import { n8nAuth } from './n8n.js';
import { clientAlert } from './clients.js';

const lastSent = new Map();
const states = new Map();

// Restarting must not re-alert on something that was already known to be down.
for (const m of q('SELECT id, last_ok FROM monitors')) if (m.last_ok === 0) states.set(`mon:${m.id}`, false);
for (const s of q('SELECT id, last_seen FROM servers')) if (s.last_seen) states.set(`agent:${s.id}`, true);

export function cooldownOk(key, minutes = cfg.cooldownMin) {
  const prev = lastSent.get(key) || 0;
  if (Date.now() - prev < minutes * 6e4) return false;
  lastSent.set(key, Date.now());
  return true;
}

/** ALERT_EMAIL_TYPES narrows email to some monitor types (e.g. "n8n"); empty = every alert. */
const wantsEmail = (m) => !cfg.emailTypes.length || cfg.emailTypes.includes(m?.type || 'system');

/** For an n8n monitor: the workflow plus direct links to the runs that failed in the last check. */
function n8nContext(m) {
  if (m?.type !== 'n8n') return { rows: [], links: [] };
  let c = {};
  try { c = JSON.parse(m.config || '{}'); } catch { /* keep empty */ }
  const { base } = n8nAuth(c);
  const rows = [['Workflow', c.workflow_name || c.workflow_id || 'All workflows']];
  const links = [];
  let extra = {};
  try { extra = JSON.parse(q('SELECT detail FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 1', m.id)[0]?.detail || '{}'); } catch { /* plain text */ }
  if (extra.total) rows.push(['Failed runs', `${extra.failed} of ${extra.total} in the last ${c.window_min || 60} minutes`]);
  if (base) {
    for (const r of (extra.runs || []).slice(0, 3)) {
      const wf = r.wf || c.workflow_id;
      if (wf) links.push([`Open failed run #${r.id}`, `${base}/workflow/${encodeURIComponent(wf)}/executions/${encodeURIComponent(r.id)}`]);
    }
    if (!links.length) links.push(['Open in n8n', c.workflow_id ? `${base}/workflow/${encodeURIComponent(c.workflow_id)}` : `${base}/home/workflows`]);
  }
  return { rows, links };
}

function mailAlert({ down, m, label, host, detail, logs, when, after }) {
  if (!wantsEmail(m)) return Promise.resolve(null);
  const ctx = n8nContext(m);
  const isN8n = m?.type === 'n8n';
  const rows = [
    ['Monitor', label], ...ctx.rows, ['Server', host.replace(/^@ /, '')],
    ...(isN8n && down ? [] : [[down ? 'Problem' : 'Status', scrub(String(detail || (down ? 'down' : 'back to normal'))).slice(0, 500)]]),
    ...(after ? [['Down for', after]] : []), ['Time', when],
  ];
  const links = [...(down ? ctx.links : []), ['Open dashboard', `${cfg.publicUrl}/#${isN8n ? 'workflows' : 'incidents'}`]];
  const what = isN8n ? 'n8n workflow' : 'Monitor';
  const subject = down ? `🔴 ${what} failing: ${m?.name || label}` : `🟢 ${what} recovered: ${m?.name || label}`;
  // n8n runs are linked instead: their raw execution JSON is long and unreadable in a mail client.
  const body = down && logs && !isN8n ? scrub(String(logs)).slice(-2000) : '';
  return sendEmail({ subject, ...alertEmail({ down, title: m?.name || label, rows, links, body }) });
}

const dur = (ms) => {
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return (d ? `${d}d ` : '') + (h ? `${h}h ` : '') + `${m}m`;
};

/**
 * Edge-triggered state change: acts only on ok -> down and down -> ok, so a
 * monitor that stays broken does not re-alert on every check interval.
 * Returns { type, id } when something was reported, otherwise null.
 */
export async function edge({ key, ok, monitorId, serverId, kind, title, detail, logs, threshold = false }) {
  const prev = states.get(key);
  states.set(key, ok);
  if (prev === ok && !ok) return null;

  const m = monitorId ? monitor(monitorId) : { id: 0, server_id: serverId };
  const label = m && m.name ? `${m.name} (${m.type})` : title;
  const host = `@ ${serverName(serverId || m.server_id || localServerId)}`;
  const when = new Date().toLocaleTimeString();
  const stamp = new Date().toLocaleString();

  if (!ok) {
    let inc = null;
    if (prev === undefined || prev === true) inc = openIncident(m, kind, title, detail, logs);
    if (!cooldownOk(`${key}:down`)) return inc ? { type: 'down', id: inc.id, sent: false } : null;
    await Promise.all([
      send(`🔴 *DOWN* ${label}\n${host}\n${detail || title}\n_${when}_`),
      mailAlert({ down: true, m, label, host, detail: detail || title, logs, when: stamp }),
    ]);
    clientAlert({ down: true, monitorId, serverId, kind, title, detail }).catch(() => {});
    // Push is a bonus on top of Telegram, so a slow push service must never delay or fail the alert.
    if (inc) pushPing({ title: `Down: ${label}`, tag: `wm-${inc.id}`, body: scrub(String(detail || title)).slice(0, 140) }).catch(() => {});
    return { type: 'down', id: inc?.id, sent: true };
  }

  const wasDown = prev === false;
  states.delete(key);
  if (!wasDown) return null;
  const inc = resolveIncident(m, kind, detail);
  if (threshold && !cooldownOk(`${key}:up`, 10)) return { type: 'up', id: inc?.id, sent: false };
  const after = inc ? dur(Date.now() - inc.started_at) : '';
  await Promise.all([
    send(`🟢 *RECOVERED* ${label}\n${host}\nBack to normal${after ? ` after ${after}` : ''}\n_${when}_`),
    mailAlert({ down: false, m, label, host, detail, when: stamp, after }),
  ]);
  clientAlert({ down: false, monitorId, serverId, kind, title, detail, after }).catch(() => {});
  return { type: 'up', id: inc?.id, sent: true };
}
