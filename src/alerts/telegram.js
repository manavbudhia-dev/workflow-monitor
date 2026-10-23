import { cfg } from '../config.js';
import { q, get, now, monitors, setting, setSetting } from '../db.js';

const dur = (ms) => {
  if (ms === null || ms === undefined) return '-';
  const m = Math.floor(ms / 6e4);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

const latest = () => q(`SELECT s.id, s.name, s.is_local, s.last_seen, m.cpu, m.mem, m.disk, m.load, m.uptime, m.created_at AS metric_at
  FROM servers s
  LEFT JOIN metrics m ON m.id = (SELECT id FROM metrics WHERE server_id = s.id ORDER BY id DESC LIMIT 1)
  ORDER BY s.id`);

export function statusText() {
  const on = monitors(true);
  const down = on.filter((m) => m.last_ok === 0);
  const pending = on.filter((m) => m.last_ok === null || m.last_ok === undefined);
  const open = q('SELECT COUNT(*) n FROM incidents WHERE state=?', 'open')[0].n;
  const lines = [
    `📊 *workflow-monitor*`,
    `${on.length} monitors: ${on.length - down.length - pending.length} up, ${down.length} down${pending.length ? `, ${pending.length} pending` : ''} · ${open} open incident${open === 1 ? '' : 's'}`,
    '',
  ];
  for (const s of latest()) {
    if (s.cpu === null) { lines.push(`⚪ *${s.name}* — no metrics yet`); continue; }
    const mins = Math.round((now() - (s.metric_at || s.last_seen)) / 60000);
    lines.push(`${mins > 5 ? '⚪' : '🟢'} *${s.name}* — cpu ${s.cpu}% · ram ${s.mem}% · disk ${s.disk}% · load ${s.load} · up ${dur((s.uptime || 0) * 1000)} (${mins}m ago)`);
  }
  if (down.length) {
    lines.push('', '🔴 *Down:*');
    for (const m of down) lines.push(`• ${m.name} (${m.type}) — ${m.last_detail || 'failing'}${m.down_since ? ` for ${dur(now() - m.down_since)}` : ''}`);
  }
  return lines.join('\n');
}

export function incidentsText(limit = 5) {
  const rows = q('SELECT i.*, COALESCE(m.name, i.title) AS label FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id ORDER BY i.id DESC LIMIT ?', limit);
  if (!rows.length) return '✅ No incidents recorded yet.';
  return ['📋 *Recent incidents*', ''].concat(rows.map((i) => {
    const state = i.state === 'open' ? `🔴 open ${dur(now() - i.started_at)}` : `🟢 resolved ${dur(now() - (i.resolved_at || i.started_at))} ago`;
    const ai = (i.ai || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('['));
    return `*#${i.id} ${i.label}* (${i.kind}) — ${state}\n   ${String(i.detail || '').replace(/[*_`\[\]]/g, '').slice(0, 160)}${ai ? `\n   💡 ${ai.replace(/[*_`]/g, '').slice(0, 160)}` : ''}`;
  })).join('\n');
}

export function summaryText() {
  const day = now() - 864e5;
  const ms = monitors(true);
  const per = q('SELECT monitor_id, COUNT(*) total, SUM(ok) good, MAX(ms) worst FROM checks WHERE created_at > ? GROUP BY monitor_id', day);
  const failing = per.filter((p) => p.good < p.total);
  const lines = [`🌅 *Daily summary*`, `${ms.length} monitors enabled · ${failing.length} saw failures in 24h`, ''];
  for (const s of latest()) {
    if (s.cpu === null) continue;
    const peak = get('SELECT MAX(cpu) c, MAX(mem) m, MAX(disk) d FROM metrics WHERE server_id=? AND created_at > ?', s.id, day) || {};
    lines.push(`*${s.name}* — now ${s.cpu}% cpu / ${s.mem}% ram / ${s.disk}% disk · 24h peak ${(peak.c ?? 0).toFixed(0)}% / ${(peak.m ?? 0).toFixed(0)}% / ${(peak.d ?? 0).toFixed(0)}%`);
  }
  lines.push('', `Incidents: ${q('SELECT COUNT(*) n FROM incidents WHERE started_at > ?', day)[0].n} opened in 24h, ${q('SELECT COUNT(*) n FROM incidents WHERE state=?', 'open')[0].n} still open`);
  for (const p of failing.sort((a, b) => a.good / a.total - b.good / b.total).slice(0, 8)) {
    const m = get('SELECT name, type FROM monitors WHERE id=?', p.monitor_id);
    lines.push(`• ${m?.name ?? p.monitor_id} (${m?.type ?? '?'}) — ${Math.round((p.good / p.total) * 100)}% ok over ${p.total} checks, slowest ${p.worst}ms`);
  }
  return lines.join('\n');
}

