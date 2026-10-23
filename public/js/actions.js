import { api, store, logSourceFor } from './api.js';
import { icon } from './icons.js';
import { esc, copy } from './util.js';

/** Hooks app.js fills in so components never reach back into the router. */
export const bus = { refresh: () => {}, openForm: () => {}, openIncident: () => {}, go: (h) => (location.hash = h) };

let toastEl, toastTimer;
export function toast(msg, tone = '') {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.append(toastEl); }
  toastEl.className = `toast ${tone}`;
  toastEl.innerHTML = `${icon(tone === 'err' ? 'alert' : 'check', 15)}<span>${esc(msg)}</span>`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

const guard = async (fn) => {
  try { await fn(); } catch (e) { toast(e.message, 'err'); }
};

export const checkMonitor = (m) => guard(async () => {
  const r = await api(`/monitors/${m.id}/check`, { method: 'POST', body: {} });
  toast(r.skip ? `${m.name}: skipped (${r.skip})` : `${m.name}: ${r.ok ? 'up' : 'down'} — ${r.detail || ''}`, r.ok ? '' : 'err');
  bus.refresh();
});

export const runAllNow = async (btn) => {
  if (btn) { btn.disabled = true; btn.classList.add('spin'); }
  await guard(async () => {
    const rows = await api('/check-now', { method: 'POST', body: {} });
    const bad = rows.filter((r) => r.ok === false).length;
    toast(`Checked ${rows.length} monitor${rows.length === 1 ? '' : 's'}${bad ? ` · ${bad} failing` : ''}`, bad ? 'err' : '');
    bus.refresh();
  });
  if (btn) { btn.disabled = false; btn.classList.remove('spin'); }
};

export const toggleMonitor = (m) => guard(async () => {
  await api(`/monitors/${m.id}/toggle`, { method: 'POST', body: {} });
  toast(`${m.name} ${m.enabled ? 'paused' : 'resumed'}`);
  bus.refresh();
});

export const deleteMonitor = (m) => guard(async () => {
  if (!confirm(`Delete monitor "${m.name}"? Its check history goes with it.`)) return;
  await api(`/monitors/${m.id}`, { method: 'DELETE' });
  toast(`${m.name} deleted`);
  bus.refresh();
});

export const resolveIncident = (i) => guard(async () => {
  await api(`/incidents/${i.id}/resolve`, { method: 'POST', body: {} });
  toast(`Incident #${i.id} marked resolved`);
  bus.refresh();
});

/** Row menu contents, shared by Overview and the Monitors page. */
export function monitorMenu(m) {
  const items = [
    { label: 'Check now', icon: 'refresh', fn: () => checkMonitor(m) },
    { label: 'Edit', icon: 'pencil', fn: () => bus.openForm(m) },
    { label: m.enabled ? 'Pause' : 'Resume', icon: m.enabled ? 'pause' : 'play', fn: () => toggleMonitor(m) },
  ];
  const log = logSourceFor(m);
  if (log) items.push({ label: 'View logs', icon: 'logs', fn: () => bus.go(`#/logs?src=${encodeURIComponent(log)}`) });
  if (m.ping_url) items.push({ label: 'Copy ping URL', icon: 'copy', fn: () => copy(m.ping_url) });
  items.push('-', { label: 'Delete', icon: 'trash', danger: true, fn: () => deleteMonitor(m) });
  return items;
}

export function incidentMenu(i) {
  const m = (store.summary?.monitors || []).find((x) => x.id === i.monitor_id);
  const log = logSourceFor(m);
  return [
    { label: 'Investigate', icon: 'sparkles', fn: () => bus.openIncident(i.id) },
    ...(log ? [{ label: 'View logs', icon: 'logs', fn: () => bus.go(`#/logs?src=${encodeURIComponent(log)}`) }] : []),
    ...(i.state === 'open' ? [{ label: 'Mark resolved', icon: 'check', fn: () => resolveIncident(i) }] : []),
  ];
}

export const n8nLink = (monitorId) => {
  const m = (store.summary?.monitors || []).find((x) => x.id === monitorId);
  const url = (m?.config?.url || '').replace(/\/+$/, '');
  if (!url) return null;
  return m.config.workflow_id ? `${url}/workflow/${encodeURIComponent(m.config.workflow_id)}` : url;
};
