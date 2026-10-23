import { store, statusOf } from '../api.js';
import { icon } from '../icons.js';
import { card, statCard, openMenu, setTextSlot, setHTMLSlot } from '../components.js';
import { monitorMenu, bus, n8nLink } from '../actions.js';
import { runsChart } from '../charts.js';
import { el, esc, syncList, setText, setHTML, setStyle, ago, pct } from '../util.js';

const avg = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
const tone = (rate, min) => (rate >= min ? 'ok' : rate >= min - 20 ? 'warn' : 'down');
const COLOR = { ok: 'var(--green)', warn: 'var(--amber)', down: 'var(--red)' };

/** One card per n8n monitor: success rate, run bars and a deep link into the n8n UI. */
function wfCard() {
  return el(`<div class="wf">
    <div class="top"><span class="dot" data-f=dot></span><b data-f=name></b><span data-f=badge></span>
      <span class="spacer"></span><span data-f=status></span>
      <button class="icon-btn" data-f=menu>${icon('dots', 15)}</button></div>
    <div class="mid"><div class="ratewrap"><div class="rate" data-f=rate></div><span data-f=note></span></div>
      <div class="runs"><div class="chart"><canvas data-f=runs></canvas></div><small data-f=runsn></small></div></div>
    <div class="failed" data-f=failed></div>
    <div class="foot" data-f=foot></div>
    <div class="act"><span class="link" data-f=wf></span><button class="btn soft sm" data-f=open>Open workflow ${icon('arrow', 13)}</button></div>
  </div>`);
}

