/** Security page — ssh activity, attacking IPs, listening ports and fail2ban bans. */
import { store, api, securityStats } from '../api.js';
import { icon } from '../icons.js';
import { card, statCard, setTextSlot, setHTMLSlot } from '../components.js';
import { toast } from '../actions.js';
import { el, esc, syncList, setText, setHTML, ago, dayTime } from '../util.js';

const KIND = {
  ssh_fail: ['failed', 'down'], ssh_ok: ['accepted', 'up'], ssh_root: ['root login', 'down'],
  brute: ['brute force', 'down'], new_ip: ['new login IP', 'degraded'], root: ['root login', 'down'],
  port_new: ['new port', 'degraded'], port_gone: ['port closed', 'pending'], port_open: ['listening', 'up'], banned: ['banned', 'down'],
};
const kindBadge = (k) => {
  const [label, s] = KIND[k] || [k, 'pending'];
  return `<span class="stat ${s}"><span class="dot ${s}"></span>${esc(label)}</span>`;
};

const loginRow = () => el('<tr><td data-f=kind data-l="Event"></td><td class="mon" data-f=ip></td><td data-f=user data-l="User"></td><td class="detail" data-f=detail data-l="Detail"></td><td class="muted" data-f=when data-l="Seen"></td></tr>');
const alertRow = () => el('<tr><td data-f=kind data-l="Alert"></td><td class="mon" data-f=ip></td><td class="detail" data-f=detail data-l="Detail"></td><td class="muted" data-f=when data-l="Seen"></td></tr>');
const ipRow = () => el('<tr><td class="mon" data-f=ip></td><td class="num" data-f=n data-l="Failures 7d"></td><td class="muted" data-f=last data-l="Last seen"></td></tr>');
const portRow = () => el('<tr><td data-f=proto data-l="Proto"></td><td class="mon" data-f=addr></td><td data-f=state data-l="State"></td><td class="muted" data-f=first data-l="First seen"></td></tr>');
const jailRow = () => el('<div class="dcard"><header><span class="dot up"></span><b data-f=jail></b><span data-f=count></span></header><div class="hint" data-f=ips></div></div>');

