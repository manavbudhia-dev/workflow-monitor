import { store, statusOf, uptimeStats, workflowStats, hostStats, enabledMonitors, loadMetrics, backupStats } from '../api.js';
import { icon } from '../icons.js';
import { card, statCard, banner, monitorRow, updateMonitorRow, incidentRow, updateIncidentRow, openMenu, setTextSlot, setHTMLSlot } from '../components.js';
import { sparkline, resourceChart, runsChart, backupTrend } from '../charts.js';
import { monitorMenu, incidentMenu, bus, n8nLink } from '../actions.js';
import { ago, dur, esc, el, syncList, setText, setHTML, setStyle, fixed, pct, bytes } from '../util.js';

const RANGES = [[1, 'Last hour'], [6, 'Last 6 hours'], [24, 'Last 24 hours'], [168, 'Last 7 days']];
const rangeSelect = (id) => `<span class="field sm">${icon('calendar', 14)}<select id="${id}">${RANGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>${icon('chevron', 14, 'chev')}</span>`;
const HEADS = [['name', 'Monitor', ''], ['type', 'Type', ''], ['status', 'Status', ''], ['check', 'Last check', ''], ['ms', 'Latency', 'num'], ['uptime', '24h', 'num'], ['', '', '']];

const deltaHTML = (v, note, unit = '%') => (v === null || v === undefined
  ? `<div class="delta"><b class="flat">no comparison yet</b><span>${esc(note)}</span></div>`
  : `<div class="delta"><b class="${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}">${icon(v > 0 ? 'up' : v < 0 ? 'down' : 'dot', 12)}${v > 0 ? '+' : ''}${(+v).toFixed(2)}${unit}</b><span>${esc(note)}</span></div>`);

const rank = (s) => ({ down: 0, degraded: 1, pending: 2, paused: 3, up: 4 }[s]);
const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  status: (a, b) => rank(statusOf(a)) - rank(statusOf(b)) || a.name.localeCompare(b.name),
  check: (a, b) => (b.last_check || 0) - (a.last_check || 0),
  ms: (a, b) => (a.ms || 0) - (b.ms || 0),
  uptime: (a, b) => (a.uptime ?? 101) - (b.uptime ?? 101),
};
const isBad = (m) => ['down', 'degraded'].includes(statusOf(m));