export function build(root) {
  const stats = el('<div class="grid-4"></div>');
  const cards = {
    tracked: statCard({ key: 'wf-count', label: 'Workflows tracked', tone: 'blue', iconName: 'branch', right: '' }),
    now: statCard({ key: 'wf-now', label: 'Success right now', tone: 'green', iconName: 'check', right: '' }),
    avg: statCard({ key: 'wf-avg', label: '24h average', tone: 'amber', iconName: 'chart', right: '' }),
    bad: statCard({ key: 'wf-bad', label: 'Failing n8n monitors', tone: 'red', iconName: 'alert', right: '' }),
  };
  stats.append(cards.tracked, cards.now, cards.avg, cards.bad);

  const gridCard = card({
    id: 'wfGrid', title: 'Workflow runs', iconName: 'branch',
    tools: '<button class="btn primary sm" data-f="add">' + icon('plus', 15) + ' Add n8n monitor</button>',
    body: '<div class="cards wf-cards" data-f=body></div><div data-f=empty class="empty" hidden></div>',
  });
  const note = el('<div class="note">Each bar is one check of the n8n execution API: the share of runs that finished <span class="kv-code">success</span> inside the monitor’s <span class="kv-code">window_min</span>. A workflow with no finished run in the window shows its 24h average instead, and a monitor below <span class="kv-code">min_rate</span> opens an incident.</div>');
  root.append(stats, gridCard, note);

  const refs = {
    body: gridCard.refs.body.querySelector('[data-f=body]'),
    empty: gridCard.refs.body.querySelector('[data-f=empty]'),
  };
  gridCard.refs.tools.querySelector('[data-f=add]').onclick = () => bus.openForm(null);

  function update() {
    const rows = store.n8n || [];
    const mon = (id) => store.summary.monitors.find((x) => x.id === id) || null;
    const rates = rows.map((r) => (r.current ? r.current.rate : r.avg_24h)).filter((v) => v !== null && v !== undefined);
    const nowRates = rows.filter((r) => r.current).map((r) => r.current.rate);
    const samples = rows.reduce((s, r) => s + (r.samples || []).length, 0);

    setTextSlot(cards.tracked, 'value', String(rows.length));
    setHTMLSlot(cards.tracked, 'foot', `<div class="delta"><span>${rows.length ? `${samples} run samples in 24h` : 'no n8n monitors configured'}</span></div>`);
    setTextSlot(cards.now, 'value', nowRates.length ? pct(avg(nowRates), 1) : '—');
    setHTMLSlot(cards.now, 'foot', `<div class="delta"><span>${nowRates.length ? `over ${nowRates.length} workflow${nowRates.length === 1 ? '' : 's'} with finished runs` : 'waiting for the first check'}</span></div>`);
    setTextSlot(cards.avg, 'value', rates.length ? pct(avg(rates), 1) : '—');
    setHTMLSlot(cards.avg, 'foot', `<div class="delta"><span>${rates.length ? `worst ${pct(Math.min(...rates), 1)} · best ${pct(Math.max(...rates), 1)}` : 'nothing sampled yet'}</span></div>`);
    const badN = rows.filter((r) => r.ok === false).length;
    setTextSlot(cards.bad, 'value', String(badN));
    setHTMLSlot(cards.bad, 'foot', `<div class="delta"><span>${badN ? 'below their configured min_rate' : rows.length ? 'all n8n monitors healthy' : 'add a monitor to start tracking'}</span></div>`);

    const n = syncList(refs.body, rows, (r) => r.id, wfCard, (node, r) => {
      const m = mon(r.id);
      const min = Number(m?.config?.min_rate ?? 100);
      const rate = r.current ? r.current.rate : r.avg_24h;
      const missing = rate === null || rate === undefined;
      const t = r.ok === false ? 'down' : missing ? 'warn' : tone(rate, min);
      node.className = `wf ${t === 'down' ? '' : t}`;
      setText(node.querySelector('[data-f=name]'), r.name);
      setHTML(node.querySelector('[data-f=badge]'), '<span class="badge">n8n</span>');
      const s = m ? statusOf(m) : 'pending';
      node.querySelector('[data-f=dot]').className = `dot ${s}`;
      setHTML(node.querySelector('[data-f=status]'), `<span class="stat ${s}"><span class="dot ${s}"></span>${s === 'up' ? 'UP' : s.toUpperCase()}</span>`);
      const rateEl = node.querySelector('[data-f=rate]');
      setStyle(rateEl, 'color', COLOR[t]);
      setText(rateEl, missing ? '—' : pct(rate, 1));
      setText(node.querySelector('[data-f=note]'), r.current ? 'last check' : 'no run in window');
      const c = r.current;
      setText(node.querySelector('[data-f=failed]'), c ? (c.failed ? `${c.failed} of ${c.total} runs failed` : `${c.total} runs, none failed`) : m ? m.detail || 'no executions inside the window' : 'monitor deleted');
      setText(node.querySelector('[data-f=runsn]'), `${(r.samples || []).length} samples · 24h`);
      const link = n8nLink(r.id);
      setHTML(node.querySelector('[data-f=wf]'), `<span class="inline-flex">${icon('link', 13)}<span>${esc(r.workflow_id || 'all workflows')}</span></span>`);
      const open = node.querySelector('[data-f=open]');
      open.disabled = !link;
      open.title = link ? 'Open in n8n' : 'Set the n8n base URL on this monitor to enable the link';
      open.onclick = () => (link ? window.open(link, '_blank', 'noopener') : bus.openForm(m));
      setHTML(node.querySelector('[data-f=foot]'), `last check <span class="v">${m && m.last_check ? ago(m.last_check) : 'pending'}</span><span class="dim">|</span>
        24h avg <span class="v">${pct(r.avg_24h, 1)}</span><span class="dim">|</span> window <span class="v">${esc(String(m?.config?.window_min ?? 60))} min</span><span class="dim">|</span>
        min <span class="v">${esc(String(m?.config?.min_rate ?? 100))}%</span>`);
      node.querySelector('[data-f=menu]').onclick = (e) => m && openMenu(e.currentTarget, monitorMenu(m));
      if ((r.samples || []).length) runsChart(`wf-${r.id}`, node.querySelector('[data-f=runs]'), r.samples, min);
    });
    refs.empty.hidden = n > 0;
    setText(refs.empty, 'No n8n monitor yet. Add one with the n8n base URL and API key — or leave both blank and use N8N_URL / N8N_API_KEY from .env.');
    setText(gridCard.querySelector('.panel-head h2 span'), n ? `Workflow runs · ${n} tracked` : 'Workflow runs');
  }

  update();
  return { update };
}
