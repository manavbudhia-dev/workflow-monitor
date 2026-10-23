import { store, api } from '../api.js';
import { icon } from '../icons.js';
import { card } from '../components.js';
import { runAllNow, toast } from '../actions.js';
import { pushStatus, pushEnable, pushDisable } from '../pwa.js';
import { el, esc, setText, setHTML, clock, copy } from '../util.js';

const kv = (k, v) => `<div><span>${esc(k)}</span><span>${v}</span></div>`;

const ENV_KEYS = [
  ['PASSWORD', 'dashboard login password (default: admin)'],
  ['SESSION_SECRET', 'cookie signing key'],
  ['SESSION_HOURS', 'session lifetime, default 72'],
  ['PORT / BIND_HOST', 'HTTP listen address, default 0.0.0.0:4180'],
  ['PUBLIC_URL', 'links sent to Telegram'],
  ['DB_PATH', 'SQLite file location'],
  ['METRICS_INTERVAL_SEC', 'host sample cadence, default 30'],
  ['CHECK_INTERVAL_SEC', 'default monitor cadence, 60'],
  ['RETENTION_DAYS', 'history window, default 7'],
  ['CPU_WARN_PCT / MEM_WARN_PCT / DISK_WARN_PCT', 'resource alert thresholds'],
  ['LOAD_WARN_FACTOR / WARN_STREAK', 'load multiplier and how many samples must agree'],
  ['SSL_WARN_DAYS', 'TLS expiry warning window'],
  ['ALERT_COOLDOWN_MIN', 'repeat-alert suppression per incident'],
  ['TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS', 'alert delivery'],
  ['TELEGRAM_OWNER_IDS', 'who may run /restart'],
  ['DAILY_SUMMARY / SUMMARY_HOUR', 'daily Telegram recap'],
  ['AGENT_API_KEYS', 'optional pre-seeded agent keys'],
  ['N8N_URL / N8N_API_KEY', 'n8n defaults for monitors'],
  ['AI_PROVIDER / AI_MODEL / AI_API_KEY / AI_BASE_URL', 'root cause analysis'],
  ['RESTART_ENABLED', 'master switch for auto-restart, default on'],
  ['RESTART_ALLOW', 'the only commands auto-restart may run, separated by ";"'],
  ['RESTART_ALLOW_BINS / RESTART_ALLOW_VERBS', 'extra guard on the first two words of a whitelisted command'],
  ['RESTART_WAIT_SEC', 'pause between running a restart and re-checking, default 15'],
  ['RESTART_MAX_RETRIES / RESTART_COOLDOWN_MIN', 'defaults for monitors that leave the fields blank'],
  ['BACKUP_ENABLED', 'master switch for monitors of type backup, default on'],
  ['SECURITY_ENABLED / SECURITY_INTERVAL_SEC', 'ssh and port scanner, default on every 60s'],
  ['AUTH_LOG_SOURCE', '/var/log/auth.log, journalctl or journalctl:sshd'],
  ['SSH_FAILED_LIMIT / SSH_FAILED_WINDOW_MIN', 'brute-force rule, default 10 failures in 10 min'],
  ['SECURITY_COOLDOWN_MIN', 'repeat suppression per security alert class'],
  ['PORT_SCAN_ENABLED', 'diff ss -tuln against the saved baseline'],
  ['FAIL2BAN_JAILS', 'jails to read banned IPs from, empty disables fail2ban'],
  ['LOG_ENABLED', 'log viewer switch, default on'],
  ['LOG_SOURCES', 'whitelist: name:journal:unit, name:pm2:app or name:file:/path, separated by ";"'],
  ['LOG_MAX_LINES', 'biggest snapshot the viewer may ask for, default 1000'],
  ['LOG_STREAM_MAX', 'live tail streams allowed at once, default 2'],
  ['LOG_IDLE_MIN', 'minutes of silence before a tail closes itself, default 10'],
  ['LOG_POLL_MS', 'how often a file: source is checked for new bytes, default 1000'],
  ['VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY', 'web push keys — print a pair with node scripts/gen-vapid.mjs'],
  ['VAPID_SUBJECT', 'contact mailto:/https: the push service expects on every request'],
];

