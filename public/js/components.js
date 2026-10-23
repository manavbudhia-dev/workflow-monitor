import { icon, typeMeta } from './icons.js';
import { esc, ago, dur, pct, setText, setHTML, setStyle, el } from './util.js';
import { statusOf, STATUS_LABEL, store } from './api.js';

export const badge = (label, cls = '') => `<span class="badge ${cls}">${esc(label)}</span>`;
export const typeBadge = (t) => badge(typeMeta(t).label);
export const stateWord = (s) => (s === 'down' ? 'Open' : s === 'up' ? 'Resolved' : STATUS_LABEL[s]);

export function card({ id, title, iconName, tools = '', body = '' }) {
  const node = el(`<section class="panel" ${id ? `id="${id}"` : ''}>
    <div class="panel-head"><h2>${icon(iconName, 17)}<span>${esc(title)}</span></h2><div class="tools">${tools}</div></div>
    <div class="panel-body">${body}</div>
  </section>`);
  node.refs = { body: node.querySelector('.panel-body'), tools: node.querySelector('.tools') };
  return node;
}

export const statCard = ({ key, label, tone, iconName, right }) => el(`
  <div class="panel stat-card" data-stat="${key}">
    <div class="head">
      <div class="tile ${tone}">${icon(iconName, 19)}</div>
      <div style="min-width:0;flex:1">
        <div class="label">${esc(label)}<span title="Computed from stored checks and incidents">${icon('info', 12)}</span></div>
        <div class="value" data-slot="value">—</div>
      </div>
      <div class="right" data-slot="right">${right ?? `<canvas id="${key}-spark"></canvas>`}</div>
    </div>
    <div data-slot="foot"></div>
  </div>`);

export function setTextSlot(root, slot, txt) { return setText(root.querySelector(`[data-slot=${slot}]`), txt); }
export function setHTMLSlot(root, slot, html) { return setHTML(root.querySelector(`[data-slot=${slot}]`), html); }

export function banner(count, oldest, onReview) {
  const clear = !count;
  const node = el(`<div class="banner ${clear ? 'clear' : ''}">
    <div class="mark">${icon(clear ? 'check' : 'alert', 14)}</div>
    <b data-slot="head"></b><span class="sep"></span><span data-slot="note"></span>
    <div class="tools"><button class="btn sm" data-slot="cta">${clear ? 'Open incidents' : 'Review incidents'} ${icon('arrow', 14)}</button></div>
  </div>`);
  node.querySelector('[data-slot=cta]').onclick = onReview;
  setTextSlot(node, 'head', clear ? 'No open incidents' : `${count} active incident${count === 1 ? '' : 's'}`);
  setHTMLSlot(node, 'note', clear ? 'Everything monitored is currently healthy.' : `Oldest open <b class="t-red">${esc(ago(oldest))}</b>`);
  return node;
}

export const meterRow = (label) => el(`<div class="meter"><div class="lab"><span>${esc(label)}</span><b>—</b></div><div class="bar"><i></i></div></div>`);

export function updateMeter(node, label, val, limit) {
  setText(node.querySelector('.lab span'), label);
  const b = node.querySelector('.lab b');
  setText(b, pct(val));
  const over = val !== null && val !== undefined && val > limit;
  b.classList.toggle('over', over);
  const i = node.querySelector('.bar i');
  setStyle(i, 'width', `${Math.max(0, Math.min(100, Number(val) || 0))}%`);
  i.classList.toggle('over', over);
}

const statusHTML = (s, word) => `<span class="stat ${s}"><span class="dot ${s}"></span>${esc(word || STATUS_LABEL[s])}</span>`;

/* ---------- monitors table ---------- */

export const monitorRow = () => el(`<tr>
  <td class="mon"><span class="dot"></span><span class="nm" data-f="name"></span><span class="dt" data-f="detail"></span></td>
  <td data-f="type" data-l="Type"></td>
  <td data-f="status" data-l="Status"></td>
  <td class="muted" data-f="check" data-l="Checked"></td>
  <td class="num" data-f="ms" data-l="Latency"></td>
  <td class="num" data-f="uptime" data-l="Uptime"></td>
  <td class="menu-cell"><button class="icon-btn" data-f="menu" aria-label="Row actions">${icon('dots', 16)}</button></td>
</tr>`);