export function build(root) {
  const bannerSlot = el('<div></div>');
  const stats = el('<div class="grid-4"></div>');
  const cards = {
    uptime: statCard({ key: 'uptime', label: 'Uptime', tone: 'green', iconName: 'shield' }),
    monitors: statCard({
      key: 'monitors', label: 'Active monitors', tone: 'purple', iconName: 'layers',
      right: '<div class="splitbar"><div class="bar"><i class="g"></i><i class="r"></i></div></div>',
    }),
    workflow: statCard({ key: 'workflow', label: 'Workflow success', tone: 'amber', iconName: 'branch' }),
    host: statCard({ key: 'host', label: 'Host CPU', tone: 'blue', iconName: 'cpu' }),
  };
  stats.append(cards.uptime, cards.monitors, cards.workflow, cards.host);

  const resCard = card({
    id: 'resPanel', title: 'Host resource usage', iconName: 'chart', tools: rangeSelect('chartRange'),
    body: `<div class="legend-row"><span><i style="background:#2f7bff"></i>CPU</span><span><i style="background:#f5b73b"></i>Memory</span><span><i style="background:#ef4444"></i>Disk</span></div>
      <div class="chart"><canvas id="resChart"></canvas></div>`,
  });
  const wfCard = card({ id: 'wfPanel', title: 'Workflow health', iconName: 'branch', tools: '<a class="link" href="#/workflows">View all</a>', body: '<div id="wfBody"></div>' });
  const split = el('<div class="split"></div>');
  split.append(resCard, wfCard);

  const bakCard = card({ id: 'bakPanel', title: 'Backup health', iconName: 'database', tools: '<a class="link" href="#/monitors">Backup monitors</a>', body: '<div data-f=bak></div>' });
  const monCard = card({
    id: 'monPanel', title: 'Monitors', iconName: 'server',
    tools: `<div class="tabs" id="monTabs"></div><span class="search">${icon('search', 15)}<input id="monSearch" type="search" placeholder="Search monitors…" autocomplete="off"></span>`,
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr>${HEADS.map(([k, l, c]) =>
      `<th class="${k ? 'sort ' : ''}${c}" ${k ? `data-sort="${k}"` : ''}><span>${l}</span><i class="caret"></i></th>`).join('')}</tr></thead>
      <tbody id="monBody"></tbody></table></div><div id="monEmpty" class="empty" hidden></div>`,
  });
  const incCard = card({
    id: 'incPanel', title: 'Recent incidents', iconName: 'alert', tools: '<a class="link" href="#/incidents">View all</a>',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Incident</th><th>Monitor</th><th>Started</th><th>Duration</th><th>Status</th><th>Actions</th><th></th></tr></thead>
      <tbody id="incBody"></tbody></table></div><div id="incEmpty" class="empty" hidden></div>`,
  });
  root.append(bannerSlot, stats, split, bakCard, monCard, incCard);

  const q = (s) => (monCard.refs.body.querySelector(s));
  const refs = {
    tabs: monCard.refs.tools.querySelector('#monTabs'),
    search: monCard.refs.tools.querySelector('#monSearch'),
    range: resCard.refs.tools.querySelector('#chartRange'),
    monBody: q('#monBody'), monEmpty: q('#monEmpty'),
    incBody: incCard.refs.body.querySelector('#incBody'),
    incEmpty: incCard.refs.body.querySelector('#incEmpty'),
    wfBody: wfCard.refs.body.querySelector('#wfBody'),
  };

  refs.search.oninput = () => { store.query = refs.search.value.trim().toLowerCase(); updateMonitors(); };
  refs.range.onchange = async () => { store.hours = +refs.range.value; await loadMetrics().catch(() => null); updateCharts(); };
  monCard.refs.body.querySelectorAll('th.sort').forEach((th) => {
    th.onclick = () => { store.sort = store.sort === th.dataset.sort ? `-${th.dataset.sort}` : th.dataset.sort; updateMonitors(); };
  });

  const visible = () => {
    let rows = store.summary.monitors;
    if (store.tab === 'failing') rows = rows.filter(isBad);
    else if (store.tab === 'healthy') rows = rows.filter((m) => statusOf(m) === 'up');
    if (store.query) rows = rows.filter((m) => `${m.name} ${m.type} ${m.detail || ''}`.toLowerCase().includes(store.query));
    const key = store.sort.replace('-', '');
    const fn = SORTS[key] || SORTS.name;
    return rows.slice().sort(store.sort.startsWith('-') ? (a, b) => fn(b, a) : fn);
  };

  function updateTabs() {
    const all = store.summary.monitors;
    const defs = [['all', 'All', all.length], ['failing', 'Failing', all.filter(isBad).length], ['healthy', 'Healthy', all.filter((m) => statusOf(m) === 'up').length]];
    syncList(refs.tabs, defs, (d) => d[0], () => el('<button></button>'), (n, d) => {
      setText(n, `${d[1]} (${d[2]})`);
      n.classList.toggle('active', store.tab === d[0]);
      n.onclick = () => { store.tab = d[0]; updateTabs(); updateMonitors(); };
    });
  }

  function updateMonitors() {
    monCard.refs.body.querySelectorAll('th.sort').forEach((th) =>
      setText(th.querySelector('.caret'), store.sort === th.dataset.sort ? '▲' : store.sort === `-${th.dataset.sort}` ? '▼' : ''));
    const rows = visible();
    syncList(refs.monBody, rows, (m) => m.id, monitorRow, (node, m) => {
      updateMonitorRow(node, m);
      node.querySelector('[data-f=menu]').onclick = (e) => openMenu(e.currentTarget, monitorMenu(m));
    });
    refs.monEmpty.hidden = rows.length > 0;
    if (!rows.length) setText(refs.monEmpty, store.summary.monitors.length ? 'No monitor matches this filter or search.' : 'No monitors yet — use “Add monitor”.');
  }

  function updateStats() {
    const s = store.summary;
    const up = uptimeStats();
    setTextSlot(cards.uptime, 'value', up.avg === null ? '—' : `${up.avg.toFixed(2)}%`);
    setHTMLSlot(cards.uptime, 'foot', deltaHTML(up.delta, 'vs. previous 24h'));
    if (up.series.length > 1) sparkline('uptime', cards.uptime.querySelector('#uptime-spark'), up.series, '#22c55e');

    const enabled = enabledMonitors();
    setTextSlot(cards.monitors, 'value', String(enabled.length));
    const badN = enabled.filter(isBad).length, okN = enabled.length - badN - enabled.filter((m) => statusOf(m) === 'pending').length;
    const bar = cards.monitors.querySelector('.splitbar .bar');
    setStyle(bar, 'display', 'flex');
    setStyle(bar.children[0], 'width', `${enabled.length ? (okN / enabled.length) * 100 : 0}%`);
    setStyle(bar.children[1], 'width', `${enabled.length ? (badN / enabled.length) * 100 : 0}%`);
    setHTMLSlot(cards.monitors, 'foot', `<div class="legend"><span><i class="g"></i>${okN} healthy</span><span><i class="r"></i>${badN} failing</span>${
      enabled.filter((m) => statusOf(m) === 'pending').length ? `<span><i></i>${enabled.filter((m) => statusOf(m) === 'pending').length} pending</span>` : ''}${
      s.counts.disabled ? `<span class="dim">${s.counts.disabled} paused</span>` : ''}</div>`);

    const wf = workflowStats();
    setTextSlot(cards.workflow, 'value', wf ? pct(wf.rate, 1) : '—');
    setHTMLSlot(cards.workflow, 'foot', wf ? deltaHTML(wf.delta, 'vs. previous 24h') : '<div class="delta"><span class="dim">no n8n monitors</span></div>');
    if (wf && wf.spark.length > 1) sparkline('workflow', cards.workflow.querySelector('#workflow-spark'), wf.spark, '#f5b73b');

    const h = hostStats();
    const hasCpu = h.cpu !== null && h.cpu !== undefined;
    setTextSlot(cards.host, 'value', hasCpu ? `${(+h.cpu).toFixed(1)}%` : '—');
    setHTMLSlot(cards.host, 'foot', hasCpu
      ? `<div class="delta"><span>Load ${fixed(h.load, 2)} · limit ${s.thresholds.cpu}% · ${dur((h.server.uptime || 0) * 1000)} up</span></div>`
      : '<div class="delta"><span class="dim">waiting for agent metrics</span></div>');
    if (h.cpuSeries.length > 1) sparkline('host', cards.host.querySelector('#host-spark'), h.cpuSeries, '#2f7bff');
  }

  function updateCharts() {
    resourceChart('res', resCard.refs.body.querySelector('#resChart'), store.metrics?.points || []);
    if (refs.range.value !== String(store.hours)) refs.range.value = String(store.hours);
  }

  function updateWorkflow() {
    const wf = workflowStats();
    if (!wf) {
      if (!refs.wfBody.querySelector('.wf-empty')) setHTML(refs.wfBody, `<div class="wf-empty">${icon('branch', 22)}<div>No n8n monitor yet.<br>Add one to track workflow success rates.</div></div>`);
      return;
    }
    const worst = wf.worst;
    const mon = store.summary.monitors.find((x) => x.id === worst.id);
    const tone = !worst.ok ? 'down' : wf.rate >= 100 ? 'ok' : 'warn';
    let node = refs.wfBody.querySelector('.wf');
    if (!node || node.dataset.id !== String(worst.id)) {
      refs.wfBody.innerHTML = '';
      node = el(`<div class="wf" data-id="${worst.id}">
        <div class="top"><span class="dot" data-f=dot></span><b data-f=name></b><span data-f=badge></span><button class="icon-btn" data-f=menu>${icon('dots', 15)}</button></div>
        <div class="mid"><div class="ratewrap"><div class="rate" data-f=rate></div><span data-f=ratelabel></span></div>
          <div class="runs"><div class="chart"><canvas data-f=runs></canvas></div><small data-f=runsn></small></div></div>
        <div class="failed" data-f=failed></div>
        <div class="foot" data-f=foot></div>
        <div class="act"><button class="btn soft sm" data-f=open>View workflow ${icon('arrow', 13)}</button></div>
      </div>`);
      refs.wfBody.append(node);
    }
    node.className = `wf ${tone === 'down' ? '' : tone}`;
    node.querySelector('[data-f=dot]').className = `dot ${mon ? statusOf(mon) : 'pending'}`;
    setText(node.querySelector('[data-f=name]'), worst.name);
    setHTML(node.querySelector('[data-f=badge]'), '<span class="badge">n8n</span>');
    const rate = node.querySelector('[data-f=rate]');
    setStyle(rate, 'color', tone === 'ok' ? 'var(--green)' : tone === 'warn' ? 'var(--amber)' : 'var(--red)');
    setText(rate, pct(wf.rate, 1));
    setText(node.querySelector('[data-f=ratelabel]'), 'success rate (last 24h)');
    setText(node.querySelector('[data-f=failed]'), wf.total ? `${wf.failed} of ${wf.total} runs failed` : 'no finished runs in window');
    setText(node.querySelector('[data-f=runsn]'), `${wf.runs.length} samples · 24h`);
    setHTML(node.querySelector('[data-f=foot]'), `Last run <span class="v">${wf.lastRun ? ago(wf.lastRun) : 'never'}</span><span class="dim">|</span>
      24h avg <span class="v">${pct(wf.avg24, 1)}</span><span class="dim">|</span> ${mon?.config?.workflow_id ? `workflow ${esc(mon.config.workflow_id)}` : 'all workflows'}`);
    node.querySelector('[data-f=menu]').onclick = (e) => mon && openMenu(e.currentTarget, monitorMenu(mon));
    const link = n8nLink(worst.id);
    node.querySelector('[data-f=open]').onclick = () => (link ? window.open(link, '_blank', 'noopener') : bus.go('#/workflows'));
    if (wf.runs.length) runsChart('wf-runs', node.querySelector('[data-f=runs]'), wf.runs, Number(mon?.config?.min_rate ?? 100));
  }

  function updateBackup() {
    const holder = bakCard.refs.body.querySelector('[data-f=bak]');
    const b = backupStats();
    if (!b) {
      if (!holder.querySelector('.wf-empty')) setHTML(holder, `<div class="wf-empty">${icon('database', 22)}<div>No backup monitor yet.<br>Add one of type “backup” to watch file age and size.</div></div>`);
      return;
    }
    const p = b.pick;
    const sig = `${p.id}:${p.last?.file || ''}:${p.ok}`;
    let node = holder.querySelector('.dcard');
    if (!node || node.dataset.sig !== sig) {
      holder.innerHTML = '';
      node = el(`<div class="dcard" data-sig="${sig}">
        <header><span class="dot" data-f=dot></span><b data-f=name></b><span data-f=badge></span></header>
        <div class="kvs" data-f=info></div>
        <div class="chart" style="height:104px"><canvas data-f=trend></canvas></div>
        <div class="hint" data-f=note></div>
      </div>`);
      holder.append(node);
    }
    node.querySelector('.dot').className = `dot ${p.ok === false ? 'down' : p.ok === null ? 'pending' : 'up'}`;
    setText(node.querySelector('[data-f=name]'), p.name);
    setHTML(node.querySelector('[data-f=badge]'), p.ok === false
      ? '<span class="badge">needs a look</span>'
      : `<span class="badge plain">${esc(p.last ? p.pattern || '' : 'no backup found')}</span>`);
    setHTML(node.querySelector('[data-f=info]'), `
      <div><span>Newest file</span><span>${esc(p.last?.file || '—')}</span></div>
      <div><span>Size</span><span>${p.last ? bytes(p.last.size) : '—'}</span></div>
      <div><span>Written</span><span>${p.last ? ago(p.last.mtime) : '—'}</span></div>
      <div><span>Rules</span><span>max ${p.max_age_hours}h · min ${p.min_size_mb}MB</span></div>`);
    setText(node.querySelector('[data-f=note]'), `${b.count} backup monitor${b.count === 1 ? '' : 's'} · ${b.failing} failing · ${b.sizes.length} recorded size point${b.sizes.length === 1 ? '' : 's'} · alert if a backup is more than 50% smaller than the one before`);
    backupTrend('bak-trend', node.querySelector('[data-f=trend]'), p.history || []);
  }

  function updateIncidents() {
    const rows = store.incidents.slice(0, 5);
    syncList(refs.incBody, rows, (i) => i.id, incidentRow, (node, i) => {
      updateIncidentRow(node, i);
      node.querySelector('[data-act=investigate]').onclick = () => bus.openIncident(i.id);
      node.querySelector('[data-f=menu]').onclick = (e) => openMenu(e.currentTarget, incidentMenu(i));
    });
    refs.incEmpty.hidden = rows.length > 0;
    if (!rows.length) setText(refs.incEmpty, 'No incidents recorded yet.');
  }

  function updateBanner() {
    const open = store.incidents.filter((i) => i.state === 'open');
    const count = store.summary.counts.open_incidents;
    const oldest = open.length ? Math.min(...open.map((i) => i.started_at)) : null;
    let node = bannerSlot.firstChild;
    if (!node || node.dataset.clear !== String(!count)) {
      node = banner(count, oldest, () => bus.go('#/incidents'));
      node.dataset.clear = String(!count);
      bannerSlot.replaceChildren(node);
    }
    setTextSlot(node, 'head', count ? `${count} active incident${count === 1 ? '' : 's'}` : 'No open incidents');
    setHTMLSlot(node, 'note', count ? `Oldest open <b class="t-red">${esc(ago(oldest))}</b>` : 'Everything monitored is currently healthy.');
  }

  function update() {
    if (!store.summary) return;
    updateBanner();
    updateStats();
    updateCharts();
    updateWorkflow();
    updateBackup();
    updateTabs();
    updateMonitors();
    updateIncidents();
  }

  update();
  return { update };
}
