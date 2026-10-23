import { store, api, loadIncidents } from '../api.js';
import { icon } from '../icons.js';
import { card, incidentRow, updateIncidentRow, openMenu } from '../components.js';
import { incidentMenu, bus, toast } from '../actions.js';
import { incidentBars } from '../charts.js';
import { el, syncList, setText, setHTML } from '../util.js';
import { restartBlock } from '../modals.js';

const TABS = [['all', 'All'], ['open', 'Open'], ['resolved', 'Resolved']];

/** incidentRow() plus logs/AI columns, so the shared component stays as Overview uses it. */
const wideRow = () => {
  const tr = incidentRow();
  tr.querySelector('[data-f=state]').before(el('<td data-f="logs"></td>'), el('<td data-f="ai"></td>'));
  return tr;
};

/** One bar per day for the last 14 days, from the incidents already loaded. */
function daily(rows, days = 14) {
  const DAY = 864e5, today = Math.floor(Date.now() / DAY) * DAY;
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = today - i * DAY;
    out.push({
      label: new Date(start).toLocaleDateString([], { day: '2-digit', month: 'short' }),
      n: rows.filter((r) => r.started_at >= start && r.started_at < start + DAY).length,
    });
  }
  return out;
}

export function build(root) {
  const chartCard = card({
    id: 'incTrend', title: 'Incident volume', iconName: 'chart', tools: '<span class="muted">last 14 days</span>',
    body: '<div class="chart" style="height:150px"><canvas data-f="bars"></canvas></div>',
  });
  const listCard = card({
    id: 'incList', title: 'Incidents', iconName: 'alert',
    tools: `<div class="tabs" data-f="tabs"></div><span class="search">${icon('search', 15)}<input data-f="q" type="search" placeholder="Search incidents…" autocomplete="off"></span>`,
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Incident</th><th>Monitor</th><th>Started</th><th>Duration</th><th>Logs</th><th>AI</th><th>Status</th><th>Actions</th><th></th></tr></thead>
      <tbody data-f="body"></tbody></table></div><div data-f="empty" class="empty" hidden></div>`,
  });
  const restartCard = card({
    id: 'incRestarts', title: 'Auto-restart attempts', iconName: 'refresh',
    tools: '<span class="muted" data-f=wl></span>',
    body: '<div data-f=restarts></div>',
  });
  const note = el('<div class="note">An incident opens when a check flips to failing and closes when it recovers. <b class="strong">Investigate</b> shows the captured log tail and, when a model is configured, the stored root cause. Resolving by hand only closes the record — it does not change the monitor.</div>');
  root.append(chartCard, listCard, restartCard, note);

  const refs = {
    tabs: listCard.refs.tools.querySelector('[data-f=tabs]'),
    q: listCard.refs.tools.querySelector('[data-f=q]'),
    body: listCard.refs.body.querySelector('[data-f=body]'),
    empty: listCard.refs.body.querySelector('[data-f=empty]'),
    bars: chartCard.refs.body.querySelector('[data-f=bars]'),
    restarts: restartCard.refs.body.querySelector('[data-f=restarts]'),
    wl: restartCard.refs.tools.querySelector('[data-f=wl]'),
  };
  refs.q.value = store.query;
  refs.q.oninput = () => { store.query = refs.q.value.trim().toLowerCase(); update(); };

  function update() {
    const all = store.incidents;
    const open = all.filter((i) => i.state === 'open').length;
    const counts = { all: all.length, open, resolved: all.length - open };
    syncList(refs.tabs, TABS, (t) => t[0], () => el('<button></button>'), (n, t) => {
      setText(n, `${t[1]} (${counts[t[0]]})`);
      n.classList.toggle('active', store.tab === t[0]);
      n.onclick = () => { store.tab = t[0]; update(); };
    });
    let rows = all.filter((i) => (store.tab === 'all' ? true : i.state === store.tab));
    if (store.query) rows = rows.filter((i) => `${i.title} ${i.monitor} ${i.detail}`.toLowerCase().includes(store.query));
    syncList(refs.body, rows, (i) => i.id, wideRow, (node, i) => {
      updateIncidentRow(node, i);
      setText(node.querySelector('[data-f=logs]'), i.log_chars ? `${i.log_chars} chars` : '—');
      setHTML(node.querySelector('[data-f=ai]'), i.has_ai
        ? `<span class="inline-flex">${icon('sparkles', 14)}<span class="t-accent">done</span></span>`
        : '<span class="dim">—</span>');
      node.querySelector('[data-act=investigate]').onclick = () => bus.openIncident(i.id);
      node.querySelector('[data-f=menu]').onclick = (e) => openMenu(e.currentTarget, [
        ...incidentMenu(i),
        { label: 'Re-run AI root cause', icon: 'zap', fn: () => explain(i.id) },
      ]);
    });
    refs.empty.hidden = rows.length > 0;
    setText(refs.empty, all.length ? 'No incident matches this tab or search.' : 'No incidents recorded — that is the good news.');
    setText(listCard.querySelector('.panel-head h2 span'), open ? `Incidents · ${open} open` : 'Incidents');
    incidentBars('inc-days', refs.bars, daily(all));

    const rs = store.restarts?.rows || [];
    setText(refs.wl, store.restarts?.enabled
      ? `${store.restarts.allow.length} command(s) whitelisted · waits ${store.restarts.wait_sec}s after running`
      : 'RESTART_ENABLED=false');
    setHTML(refs.restarts, rs.length ? restartBlock(rs.slice(0, 25), `Attempt log · latest ${Math.min(rs.length, 25)} of ${rs.length}`)
      : '<div class="empty" style="padding:18px">No restart attempts yet — tick “Auto-restart when down” on a monitor whose command is in RESTART_ALLOW.</div>');
  }

  async function explain(id) {
    try {
      const r = await api(`/incidents/${id}/explain`, { method: 'POST', body: {} });
      if (r.ai) { await loadIncidents(); update(); toast(`Incident #${id}: root cause stored`); } else toast(r.error || 'no answer', 'err');
    } catch (e) { toast(e.message, 'err'); }
  }

  update();
  return { update };
}
