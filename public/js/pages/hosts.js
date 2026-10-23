import { store, api, loadServers, loadMetrics, currentServer } from '../api.js';
import { icon } from '../icons.js';
import { card, meterRow, updateMeter, openMenu } from '../components.js';
import { toast, bus } from '../actions.js';
import { resourceChart, netChart } from '../charts.js';
import { openModal, closeModal } from '../modals.js';
import { el, esc, syncList, setText, setHTML, ago, dur, fixed, copy } from '../util.js';

const hostRow = () => el(`<div class="dcard">
  <header><span class="dot"></span><b data-f=name></b><span data-f=badge></span></header>
  <div class="meter-stack" data-f=meters></div>
  <div class="kvs" data-f=kvs></div>
  <div data-f=warn></div>
  <div class="row"><button class="btn soft sm" data-f=setup>${icon('key', 14)} Agent setup</button>
    <button class="btn sm" data-f=select>${icon('chart', 14)} Show charts</button>
    <span class="spacer"></span><button class="icon-btn" data-f=menu>${icon('dots', 16)}</button></div>
</div>`);

const agentCmd = (origin, key, name) =>
  `# on ${name}
sudo mkdir -p /opt/wm-agent && cd /opt/wm-agent
npm init -y >/dev/null && npm i systeminformation
# copy agent/agent.js here, then:
HUB_URL=${origin} HUB_KEY=${key} SERVER_NAME=${name} node agent.js`;