export function build(root) {
  const stats = el('<div class="grid-4"></div>');
  const cards = {
    fails: statCard({ key: 'fails', label: 'Failed logins 24h', tone: 'red', iconName: 'key' }),
    attacker: statCard({ key: 'attacker', label: 'Top attacker', tone: 'purple', iconName: 'alert' }),
    ports: statCard({ key: 'ports', label: 'Listening ports', tone: 'blue', iconName: 'wifi' }),
    bans: statCard({ key: 'bans', label: 'Banned by fail2ban', tone: 'green', iconName: 'shield' }),
  };
  stats.append(cards.fails, cards.attacker, cards.ports, cards.bans);

  const logCard = card({
    id: 'secLogins', title: 'Recent ssh activity', iconName: 'eye',
    tools: '<button class="btn sm" data-f=scan>' + icon('refresh', 14) + ' Scan now</button>',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Event</th><th>Source IP</th><th>User</th><th>Detail</th><th>Seen</th></tr></thead>
      <tbody data-f=body></tbody></table></div><div class="empty" data-f=empty hidden></div>`,
  });
  const ipCard = card({
    id: 'secIps', title: 'Top attacking IPs', iconName: 'alert',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>IP</th><th class="num">Failures 7d</th><th>Last seen</th></tr></thead>
      <tbody data-f=body></tbody></table></div><div class="empty" data-f=empty hidden></div>`,
  });
  const portCard = card({
    id: 'secPorts', title: 'Listening ports', iconName: 'wifi',
    tools: '<button class="btn sm" data-f=reseed>' + icon('check', 14) + ' Set current as baseline</button>',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Proto</th><th>Address</th><th>State</th><th>First seen</th></tr></thead>
      <tbody data-f=body></tbody></table></div><div class="empty" data-f=empty hidden></div>`,
  });
  const alertCard = card({
    id: 'secAlerts', title: 'Security alerts sent', iconName: 'send',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Alert</th><th>Source</th><th>Detail</th><th>Seen</th></tr></thead>
      <tbody data-f=body></tbody></table></div><div class="empty" data-f=empty hidden></div>`,
  });
  const banCard = card({ id: 'secBans', title: 'fail2ban bans', iconName: 'shield', body: '<div class="cards" data-f=body></div>' });
  const note = el(`<div class="note">Reads <span class="kv-code" data-f=src>—</span> every <span data-f=every>60</span>s on the hub box only.
    Alerts repeat at most once every <span data-f=cool>30</span> minutes per IP or port. The service user needs the
    <span class="kv-code">adm</span> group for /var/log/auth.log and the sudoers line in the README for ss, journalctl and fail2ban-client.</div>`);
  const split = el('<div class="split"></div>');
  split.append(logCard, ipCard);
  const split2 = el('<div class="split"></div>');
  split2.append(portCard, alertCard);
  root.append(stats, split, split2, banCard, note);

  const r = (card_, sel) => card_.refs.body.querySelector(sel);
  const refs = {
    scan: logCard.refs.tools.querySelector('[data-f=scan]'),
    reseed: portCard.refs.tools.querySelector('[data-f=reseed]'),
    logins: r(logCard, '[data-f=body]'), loginsEmpty: r(logCard, '[data-f=empty]'),
    ips: r(ipCard, '[data-f=body]'), ipsEmpty: r(ipCard, '[data-f=empty]'),
    ports: r(portCard, '[data-f=body]'), portsEmpty: r(portCard, '[data-f=empty]'),
    alerts: r(alertCard, '[data-f=body]'), alertsEmpty: r(alertCard, '[data-f=empty]'),
    jails: r(banCard, '[data-f=body]'),
    src: note.querySelector('[data-f=src]'), every: note.querySelector('[data-f=every]'), cool: note.querySelector('[data-f=cool]'),
  };

  refs.scan.onclick = async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api('/security/scan', { method: 'POST', body: {} });
      toast('Security scan finished');
      await store.afterSave?.();
    } catch (err) { toast(err.message, 'err'); } finally { e.currentTarget.disabled = false; }
  };
  refs.reseed.onclick = async () => {
    if (!confirm('Accept the ports listening right now as the new baseline?')) return;
    try {
      await api('/security/reseed', { method: 'POST', body: {} });
      toast('Baseline cleared — the next scan re-seeds it');
      store.afterSave?.();
    } catch (e) { toast(e.message, 'err'); }
  };

  const empty = (node, txt) => (node.hidden = false, setText(node, txt));

  function update() {
    const s = store.security;
    const sst = securityStats();
    if (!s) {
      setTextSlot(cards.fails, 'value', '—');
      return;
    }
    setText(refs.src, s.source);
    setText(refs.every, String(s.interval_sec));
    setText(refs.cool, String(s.rules.cooldown_min));

    setTextSlot(cards.fails, 'value', s.enabled ? String(sst.failures) : 'off');
    setHTMLSlot(cards.fails, 'foot', `<div class="delta"><span class="dim">${s.rules.failed_limit}+ from one IP in ${s.rules.window_min} min alerts</span></div>`);
    setTextSlot(cards.attacker, 'value', sst.top ? String(sst.top) : '0');
    setHTMLSlot(cards.attacker, 'foot', `<div class="delta"><span class="dim">${esc(sst.attacks[0]?.ip || 'no failures recorded')}</span></div>`);
    setTextSlot(cards.ports, 'value', String(sst.ports));
    setHTMLSlot(cards.ports, 'foot', `<div class="delta"><span class="dim">${s.rules.port_scan ? 'ss -tuln diffed against the baseline' : 'port scan disabled'}</span></div>`);
    setTextSlot(cards.bans, 'value', sst.banned ? String(sst.banned) : (s.bans?.jails?.length ? '0' : '—'));
    setHTMLSlot(cards.bans, 'foot', `<div class="delta"><span class="dim">${esc(s.bans?.jails?.length ? s.bans.jails.map((j) => j.jail).join(', ') : 'FAIL2BAN_JAILS is empty')}</span></div>`);

    refs.loginsEmpty.hidden = true;
    syncList(refs.logins, s.logins || [], (x) => x.id, loginRow, (node, x) => {
      setHTML(node.querySelector('[data-f=kind]'), kindBadge(x.kind));
      setText(node.querySelector('[data-f=ip]'), x.ip || '—');
      setText(node.querySelector('[data-f=user]'), x.user || '—');
      setText(node.querySelector('[data-f=detail]'), x.detail);
      setText(node.querySelector('[data-f=when]'), dayTime(x.created_at));
    });
    if (!(s.logins || []).length) empty(refs.loginsEmpty, s.enabled ? 'Nothing parsed yet — the scanner only reads lines written after it started.' : 'Security scanning is disabled (SECURITY_ENABLED=false).');

    refs.ipsEmpty.hidden = true;
    syncList(refs.ips, s.top_ips || [], (x) => x.ip, ipRow, (node, x) => {
      setText(node.querySelector('[data-f=ip]'), x.ip);
      setText(node.querySelector('[data-f=n]'), String(x.n));
      setText(node.querySelector('[data-f=last]'), ago(x.last_seen));
    });
    if (!(s.top_ips || []).length) empty(refs.ipsEmpty, 'No failed logins recorded in the last 7 days.');

    refs.portsEmpty.hidden = true;
    syncList(refs.ports, s.ports || [], (x) => `${x.proto}|${x.addr}|${x.port}`, portRow, (node, p) => {
      setHTML(node.querySelector('[data-f=proto]'), `<span class="badge">${p.proto}</span>`);
      setText(node.querySelector('[data-f=addr]'), `${p.addr}:${p.port}`);
      setHTML(node.querySelector('[data-f=state]'), kindBadge(p.state === 'open' ? 'port_open' : 'port_gone'));
      setText(node.querySelector('[data-f=first]'), dayTime(p.first_seen));
      node.classList.toggle('warn', p.state !== 'open');
    });
    if (!(s.ports || []).length) empty(refs.portsEmpty, 'No baseline yet — the hub runs ss -tuln on its next scan (Linux only).');

    refs.alertsEmpty.hidden = true;
    syncList(refs.alerts, s.alerts || [], (x) => x.id, alertRow, (node, a) => {
      setHTML(node.querySelector('[data-f=kind]'), kindBadge(a.kind));
      setText(node.querySelector('[data-f=ip]'), a.ip || a.user || '—');
      setText(node.querySelector('[data-f=detail]'), a.detail);
      setText(node.querySelector('[data-f=when]'), ago(a.created_at));
    });
    if (!(s.alerts || []).length) empty(refs.alertsEmpty, 'No security alert has fired yet.');

    const jails = s.bans?.jails || [];
    syncList(refs.jails, jails, (j) => j.jail, jailRow, (node, j) => {
      setText(node.querySelector('[data-f=jail]'), j.jail);
      setHTML(node.querySelector('[data-f=count]'), `<span class="badge${j.banned ? '' : ' plain'}">${j.error ? esc(j.error) : `${j.banned} banned`}</span>`);
      setText(node.querySelector('[data-f=ips]'), j.ips?.length ? j.ips.join(' · ') : 'none right now');
      node.querySelector('.dot').className = `dot ${j.error ? 'pending' : j.banned ? 'down' : 'up'}`;
    });
    if (!jails.length) refs.jails.innerHTML = '<div class="empty" style="padding:14px">Set FAIL2BAN_JAILS in .env (for example <span class="kv-code">sshd</span>) to list banned IPs.</div>';
    setText(banCard.querySelector('.panel-head h2 span'), `fail2ban bans${jails.length ? ` · ${jails.length}` : ''}`);
  }

  update();
  return { update };
}
