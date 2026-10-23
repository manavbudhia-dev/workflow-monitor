import { cfg } from './config.js';
import { q, openIncident, resolveIncident, monitor, serverName, localServerId } from './db.js';
import { send } from './alerts/telegram.js';
import { pushPing } from './alerts/push.js';
import { scrub } from './ai/logs.js';

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

  if (!ok) {
    let inc = null;
    if (prev === undefined || prev === true) inc = openIncident(m, kind, title, detail, logs);
    if (!cooldownOk(`${key}:down`)) return inc ? { type: 'down', id: inc.id, sent: false } : null;
    await send(`🔴 *DOWN* ${label}\n${host}\n${detail || title}\n_${when}_`);
    // Push is a bonus on top of Telegram, so a slow push service must never delay or fail the alert.
    if (inc) pushPing({ title: `Down: ${label}`, tag: `wm-${inc.id}`, body: scrub(String(detail || title)).slice(0, 140) }).catch(() => {});
    return { type: 'down', id: inc?.id, sent: true };
  }

  const wasDown = prev === false;
  states.delete(key);
  if (!wasDown) return null;
  const inc = resolveIncident(m, kind, detail);
  if (threshold && !cooldownOk(`${key}:up`, 10)) return { type: 'up', id: inc?.id, sent: false };
  await send(`🟢 *RECOVERED* ${label}\n${host}\nBack to normal${inc ? ` after ${dur(Date.now() - inc.started_at)}` : ''}\n_${when}_`);
  return { type: 'up', id: inc?.id, sent: true };
}
