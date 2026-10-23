import { store, api, loadMetrics, loadLogSources, refreshAll, statusOf, securityStats } from './api.js';
import { icon } from './icons.js';
import { mountModal, showMonitorForm, showIncident } from './modals.js';
import { openMenu } from './components.js';
import { bus, toast, runAllNow } from './actions.js';
import { destroyAll } from './charts.js';
import { initPwa } from './pwa.js';
import { $, esc, setText, clock } from './util.js';
import { build as Overview } from './pages/overview.js';
import { build as Monitors } from './pages/monitors.js';
import { build as Workflows } from './pages/workflows.js';
import { build as Incidents } from './pages/incidents.js';
import { build as Logs } from './pages/logs.js';
import { build as Security } from './pages/security.js';
import { build as Hosts } from './pages/hosts.js';
import { build as Integrations } from './pages/integrations.js';
import { build as Settings } from './pages/settings.js';

const RANGES = [[1, 'Last hour'], [6, 'Last 6 hours'], [24, 'Last 24 hours'], [168, 'Last 7 days']];
const PAGES = [
  ['overview', 'Overview', 'home', 'Monitor your infrastructure and automations in real time', Overview],
  ['monitors', 'Monitors', 'gauge', 'Every check, its status and its configuration', Monitors],
  ['workflows', 'Workflows', 'branch', 'n8n execution success rates per workflow', Workflows],
  ['incidents', 'Incidents', 'alert', 'Outage windows, captured logs and AI root causes', Incidents],
  ['logs', 'Logs', 'logs', 'Read-only tail of the services whitelisted in .env', Logs],
  ['security', 'Security', 'shield', 'Ssh logins, port changes, fail2ban bans and restart attempts', Security],
  ['hosts', 'Hosts', 'server', 'The hub and every agent that pushes metrics to it', Hosts],
  ['integrations', 'Integrations', 'plug', 'Telegram delivery, n8n access and the LLM', Integrations],
  ['settings', 'Settings', 'settings', 'Cadence, thresholds and the .env keys the server reads', Settings],
];
// Phones get a bottom tab bar with the four pages that matter plus a "More" sheet.
const TABS = [['overview', 'Overview', 'home'], ['monitors', 'Monitors', 'gauge'], ['incidents', 'Incidents', 'alert'], ['logs', 'Logs', 'logs']];
const find = (id) => PAGES.find((p) => p[0] === id) || PAGES[0];
const route = () => {
  const raw = location.hash.replace(/^#\/?/, '');
  const [id, qs] = raw.split('?');
  return { page: find(id), params: new URLSearchParams(qs || '') };
};

const nav = $('#nav');
const tabbar = $('#tabbar');
const page = $('#page');
const hostSel = $('#hostSel');
const rangeSel = $('#rangeSel');
const stamp = $('#stamp');
let view = null;

/* ---------- sidebar ---------- */
nav.innerHTML = PAGES.map(([id, label, ic]) =>
  `<a href="#/${id}" data-r="${id}">${icon(ic, 17)}<span>${esc(label)}</span><em class="count" data-c="${id}" hidden></em></a>`).join('');

tabbar.innerHTML = TABS.map(([id, label, ic]) =>
  `<a href="#/${id}" data-r="${id}">${icon(ic, 20)}<span>${esc(label)}</span><em class="count" data-c="${id}" hidden></em></a>`).join('') +
  `<button id="moreBtn" type="button" data-r="more">${icon('layers', 20)}<span>More</span></button>`;
tabbar.querySelector('#moreBtn').onclick = (e) => openMenu(e.currentTarget, PAGES
  .filter(([id]) => !TABS.some(([t]) => t === id))
  .map(([id, label, ic]) => ({ label, icon: ic, fn: () => (location.hash = `#/${id}`) })));

function paintShell() {
  const s = store.summary;
  if (!s) return;
  const paint = (id, n) => {
    for (const node of document.querySelectorAll(`[data-c=${id}]`)) {
      node.hidden = !n;
      setText(node, String(n));
    }
  };
  const open = s.counts.open_incidents;
  paint('incidents', open);

  const secAlerts = securityStats()?.alerts || 0;
  paint('security', secAlerts);

  const down = s.monitors.filter((m) => m.enabled && ['down', 'degraded'].includes(statusOf(m))).length;
  setText($('#envState'), open ? `${open} incident${open === 1 ? '' : 's'} open` : down ? `${down} monitor${down === 1 ? '' : 's'} need a look` : 'All systems monitored');
  $('#envDot').className = `dot ${open || down ? 'down' : 'up'} live`;

  const sig = s.servers.map((x) => `${x.id}:${x.name}`).join('|');
  if (hostSel.dataset.sig !== sig) {
    hostSel.dataset.sig = sig;
    hostSel.innerHTML = s.servers.map((x) => `<option value="${x.id}">${esc(x.name)}${x.is_local ? '' : ' · agent'}</option>`).join('');
  }
  hostSel.value = String(store.serverId);
  rangeSel.value = String(store.hours);
  setText(stamp, `Updated ${clock(Date.now())}`);
}

/* ---------- pages ---------- */
function render() {
  const { page: p, params } = route();
  const [id, label, , sub, build] = p;
  setText($('#pageTitle'), label);
  setText($('#pageSub'), sub);
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.r === id));
  tabbar.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.r === id));
  page.replaceChildren();
  destroyAll();
  view = build(page, params);
  paintShell();
}

/* ---------- refresh loop ---------- */
let busy = false;
async function tick(showErrors = true) {
  if (busy) return;
  busy = true;
  try {
    await refreshAll();
    if (view) view.update();
    paintShell();
  } catch (e) {
    if (showErrors) toast(e.message, 'err');
  } finally {
    busy = false;
  }
}

bus.refresh = () => tick();
bus.openForm = (m) => showMonitorForm(m);
bus.openIncident = (id) => showIncident(id);
store.afterSave = async () => { await tick(); };

/* ---------- topbar ---------- */
rangeSel.innerHTML = RANGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
rangeSel.onchange = async () => {
  store.hours = +rangeSel.value;
  await loadMetrics().catch(() => null);
  if (view) view.update();
};
hostSel.onchange = async () => {
  store.serverId = +hostSel.value;
  await refreshAll();
  if (view) view.update();
  paintShell();
};
$('#addBtn').onclick = () => showMonitorForm(null);
$('#refreshBtn').onclick = () => runAllNow($('#refreshBtn'));

/* ---------- boot ---------- */
const field = (id, ic) => {
  const wrap = $(id);
  wrap.insertAdjacentHTML('afterbegin', icon(ic, 15));
  wrap.insertAdjacentHTML('beforeend', icon('chevron', 14, 'chev'));
};
$('#logoIcon').innerHTML = icon('activity', 22);
$('#envTile').innerHTML = icon('shield', 17);
$('#refreshBtn').innerHTML = icon('refresh', 16);
$('#addBtn').insertAdjacentHTML('afterbegin', icon('plus', 16));
field('#hostField', 'server');
field('#rangeField', 'calendar');

mountModal(document.body);
window.addEventListener('hashchange', render);

const me = await api('/me');
$('#who').innerHTML = `${icon('shield', 13)}<span>${esc(me.user)}</span>`;
$('#signout').innerHTML = `${icon('logout', 13)}<span>Sign out</span>`;
$('#signout').onclick = async () => {
  try { await api('/logout', { method: 'POST', body: {} }); } catch { /* cookie is gone anyway */ }
  location.href = '/login.html';
};

await tick(false);
loadLogSources();
render();
setInterval(() => tick(false), 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(false); });
initPwa(() => tick(false));
