import { cfg } from '../config.js';
import { now, monitorConfig, monitors, servers } from '../db.js';
import { edge } from '../notify.js';
import { runMonitor } from './checks.js';
import { scanSecurity } from './security.js';
import { maybeDailySummary, startBot } from '../alerts/telegram.js';

const lastEval = new Map();

/** Backup monitors that name an hour run once then wait for the next occurrence of it. */
function due(m, c) {
  const at = Number(c.at_hour);
  if (m.type === 'backup' && c.at_hour !== undefined && c.at_hour !== '' && Number.isInteger(at) && at >= 0 && at <= 23) {
    if (new Date().getHours() !== at) return false;
    return !lastEval.has(m.id) || now() - lastEval.get(m.id) > 36e5;
  }
  return now() - (lastEval.get(m.id) || 0) >= (+c.interval_sec || cfg.checkIntervalSec) * 1000;
}

/**
 * Due monitors run side by side, not one after another: a single slow check (an HTTP timeout,
 * or an auto-restart that waits RESTART_WAIT_SEC) used to hold every other monitor back for
 * that long. runMonitor() itself guarantees one check per monitor at a time, so a check that
 * outlives its interval is simply joined, never doubled.
 */
export async function tickChecks() {
  const jobs = [];
  for (const m of monitors(true)) {
    const c = monitorConfig(m);
    if (!due(m, c)) continue;
    lastEval.set(m.id, now());
    jobs.push(runMonitor(m).catch((e) => console.error(`[check ${m.id}]`, e.message)));
  }
  await Promise.all(jobs);
}

/** Run fn on an interval, but never start a round while the previous one is still going. */
function every(ms, label, fn) {
  let busy = false;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(`[${label}]`, e.message); } finally { busy = false; }
  }, ms);
}

/** A remote agent that stops pushing is itself an outage (a new one that has not reported yet is not). */
async function checkAgents() {
  const silence = Math.max(cfg.metricsIntervalSec * 4, 120) * 1000;
  for (const s of servers()) {
    if (s.is_local || !s.last_seen) continue;
    const late = now() - s.last_seen;
    await edge({
      key: `agent:${s.id}`, ok: late <= silence, serverId: s.id, kind: 'agent', title: `Agent silent: ${s.name}`,
      detail: late <= silence ? 'agent resumed' : `no metrics pushed for ${Math.round(late / 60000)}m`,
    });
  }
}

export function startScheduler() {
  const fast = Math.min(30, cfg.checkIntervalSec) * 1000;
  // Not wrapped in every(): overlapping ticks are safe (lastEval is set before any await and
  // runMonitor joins a check already in flight), and one long restart must not stall the rest.
  const a = setInterval(() => tickChecks().catch((e) => console.error('[checks]', e.message)), fast);
  const b = every(60e3, 'agents', checkAgents);
  const c = setInterval(() => maybeDailySummary(), 60e3);
  const d = cfg.securityEnabled ? every(Math.max(cfg.securityIntervalSec, 15) * 1000, 'security', scanSecurity) : null;
  [a, b, c, d].forEach((h) => h && h.unref());
  startBot();
  setTimeout(() => tickChecks().catch(() => {}), 2500).unref();
  if (d) setTimeout(() => scanSecurity().catch((e) => console.error('[security]', e.message)), 6000).unref();
  return { a, b, c, d };
}