let bot = null;
const enabled = () => !!cfg.telegramToken && cfg.telegramChats.length > 0;
export const telegramInfo = () => ({ configured: enabled(), polling: !!bot, chats: cfg.telegramChats.length, owners: cfg.telegramOwners.length });

async function ensure() {
  if (bot) return bot;
  const { Bot } = await import('node-telegram-bot-api');
  bot = new Bot(cfg.telegramToken);
  wire(bot);
  bot.catch((err) => console.error('[telegram handler]', err?.message || err));
  bot.startPolling().catch((e) => { console.error('[telegram polling]', e.message); bot = null; });
  return bot;
}

async function deliver(b, chat_id, text) {
  const base = { chat_id, text, link_preview_options: { is_disabled: true } };
  try { await b.api.sendMessage({ ...base, parse_mode: 'Markdown' }); }
  catch (e) {
    if (!/parse|entity|markdown/i.test(String(e.message))) throw e;
    await b.api.sendMessage(base);
  }
}

export async function send(text) {
  if (!enabled()) { console.log('[telegram] not configured — alert dropped:\n' + text); return false; }
  try {
    const b = await ensure();
    for (const id of cfg.telegramChats) await deliver(b, String(id), text);
    return true;
  } catch (e) {
    console.error('[telegram]', e.message);
    return false;
  }
}

const isOwner = (user) => !cfg.telegramOwners.length || cfg.telegramOwners.some((id) => String(id) === String(user?.id));
const answer = (ctx, text) => ctx.reply(text, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } })
  .catch(() => ctx.reply(text).catch((e) => console.error('[telegram reply]', e.message)));

function wire(b) {
  b.command('status', (ctx) => answer(ctx, statusText()));
  b.command('incidents', (ctx) => answer(ctx, incidentsText(Math.min(parseInt(ctx.match, 10) || 5, 20))));
  b.command('summary', (ctx) => answer(ctx, summaryText()));
  b.command('help', (ctx) => ctx.reply('Commands:\n/status — current state\n/incidents [n] — last incidents\n/summary — 24h digest\n/check — run all monitors now\n/restart <unit> | pm2:<app> — restart (owners only)'));
  b.command('check', async (ctx) => {
    if (!isOwner(ctx.from)) return ctx.reply('⛔ Not an owner id.');
    const { runAll } = await import('../collectors/checks.js');
    const res = await runAll();
    return ctx.reply(`✅ Ran ${res.length} checks\n${res.map((r) => `${r.skip ? '⚪' : r.ok ? '🟢' : '🔴'} ${r.name}${r.skip ? ` (${r.skip})` : r.ok ? '' : ` — ${r.detail}`}`).join('\n') || 'no monitors configured yet'}`);
  });
  b.command('restart', async (ctx) => {
    const svc = String(ctx.match || '').trim();
    if (!svc) return ctx.reply('Usage: /restart n8n.service  or  /restart pm2:api');
    if (!isOwner(ctx.from)) return answer(ctx, '⛔ Not an owner id, /restart refused.');
    if (process.platform !== 'linux') return answer(ctx, `⚠️ /restart only works on the Linux server (this host runs ${process.platform}).`);
    if (!/^[A-Za-z0-9@._:+-]+$/.test(svc.replace(/^pm2:/, ''))) return answer(ctx, '⛔ Service name may only contain letters, digits and @ . _ + - :');
    const { cap, sys } = await import('../shell.js');
    const who = ctx.from?.username || ctx.from?.id;
    try {
      const isPm2 = svc.startsWith('pm2:');
      const out = isPm2 ? await cap('pm2', ['restart', svc.slice(4)]) : await sys('systemctl', ['restart', svc]);
      const state = isPm2 ? '' : await sys('systemctl', ['is-active', svc]).catch(() => '?');
      return ctx.reply(`♻️ Restarted ${isPm2 ? `pm2 app "${svc.slice(4)}"` : svc} by @${who}\n${state ? `is-active: ${state}\n` : ''}${(out || '(no output)').slice(-500)}`);
    } catch (e) { return ctx.reply(`❌ Restart ${svc} failed: ${e.message}`); }
  });
}

/** Called every minute by the scheduler; sends the digest once at SUMMARY_HOUR. */
export function maybeDailySummary() {
  if (!cfg.dailySummary || !enabled()) return;
  const d = new Date();
  if (d.getHours() !== cfg.summaryHour) return;
  const today = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (setting('last_summary', '') === today) return;
  setSetting('last_summary', today);
  send(summaryText()).catch(() => {});
}