export function build(root) {
  const runtime = card({ id: 'setRuntime', title: 'Runtime', iconName: 'settings', body: '<div class="kvs" data-f=kv></div>' });
  const thresholds = card({
    id: 'setThresh', title: 'Alert thresholds', iconName: 'gauge',
    tools: '<span class="muted">warning lines used by the collectors</span>',
    body: '<div class="kvs" data-f=kv></div>',
  });
  const actions = card({
    id: 'setActions', title: 'Actions', iconName: 'zap',
    body: `<div class="row"><button class="btn primary" data-f=check>${icon('refresh', 15)} Run every check now</button>
      <button class="btn" data-f=reload>${icon('refresh', 15)} Reload data</button>
      <a class="btn" href="/api/logout" data-f=logout>${icon('logout', 15)} Sign out</a></div>
      <div class="note" style="margin-top:12px">Sign out revokes every session issued before now, on all browsers. Failed logins are throttled per IP: six attempts, then a ten minute lock.</div>`,
  });
  const envCard = card({
    id: 'setEnv', title: 'Environment (.env)', iconName: 'key',
    tools: '<span class="muted">read at boot — restart to apply</span>',
    body: `<div class="tbl-wrap"><table class="tbl"><tbody data-f=rows></tbody></table></div>
      <div class="copy-row" style="margin-top:12px"><input readonly data-f=tpl value=""><button class="btn sm" data-f=copy>${icon('copy', 13)} Copy template</button></div>
      <div class="note" style="margin-top:12px">Values are deliberately not shown here — this page only lists the keys the server reads, so a screenshot of the dashboard cannot leak a token.</div>`,
  });
  const pwa = card({
    id: 'setPwa', title: 'Phone app', iconName: 'wifi',
    tools: '<span class="muted" data-f=state>checking…</span>',
    body: `<div class="kvs" data-f=kv></div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" data-f=enable>${icon('bell', 14)} Enable push</button>
        <button class="btn sm" data-f=test>${icon('send', 14)} Send a test</button>
        <button class="btn sm ghost" data-f=disable>${icon('x', 14)} Unsubscribe this device</button>
      </div>
      <div class="note" style="margin-top:12px">Telegram stays the primary alert channel — push is only an extra ping on phones that subscribed here.
        Installing the app needs HTTPS (Caddy or Cloudflare in front of this port); localhost and 127.0.0.1 count as secure without a cert.</div>`,
  });
  const data = card({
    id: 'setData', title: 'Data', iconName: 'database',
    body: `<div class="kvs" data-f=kv></div>
      <div class="copy-row" style="margin-top:12px"><input readonly data-bak="" value=""><button class="btn sm" data-f=bakcopy>${icon('copy', 13)} Copy backup command</button></div>`,
  });

  const two = el('<div class="split"></div>');
  two.append(thresholds, actions);
  root.append(runtime, two, pwa, envCard, data);

  const rows = envCard.refs.body.querySelector('[data-f=rows]');
  rows.innerHTML = ENV_KEYS.map(([k, d]) => `<tr><td class="mono">${esc(k)}</td><td class="detail">${esc(d)}</td></tr>`).join('');
  const template = ENV_KEYS.flatMap(([k]) => k.split(' / ').map((key) => `${key}=`)).join('\n');
  envCard.refs.body.querySelector('[data-f=copy]').onclick = (e) => copy(template, e.currentTarget);
  const tplInput = envCard.refs.body.querySelector('[data-f=tpl]');
  tplInput.value = template;

  const bak = data.refs.body.querySelector('[data-bak]');
  const bakCmd = 'sqlite3 data/monitor.db ".backup backup.db"';
  bak.value = bakCmd;
  data.refs.body.querySelector('[data-f=bakcopy]').onclick = (e) => copy(bakCmd, e.currentTarget);

  actions.refs.body.querySelector('[data-f=check]').onclick = (e) => runAllNow(e.currentTarget);
  actions.refs.body.querySelector('[data-f=reload]').onclick = () => store.afterSave?.();
  const logout = actions.refs.body.querySelector('[data-f=logout]');
  logout.onclick = async (e) => {
    e.preventDefault();
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* still leave */ }
    location.href = '/login.html';
  };

  const pstate = pwa.refs.tools.querySelector('[data-f=state]');
  const pkv = pwa.refs.body.querySelector('[data-f=kv]');
  const pBtn = (n) => pwa.refs.body.querySelector(`[data-f=${n}]`);
  let push = null;

  async function pushPaint() {
    try { push = await pushStatus(); } catch (e) { push = { error: e.message }; }
    setHTML(pstate, push.error ? '<span class="t-red">push unavailable</span>'
      : `${push.ready ? 'VAPID keys found' : 'VAPID keys missing'} · ${push.subscribers} device${push.subscribers === 1 ? '' : 's'}`);
    setHTML(pkv,
      kv('Offline shell', push.supported ? 'cached by the service worker' : 'no service worker here (needs https or localhost)') +
      kv('This device', push.subscribed ? `subscribed · ${esc(push.endpoint_host || '')}` : 'not subscribed') +
      kv('Permission', esc(push.perm || 'unknown')) +
      (push.error ? kv('Push', esc(push.error)) : '') +
      (push.rows?.length ? kv('Devices seen', esc(push.rows.map((x) => x.host).join(', '))) : ''));
    pBtn('enable').disabled = !!push.subscribed || !!push.error;
    pBtn('disable').hidden = !push.subscribed;
    pBtn('test').disabled = !(push.subscribers > 0);
  }

  const withPush = async (fn, say) => {
    try { say(await fn()); } catch (e) { toast(e.message, 'err'); }
    await pushPaint();
  };
  pBtn('enable').onclick = () => withPush(pushEnable, (r) => `Subscribed${r.host ? ` via ${r.host}` : ''}`);
  pBtn('disable').onclick = () => withPush(pushDisable, () => 'This device was unsubscribed');
  pBtn('test').onclick = () => withPush(() => api('/push/test', { method: 'POST', body: {} }), (r) => (
    r.sent ? `Ping sent to ${r.sent} device${r.sent === 1 ? '' : 's'}${r.pruned ? `, ${r.pruned} pruned` : ''}`
      : r.skipped ? `Not sent: ${r.skipped}` : `Failed: ${(r.errors || [])[0] || 'no subscribers'}`));
  pushPaint();

  function update() {
    const s = store.summary;
    setHTML(runtime.refs.body.querySelector('[data-f=kv]'),
      kv('Public URL', `<a class="link" href="${esc(s.public_url)}" target="_blank" rel="noopener">${esc(s.public_url)}</a>`) +
      kv('Platform', esc(s.host)) +
      kv('Server time', clock(s.now)) +
      kv('Metric cadence', `${s.intervals.metrics}s`) +
      kv('Check cadence', `${s.intervals.checks}s (per-monitor override possible)`) +
      kv('Monitors', `${s.counts.enabled} enabled · ${s.counts.disabled} paused`) +
      kv('Servers', String(s.servers.length)) +
      kv('Open incidents', String(s.counts.open_incidents)));
    setHTML(thresholds.refs.body.querySelector('[data-f=kv]'),
      kv('CPU warning', `${s.thresholds.cpu}%`) +
      kv('Memory warning', `${s.thresholds.mem}%`) +
      kv('Disk warning', `${s.thresholds.disk}%`) +
      kv('TLS expiry warning', `${s.thresholds.ssl_days} days`) +
      kv('Agent silence', 'incident when an agent misses four pushes'));
    setHTML(data.refs.body.querySelector('[data-f=kv]'),
      kv('Database', 'SQLite in WAL mode, one file under data/') +
      kv('Backup', 'copy the file while the server runs, or use the command below') +
      kv('Retention', 'checks, metrics and resolved incidents older than RETENTION_DAYS (default 7) are pruned hourly'));
  }

  update();
  return { update };
}
