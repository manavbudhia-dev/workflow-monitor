export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
};
export const shortAgo = (t) => (!t ? '—' : `${Math.max(0, Math.round((Date.now() - t) / 6e4))}m ago`);

export const dur = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const m = Math.floor(ms / 6e4);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

export const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v) ? '—' : `${(+v).toFixed(d)}%`);
export const fixed = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v) ? '—' : (+v).toFixed(d));
export const signed = (v, d = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${(+v).toFixed(d)}`);
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const dayTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const bytes = (n) => {
  if (n === null || n === undefined || Number.isNaN(+n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = +n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : v} ${u[i]}`;
};

/** Only touch the DOM when the value really changed — this is what keeps the 30s refresh flicker-free. */
export function setText(node, txt) {
  if (node && node.textContent !== txt) node.textContent = txt;
  return node;
}
export function setHTML(node, html) {
  if (node && node.__h !== html) { node.__h = html; node.innerHTML = html; }
  return node;
}
export function setAttr(node, name, val) {
  if (node && node.getAttribute(name) !== val) node.setAttribute(name, val);
  return node;
}
export function setStyle(node, prop, val) {
  if (node && node.style[prop] !== val) node.style[prop] = val;
  return node;
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Keyed list diff: reuses existing nodes, updates in place, removes stale ones. */
export function syncList(container, items, key, create, update) {
  const keep = new Map();
  for (const node of Array.from(container.children)) if (node.dataset.key) keep.set(node.dataset.key, node);
  let cursor = container.firstElementChild;
  for (const [i, item] of items.entries()) {
    const k = String(key(item));
    let node = keep.get(k);
    if (node) keep.delete(k);
    else { node = create(item); node.dataset.key = k; container.insertBefore(node, cursor || null); }
    update(node, item, i);
  }
  for (const stale of keep.values()) stale.remove();
  return items.length;
}

export function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function copy(text, btn) {
  const label = btn ? btn.textContent : null;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = label), 1400); }
  } catch {
    const i = document.createElement('input');
    i.value = text; document.body.append(i); i.select(); document.execCommand('copy'); i.remove();
    if (btn) { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = label), 1400); }
  }
}
