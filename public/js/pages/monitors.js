import { store, statusOf, enabledMonitors } from '../api.js';
import { icon } from '../icons.js';
import { card, monitorRow, updateMonitorRow, openMenu } from '../components.js';
import { monitorMenu } from '../actions.js';
import { el, esc, syncList, setText } from '../util.js';

/** monitorRow() plus a server column — the shared row component stays untouched. */
const fullRow = () => {
  const tr = monitorRow();
  tr.querySelector('[data-f=check]').before(el('<td class="muted" data-f="server" data-l="Server"></td>'));
  return tr;
};

const HEADS = [['Monitor', ''], ['Type', ''], ['Status', ''], ['Server', ''], ['Last check', ''], ['Latency', 'num'], ['24h uptime', 'num'], ['', '']];
const rank = (s) => ({ down: 0, degraded: 1, pending: 2, paused: 3, up: 4 }[s]);
const TABS = [['all', 'All'], ['failing', 'Failing'], ['healthy', 'Healthy'], ['pending', 'Pending'], ['paused', 'Paused']];
const SORTS = {
  status: (a, b) => rank(statusOf(a)) - rank(statusOf(b)) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  check: (a, b) => (b.last_check || 0) - (a.last_check || 0),
};

export function build(root) {
  const cardEl = card({
    id: 'allMon', title: 'All monitors', iconName: 'server',
    tools: `<div class="tabs" data-f="tabs"></div><span class="search">${icon('search', 15)}<input data-f="q" type="search" placeholder="Search monitors…" autocomplete="off"></span>
      <span class="field sm">${icon('gauge', 14)}<select data-f="sort"><option value="status">Sort: status</option><option value="name">Sort: name</option><option value="type">Sort: type</option><option value="check">Sort: last check</option></select>${icon('chevron', 13, 'chev')}</span>`,
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr>${HEADS.map(([l, c]) => `<th class="${c}">${esc(l)}</th>`).join('')}</tr></thead>
      <tbody data-f="body"></tbody></table></div><div data-f="empty" class="empty" hidden></div>`,
  });
  const note = el('<div class="note">Every check runs from this hub; the server column only groups a monitor with the machine it belongs to, and agents push host metrics, not check results. Default cadence comes from <span class="kv-code">CHECK_INTERVAL_SEC</span> in .env.</div>');
  root.append(cardEl, note);

  const f = (k) => cardEl.refs.tools.querySelector(`[data-f=${k}]`);
  const refs = { tabs: f('tabs'), q: f('q'), sort: f('sort'), body: cardEl.refs.body.querySelector('[data-f=body]'), empty: cardEl.refs.body.querySelector('[data-f=empty]') };
  refs.q.value = store.query;
  refs.q.oninput = () => { store.query = refs.q.value.trim().toLowerCase(); update(); };
  refs.sort.onchange = () => { store.sort = refs.sort.value; update(); };

  const bucket = (m) => {
    const s = statusOf(m);
    if (s === 'paused') return 'paused';
    if (s === 'up') return 'healthy';
    if (s === 'down' || s === 'degraded') return 'failing';
    return 'pending';
  };

  function update() {
    const all = store.summary.monitors;
    const counts = { all: all.length, failing: 0, healthy: 0, pending: 0, paused: 0 };
    for (const m of all) counts[bucket(m)]++;
    refs.sort.value = SORTS[store.sort] ? store.sort : 'status';
    syncList(refs.tabs, TABS, (t) => t[0], () => el('<button></button>'), (n, t) => {
      setText(n, `${t[1]} (${counts[t[0]]})`);
      n.classList.toggle('active', store.tab === t[0]);
      n.onclick = () => { store.tab = t[0]; update(); };
    });
    let rows = all.filter((m) => (store.tab === 'all' ? true : bucket(m) === store.tab));
    if (store.query) rows = rows.filter((m) => `${m.name} ${m.type} ${m.detail || ''}`.toLowerCase().includes(store.query));
    rows = rows.slice().sort(SORTS[refs.sort.value] || SORTS.status);
    const n = syncList(refs.body, rows, (m) => m.id, fullRow, (node, m) => {
      updateMonitorRow(node, m);
      setText(node.querySelector('[data-f=server]'), (store.summary.servers.find((s) => s.id === m.server_id) || {}).name || '—');
      node.querySelector('[data-f=menu]').onclick = (e) => openMenu(e.currentTarget, monitorMenu(m));
    });
    refs.empty.hidden = n > 0;
    setText(refs.empty, all.length ? 'No monitor matches this tab or search.' : 'No monitors yet — add the first one.');
    const bad = enabledMonitors().filter((m) => statusOf(m) === 'down').length;
    setText(cardEl.querySelector('.panel-head h2 span'), bad ? `All monitors · ${bad} failing` : 'All monitors');
  }

  update();
  return { update };
}