export function updateMonitorRow(row, m, withUptime = true) {
  const s = statusOf(m);
  setText(row.querySelector('[data-f=name]'), m.name);
  const detail = m.detail || 'not checked yet';
  setText(row.querySelector('[data-f=detail]'), detail);
  setHTML(row.querySelector('[data-f=type]'), typeBadge(m.type));
  setHTML(row.querySelector('[data-f=status]'), statusHTML(s));
  setText(row.querySelector('[data-f=check]'), m.last_check ? ago(m.last_check) : 'pending');
  setText(row.querySelector('[data-f=ms]'), m.ok === null || !m.ms ? 'No signal' : `${m.ms} ms`);
  const up = row.querySelector('[data-f=uptime]');
  if (withUptime) setText(up, m.uptime === null ? '—' : `${m.uptime}%`);
  row.querySelector('.dot').className = `dot ${s}`;
  row.classList.toggle('bad', s === 'down');
  row.classList.toggle('warn', s === 'degraded');
  row.title = detail;
  row.dataset.id = m.id;
}

/* ---------- incidents table ---------- */

export const incidentRow = () => el(`<tr>
  <td data-f="hash"></td>
  <td class="name" data-f="title"></td>
  <td data-f="monitor" data-l="Monitor"></td>
  <td class="muted" data-f="started" data-l="Started"></td>
  <td class="muted" data-f="duration" data-l="Duration"></td>
  <td data-f="state" data-l="State"></td>
  <td data-f="act"><button class="btn soft sm" data-act="investigate">Investigate ${icon('arrow', 13)}</button></td>
  <td class="menu-cell"><button class="icon-btn" data-f="menu" aria-label="Row actions">${icon('dots', 16)}</button></td>
</tr>`);

export function updateIncidentRow(row, i, now = Date.now()) {
  setText(row.querySelector('[data-f=hash]'), `#${i.id}`);
  setText(row.querySelector('[data-f=title]'), i.title || i.kind);
  const mon = row.querySelector('[data-f=monitor]');
  const mtype = monitorType(i.monitor_id);
  const src = i.monitor || (i.kind === 'monitor' ? 'monitor deleted' : i.kind === 'agent' ? 'agent heartbeat' : 'host resources');
  setHTML(mon, mtype
    ? `<span class="inline-flex">${icon(typeMeta(mtype).icon, 14)} <span>${esc(i.monitor)}</span> ${typeBadge(mtype)}</span>`
    : `<span class="inline-flex">${icon('cpu', 14)} <span class="muted">${esc(src)}</span></span>`);
  setText(row.querySelector('[data-f=started]'), ago(i.started_at));
  setText(row.querySelector('[data-f=duration]'), dur((i.resolved_at || now) - i.started_at));
  setHTML(row.querySelector('[data-f=state]'), statusHTML(i.state === 'open' ? 'down' : 'up', stateWord(i.state === 'open' ? 'down' : 'up')));
  row.classList.toggle('bad', i.state === 'open');
  row.dataset.id = i.id;
}

const monitorType = (id) => (id ? (store.summary?.monitors || []).find((x) => x.id === id)?.type || null : null);

/* ---------- floating row menu ---------- */

let menuEl;
export function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = undefined; } }

export function openMenu(anchor, items) {
  closeMenu();
  menuEl = el(`<div class="menu" role="menu">${items.map((it, n) =>
    it === '-' ? '<hr>' : `<button data-n="${n}" class="${it.danger ? 'danger' : ''}">${icon(it.icon || 'dot', 15)}<span>${esc(it.label)}</span></button>`).join('')}</div>`);
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const w = menuEl.offsetWidth;
  menuEl.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  let top = r.bottom + 6;
  if (top + menuEl.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menuEl.offsetHeight - 6);
  menuEl.style.top = `${top}px`;
  menuEl.onclick = (e) => {
    const b = e.target.closest('button[data-n]');
    if (!b) return;
    const it = items[+b.dataset.n];
    closeMenu();
    it && it.fn && it.fn();
  };
  setTimeout(() => document.addEventListener('pointerdown', onDoc, { once: true }), 0);
}
function onDoc(e) {
  if (menuEl && !menuEl.contains(e.target)) return closeMenu();
  if (menuEl) setTimeout(() => document.addEventListener('pointerdown', onDoc, { once: true }), 0);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