export function build(root) {
  const chartCard = card({
    id: 'hostCharts', title: 'Selected host', iconName: 'gauge', tools: '<span class="muted" data-f=ranges></span>',
    body: `<div class="legend-row"><span><i style="background:#2f7bff"></i>CPU</span><span><i style="background:#f5b73b"></i>Memory</span><span><i style="background:#ef4444"></i>Disk</span></div>
      <div class="chart"><canvas data-f=res></canvas></div>
      <div class="section-title" style="margin-top:16px">${icon('wifi', 14)} Network</div>
      <div class="chart" style="height:150px"><canvas data-f=net></canvas></div>`,
  });
  const gridCard = card({
    id: 'hostGrid', title: 'Servers', iconName: 'server',
    tools: '<button class="btn primary sm" data-f=add>' + icon('plus', 15) + ' Add agent</button>',
    body: '<div class="cards" data-f=body></div>',
  });
  const note = el('<div class="note">The hub is always the local server and collects its own metrics. A remote box gets an agent key and pushes the same numbers; if it goes quiet an incident opens on the agent itself, not on the monitors it hosts.</div>');
  root.append(chartCard, gridCard, note);

  const refs = {
    res: chartCard.refs.body.querySelector('[data-f=res]'),
    net: chartCard.refs.body.querySelector('[data-f=net]'),
    ranges: chartCard.refs.tools.querySelector('[data-f=ranges]'),
    body: gridCard.refs.body.querySelector('[data-f=body]'),
  };
  gridCard.refs.tools.querySelector('[data-f=add]').onclick = addHost;

  async function addHost() {
    const name = prompt('Agent name (letters, digits, dot, dash, underscore):');
    if (!name) return;
    try {
      const s = await api('/servers', { method: 'POST', body: { name } });
      toast(`Agent key created for ${s.name}`);
      await loadServers();
      showSetup(s);
      update();
    } catch (e) { toast(e.message, 'err'); }
  }

  function showSetup(s) {
    const cmd = agentCmd(location.origin, s.api_key, s.name);
    const body = el(`<div class="mono-block">
      <div class="hint">Keep this key safe — the agent authenticates with it and the value is only shown here.</div>
      <div class="copy-row"><input readonly data-f=key value="${esc(s.api_key)}"><button type="button" class="btn sm">${icon('copy', 13)} Copy key</button></div>
      <pre class="block">${esc(cmd)}</pre>
      <div class="row"><button class="btn sm" data-f=copycmd>${icon('copy', 13)} Copy setup</button>
        <span class="muted">Self test: <span class="kv-code">curl -H "x-agent-key: …" ${esc(location.origin)}/api/agent/hello</span></span></div>
    </div>`);
    const modal = openModal({ title: `${s.name} · agent setup`, body, foot: '<button class="btn ghost" data-slot=close>Close</button>', onMount: (h) => { h.querySelector('[data-slot=close]').onclick = closeModal; } });
    modal.querySelector('[data-f=key]').nextElementSibling.onclick = (e) => copy(s.api_key, e.currentTarget);
    modal.querySelector('[data-f=copycmd]').onclick = (e) => copy(cmd, e.currentTarget);
  }

  async function pick(s) {
    store.serverId = s.id;
    await loadMetrics().catch(() => null);
    update();
  }

  async function remove(s) {
    if (!confirm(`Remove ${s.name} and its metric history?`)) return;
    try {
      await api(`/servers/${s.id}`, { method: 'DELETE' });
      toast(`${s.name} removed`);
      await loadServers();
      bus.refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  function update() {
    const cur = currentServer();
    const points = store.metrics?.points || [];
    setText(refs.ranges, `${cur.name || 'no server'} · ${store.hours}h · ${points.length} points`);
    resourceChart('host-res', refs.res, points);
    netChart('host-net', refs.net, points);

    const keys = new Map((store.servers || []).map((s) => [s.id, s]));
    syncList(refs.body, store.summary.servers, (s) => s.id, hostRow, (node, m) => {
      node.querySelector('.dot').className = `dot ${m.stale ? 'down' : m.last_seen ? 'up' : 'pending'}`;
      setText(node.querySelector('[data-f=name]'), m.name);
      setHTML(node.querySelector('[data-f=badge]'), m.is_local
        ? '<span class="badge plain">this hub</span>'
        : `<span class="badge">${m.last_seen ? `agent · ${ago(m.last_seen)}` : 'agent · waiting'}</span>`);

      const meters = node.querySelector('[data-f=meters]');
      if (meters.children.length !== 3) meters.replaceChildren(meterRow('CPU'), meterRow('Memory'), meterRow('Disk'));
      const th = store.summary.thresholds;
      updateMeter(meters.children[0], 'CPU', m.cpu, th.cpu);
      updateMeter(meters.children[1], 'Memory', m.mem, th.mem);
      updateMeter(meters.children[2], 'Disk', m.disk, th.disk);

      setHTML(node.querySelector('[data-f=kvs]'), `
        <div><span>Load average</span><span>${fixed(m.load, 2)}</span></div>
        <div><span>Uptime</span><span>${m.uptime ? dur(m.uptime * 1000) : '—'}</span></div>
        <div><span>Net in / out</span><span>${fixed(m.net_in, 2)} / ${fixed(m.net_out, 2)} Mb</span></div>
        <div><span>Last sample</span><span>${m.metric_at ? ago(m.metric_at) : 'never'}</span></div>`);
      setHTML(node.querySelector('[data-f=warn]'), m.stale
        ? `<div class="note" style="border-color:rgba(239,68,68,.3)">${m.last_seen
          ? `${m.is_local ? 'Hub collector silent' : 'Agent silent'} — last ${m.is_local ? 'sample' : 'push'} ${ago(m.last_seen)}`
          : m.is_local ? 'The hub has not recorded a metric sample yet' : 'No metrics received from this agent yet'}</div>` : '');

      const isSel = m.id === store.serverId;
      const sel = node.querySelector('[data-f=select]');
      setText(sel, `${isSel ? 'Showing' : 'Show'} charts`);
      sel.disabled = isSel;
      sel.onclick = () => pick(m);
      node.querySelector('[data-f=setup]').onclick = () => (keys.has(m.id) ? showSetup(keys.get(m.id)) : toast('The hub needs no agent key', 'err'));
      node.querySelector('[data-f=menu]').onclick = (e) => openMenu(e.currentTarget, [
        { label: 'Show charts for this host', icon: 'chart', fn: () => pick(m) },
        ...(m.is_local ? [] : [{ label: 'Remove agent', icon: 'trash', danger: true, fn: () => remove(m) }]),
      ]);
    });
    setText(gridCard.querySelector('.panel-head h2 span'), `Servers · ${store.summary.servers.length}`);
  }

  update();
  return { update };
}
