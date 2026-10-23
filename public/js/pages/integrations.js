import { store, api } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../actions.js';
import { el, esc, setText, setHTML, ago, copy } from '../util.js';

/** Small helper: a labelled row inside a dcard. */
const kv = (label, value) => `<div><span>${esc(label)}</span><span>${value}</span></div>`;

export function build(root) {
  const grid = el('<div class="cards"></div>');
  const tg = el(`<div class="dcard"><header>${icon('send', 18)}<b>Telegram alerts</b><span class="badge" data-f=state></span></header>
    <div class="kvs" data-f=kv></div>
    <div class="row"><button class="btn primary sm" data-f=test>${icon('send', 14)} Send test message</button><span class="spacer"></span><span class="stamp" data-f=out></span></div>
    <div class="note">Token and chat ids are read from <span class="kv-code">TELEGRAM_BOT_TOKEN</span> / <span class="kv-code">TELEGRAM_CHAT_IDS</span> at boot; the dashboard never shows them. <span class="kv-code">TELEGRAM_OWNER_IDS</span> gates the /restart command.</div></div>`);
  const ai = el(`<div class="dcard"><header>${icon('sparkles', 18)}<b>LLM root cause</b><span class="badge" data-f=state></span></header>
    <div class="kvs" data-f=kv></div>
    <div class="row"><button class="btn primary sm" data-f=test>${icon('zap', 14)} Run self test</button><span class="spacer"></span><span class="stamp" data-f=out></span></div>
    <div class="note">Configured with <span class="kv-code">AI_PROVIDER</span>, <span class="kv-code">AI_API_KEY</span>, <span class="kv-code">AI_MODEL</span> and optional <span class="kv-code">AI_BASE_URL</span>. Log text is secret-scrubbed before it leaves the box.</div></div>`);
  const n8n = el(`<div class="dcard"><header>${icon('branch', 18)}<b>n8n</b><span class="badge" data-f=state></span></header>
    <div class="kvs" data-f=kv></div><div data-f=list></div>
    <div class="note">Blank URL or key on a monitor falls back to <span class="kv-code">N8N_URL</span> / <span class="kv-code">N8N_API_KEY</span>. Keys stay server-side.</div></div>`);
  const ping = el(`<div class="dcard"><header>${icon('clock', 18)}<b>Cron heartbeat</b><span class="badge" data-f=state></span></header>
    <div class="kvs" data-f=kv></div><div class="kvs" data-f=list></div>
    <div class="note">Anyone holding a ping URL can mark that job healthy, so treat them like credentials and keep this page behind the login.</div></div>`);
  grid.append(tg, ai, n8n, ping);

  const cardEl = el(`<div class="note">Everything here is read-only: integrations are configured in <span class="kv-code">.env</span> and applied on restart (<span class="kv-code">pm2 restart workflow-monitor</span> or <span class="kv-code">systemctl restart workflow-monitor</span>).
    Monitors, servers and incidents are managed from their own pages; this page only proves the outbound channels work.</div>`);
  root.append(grid, cardEl);

  const state = (node, ok, yes, no) => {
    const b = node.querySelector('[data-f=state]');
    setText(b, ok ? yes : no);
    b.className = `badge ${ok ? '' : 'plain'}`;
    b.style.color = ok ? 'var(--green)' : 'var(--dim)';
  };

  async function test(node, path, label) {
    const out = node.querySelector('[data-f=out]');
    const btn = node.querySelector('[data-f=test]');
    btn.disabled = true;
    setHTML(out, 'sending…');
    try {
      const r = await api(path, { method: 'POST', body: {} });
      const msg = r.reply ? String(r.reply).slice(0, 90) : r.sent ? 'delivered' : r.note || 'not sent';
      setHTML(out, `${r.sent === false ? '<b class="t-red">' : '<b class="t-green">'}${esc(label)}: ${esc(msg)}</b>`);
      toast(r.sent === false ? msg : `${label} ok`, r.sent === false ? 'err' : '');
    } catch (e) {
      setHTML(out, `<b class="t-red">${esc(label)}: ${esc(e.message)}</b>`);
      toast(e.message, 'err');
    } finally { btn.disabled = false; }
  }

  tg.querySelector('[data-f=test]').onclick = () => test(tg, '/selftest/telegram', 'Telegram');
  ai.querySelector('[data-f=test]').onclick = () => test(ai, '/selftest/ai', 'AI');

  function update() {
    const s = store.summary;
    const mons = s.monitors;

    state(tg, s.telegram.configured, 'configured', 'not configured');
    setHTML(tg.querySelector('[data-f=kv]'),
      kv('Bot token', s.telegram.configured ? 'loaded from .env' : 'missing') +
      kv('Polling', s.telegram.polling ? 'running' : 'idle') +
      kv('Chat ids', String(s.telegram.chats)) +
      kv('Owner ids', s.telegram.owners ? String(s.telegram.owners) : 'everyone in the chat list'));

    state(ai, s.ai.ready, s.ai.provider, 'no key');
    setHTML(ai.querySelector('[data-f=kv]'),
      kv('Provider', esc(s.ai.provider)) +
      kv('API key', s.ai.ready ? 'loaded from .env' : 'missing') +
      kv('Model', 'shown by the self test') +
      kv('Trigger', 'on every monitor incident'));

    const n8ns = mons.filter((m) => m.type === 'n8n');
    state(n8n, n8ns.length > 0, `${n8ns.length} monitor${n8ns.length === 1 ? '' : 's'}`, 'unused');
    setHTML(n8n.querySelector('[data-f=kv]'),
      kv('Monitors', String(n8ns.length)) +
      kv('Own base URL', String(n8ns.filter((m) => m.config.url).length)) +
      kv('Own API key', String(n8ns.filter((m) => m.config.api_key).length)) +
      kv('Env fallback', 'N8N_URL / N8N_API_KEY'));
    setHTML(n8n.querySelector('[data-f=list]'), n8ns.length ? n8ns.map((m) =>
      `<div class="kvs"><div><span>${esc(m.name)}</span><span class="mono">${esc(m.config.url || 'from .env')}</span></div></div>`).join('') : '');

    const pings = mons.filter((m) => m.type === 'cron_heartbeat');
    state(ping, pings.length > 0, `${pings.length} job${pings.length === 1 ? '' : 's'}`, 'unused');
    setHTML(ping.querySelector('[data-f=kv]'),
      kv('Heartbeat monitors', String(pings.length)) +
      kv('Missing a ping', pings.filter((m) => m.ok === false).length ? `<b class="t-red">${pings.filter((m) => m.ok === false).length}</b>` : 'none') +
      kv('Last check', pings.length ? ago(Math.max(...pings.map((m) => m.last_check || 0))) : '—'));
    const list = ping.querySelector('[data-f=list]');
    if (pings.length !== list.children.length) {
      list.replaceChildren(...pings.map((m) => el(`<div class="copy-row"><input readonly value="${esc(m.ping_url || '')}"><button type="button" class="btn sm">${icon('copy', 13)} Copy</button></div>`)));
      list.querySelectorAll('button').forEach((b, i) => { b.onclick = (e) => copy(pings[i].ping_url, e.currentTarget); });
    } else {
      list.querySelectorAll('input').forEach((inp, i) => { if (inp.value !== pings[i].ping_url) inp.value = pings[i].ping_url || ''; });
    }
  }

  update();
  return { update };
}
