/**
 * Auto-restart. A command only ever runs when it is listed verbatim in RESTART_ALLOW,
 * its first word is an allowed binary and its second an allowed verb; it is then handed
 * to execFile, so shell metacharacters in a monitor config can never be interpreted.
 */
import { cfg } from '../config.js';
import { q, get, run, now, monitorConfig, addCheck, updateMonitorAfterCheck } from '../db.js';
import { send } from '../alerts/telegram.js';
import { sys } from '../shell.js';

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));
const num = (v, d) => { const n = +v; return Number.isFinite(n) && n >= 0 ? n : d; };

/** Resolve a monitor-supplied command against the .env whitelist. */
export function checkCommand(cmd) {
  const c = norm(cmd);
  if (!c) return { ok: false, why: 'no restart command set on the monitor' };
  if (/[$`|;&<>]/.test(c)) return { ok: false, why: 'command contains shell characters' };
  if (!cfg.restartAllow.includes(c)) return { ok: false, why: 'command is not in RESTART_ALLOW' };
  const toks = c.split(' ');
  if (!cfg.restartBins.includes(toks[0])) return { ok: false, why: `${toks[0]} is not an allowed binary` };
  if (!cfg.restartVerbs.includes(toks[1])) return { ok: false, why: `${toks[1]} is not an allowed verb` };
  return { ok: true, cmd: c, bin: toks[0], args: toks.slice(1) };
}

function settings(m) {
  const c = monitorConfig(m);
  const max = num(c.max_retries, cfg.restartRetries);
  return {
    on: truthy(c.auto_restart),
    cmd: norm(c.restart_command),
    max: Math.min(Math.max(max || 1, 1), 10),
    cooldownMin: Math.min(num(c.cooldown_minutes, cfg.restartCooldownMin), 1440),
  };
}

/** Consecutive failures ending with the check we just recorded. */
const failedTwice = (id) => {
  const rows = q('SELECT ok FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 2', id);
  return rows.length >= 2 && rows.every((r) => !r.ok);
};

const logRow = (m, r) => run(
  'INSERT INTO restart_log(monitor_id, incident_id, command, attempt, ok, exit_code, output, result, started_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  m.id, r.incident_id ?? null, r.command ?? '', r.attempt ?? 0, r.ok ? 1 : 0, r.exit_code ?? null,
  String(r.output || '').slice(0, 2000), r.result, r.started_at ?? now(), r.finished_at ?? now(),
);

const busy = new Set();

/**
 * Called by runMonitor after a failing check has been recorded.
 * `recheck` re-runs the raw check function so we can grade the restart without recursing.
 */
export async function maybeRestart(m, out, recheck) {
  if (!cfg.restartEnabled || !out || out.ok || busy.has(m.id)) return null;
  const s = settings(m);
  if (!s.on || !s.cmd) return null;
  if (!failedTwice(m.id)) return null;

  const since = m.down_since || now();
  const prev = get("SELECT output FROM restart_log WHERE monitor_id=? AND started_at>=? AND result='gave_up' LIMIT 1", m.id, since);
  if (prev) return { skipped: 'gave_up' };
  const last = get('SELECT finished_at FROM restart_log WHERE monitor_id=? AND started_at>=? ORDER BY id DESC LIMIT 1', m.id, since);
  if (last && now() - last.finished_at < s.cooldownMin * 6e4) return { skipped: 'cooldown' };

  busy.add(m.id);
  try {
    const attempts = get("SELECT COUNT(*) n FROM restart_log WHERE monitor_id=? AND started_at>=? AND result<>'blocked'", m.id, since).n;
    const inc = get('SELECT id, ai FROM incidents WHERE monitor_id=? AND state=? ORDER BY id DESC LIMIT 1', m.id, 'open');
    const v = checkCommand(s.cmd);
    if (!v.ok) {
      const already = get("SELECT id FROM restart_log WHERE monitor_id=? AND started_at>=? AND result='blocked' LIMIT 1", m.id, since);
      if (already) return { blocked: v.why, notified: false };
      logRow(m, { incident_id: inc?.id, command: s.cmd, attempt: attempts + 1, ok: false, result: 'blocked', output: `refused: ${v.why}`, started_at: now() });
      await send(`⛔ *AUTO-RESTART REFUSED* ${m.name}\n${v.why}\n\nAllowed commands (RESTART_ALLOW):\n${cfg.restartAllow.map((x) => `  ${x}`).join('\n') || '  (none)'}`);
      return { blocked: v.why };
    }

    const started = now();
    let code = null, text = '';
    try { text = await sys(v.bin, v.args, 25000); code = 0; } catch (e) {
      code = typeof e.code === 'number' ? e.code : null;
      text = `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message;
    }
    await sleep(cfg.restartWaitSec * 1000);
    const re = await recheck().catch((e) => ({ ok: false, detail: `${e.name}: ${e.message}` }));
    const recovered = !!re.ok && !re.skip;
    addCheck(m.id, recovered, re.ms ?? 0, `re-check after restart: ${re.detail}`);
    updateMonitorAfterCheck(m, recovered, re.ms ?? 0, `after restart #${attempts + 1}: ${re.detail}`, true);

    const attempt = attempts + 1;
    const output = `${text ? `${text}\n` : ''}re-check: ${re.detail}`;
    if (recovered) {
      logRow(m, { incident_id: inc?.id, command: v.cmd, attempt, ok: true, exit_code: code, result: 'recovered', output, started_at: started, finished_at: now() });
      await send(`🔁 *RESTARTED OK* ${m.name}\nRan: ${v.cmd}\nBack up after attempt ${attempt}\n${re.detail}`);
      return { recovered: true, attempt };
    }
    const gaveUp = attempt >= s.max;
    logRow(m, { incident_id: inc?.id, command: v.cmd, attempt, ok: false, exit_code: code, result: gaveUp ? 'gave_up' : 'still_down', output, started_at: started, finished_at: now() });
    if (!gaveUp) return { recovered: false, attempt, nextRetryInMin: s.cooldownMin };
    const ai = inc?.ai ? `\n\nAI: ${inc.ai}` : '\n\nAI root cause not available yet.';
    await send(`🛠 *NEEDS MANUAL FIX* ${m.name}\n${v.cmd}\nStill down after ${attempt} restart attempt${attempt === 1 ? '' : 's'}.\n${re.detail}${ai}`);
    return { recovered: false, attempt, gaveUp: true };
  } finally {
    busy.delete(m.id);
  }
}

export const restartsFor = (monitorId, limit = 20) =>
  q('SELECT * FROM restart_log WHERE monitor_id=? ORDER BY id DESC LIMIT ?', Number(monitorId), Math.min(+limit || 20, 100));

export const recentRestarts = (limit = 50) =>
  q(`SELECT r.*, m.name AS monitor FROM restart_log r LEFT JOIN monitors m ON m.id = r.monitor_id ORDER BY r.id DESC LIMIT ?`, Math.min(+limit || 50, 200));

export const whitelistInfo = () => ({
  enabled: cfg.restartEnabled,
  allow: cfg.restartAllow,
  bins: cfg.restartBins,
  verbs: cfg.restartVerbs,
  wait_sec: cfg.restartWaitSec,
  defaults: { max_retries: cfg.restartRetries, cooldown_minutes: cfg.restartCooldownMin },
});
