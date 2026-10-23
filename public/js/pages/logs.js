/**
 * Logs page — read-only tail of the sources whitelisted in .env (LOG_SOURCES).
 * The browser only ever names a source; the server resolves that name into a fixed argv array.
 */
import { api } from '../api.js';
import { icon } from '../icons.js';
import { card } from '../components.js';
import { toast } from '../actions.js';
import { el, esc, setText, setHTML } from '../util.js';

const LEVELS = [['', 'All'], ['error', 'Error'], ['warn', 'Warn'], ['info', 'Info']];
const MAX_KEEP = 2000;

const levelClass = (v) => (v === 'error' ? 'err' : v === 'warn' ? 'warn' : 'info');

/** Write text, then wrap the matched part in <mark> — never innerHTML with log content. */
function paintLine(node, text, needle) {
  node.textContent = '';
  if (!needle) return void (node.textContent = text);
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return void (node.textContent = text);
  node.append(document.createTextNode(text.slice(0, at)));
  const m = document.createElement('mark');
  m.textContent = text.slice(at, at + needle.length);
  node.append(m, document.createTextNode(text.slice(at + needle.length)));
}

export function build(root, params = {}) {
  const state = { src: params.get('src') || '', lines: [], max: 1000, es: null, tailing: false, auto: true, at: 0, err: '' };

  const srcSel = '<select data-f=src></select>';
  const controls = card({
    id: 'logCtl', title: 'Log viewer', iconName: 'logs',
    tools: `<span class="field sm">${icon('logs', 14)}${srcSel}</span>
      <span class="field sm">${icon('calendar', 14)}<select data-f=count>
        <option value="50">50 lines</option><option value="200">200 lines</option><option value="1000">1000 lines</option></select></span>
      <span class="search">${icon('search', 14)}<input type="search" data-f=grep placeholder="Search lines" aria-label="Search lines"></span>
      <div class="tabs" data-f=levels>${LEVELS.map(([v, l]) => `<button data-v="${v}" class="${v ? '' : 'active'}">${l}</button>`).join('')}</div>`,
    body: `<div class="row">
        <button class="btn sm" data-f=live>${icon('play', 14)} Live tail</button>
        <label class="chk" style="font-size:12.5px"><input type="checkbox" data-f=auto checked> Auto-scroll</label>
        <span class="spacer"></span>
        <button class="btn sm" data-f=reload>${icon('refresh', 14)} Reload</button>
        <a class="btn sm" data-f=dl href="#">${icon('download', 14)} Download</a>
        <button class="btn sm soft" data-f=ai>${icon('sparkles', 14)} Explain with AI</button>
      </div>
      <div class="note" style="margin-top:10px">Sources are whitelisted in <span class="kv-code">LOG_SOURCES</span> and secrets are masked before the lines leave the server.
        Live tail uses one of <b data-f=cap>2</b> streams and closes itself after <b data-f=idle>10</b> idle minutes.</div>`,
  });

  const viewer = card({
    id: 'logView', title: 'Output', iconName: 'eye',
    tools: '<span class="muted" data-f=meta>—</span>',
    body: '<div class="logbox" data-f=box tabindex="0"></div><div class="empty" data-f=empty hidden></div>',
  });

  const aiCard = card({
    id: 'logAi', title: 'AI read of these lines', iconName: 'sparkles',
    tools: '<span class="muted" data-f=used></span><button class="btn sm ghost" data-f=close>' + icon('x', 14) + '</button>',
    body: '<div class="ai-out" data-f=out>Waiting…</div>',
  });
  aiCard.hidden = true;

  const split = el('<div class="split"></div>');
  split.append(viewer, aiCard);
  const wrap = el('<div class="log-split"></div>');
  wrap.append(controls, split);
  root.append(wrap);

  const src = controls.refs.tools.querySelector('[data-f=src]');
  const count = controls.refs.tools.querySelector('[data-f=count]');
  const grep = controls.refs.tools.querySelector('[data-f=grep]');
  const levels = controls.refs.tools.querySelector('[data-f=levels]');
  const box = viewer.refs.body.querySelector('[data-f=box]');
  const empty = viewer.refs.body.querySelector('[data-f=empty]');
  const meta = viewer.refs.tools.querySelector('[data-f=meta]');
  const liveBtn = controls.refs.body.querySelector('[data-f=live]');
  const autoChk = controls.refs.body.querySelector('[data-f=auto]');
  const aiBtn = controls.refs.body.querySelector('[data-f=ai]');
  const dlBtn = controls.refs.body.querySelector('[data-f=dl]');
  const used = aiCard.refs.tools.querySelector('[data-f=used]');
  const aiOut = aiCard.refs.body.querySelector('[data-f=out]');
  let level = '';

  function render() {
    const needle = grep.value.trim().toLowerCase();
    const rows = state.lines.filter((x) => (!level || x.v === level) && (!needle || x.l.toLowerCase().includes(needle)));
    box.textContent = '';
    const frag = document.createDocumentFragment();
    for (const x of rows) {
      const node = document.createElement('div');
      node.className = `ln ${levelClass(x.v)}`;
      paintLine(node, x.l, needle);
      frag.append(node);
    }
    box.append(frag);
    const hid = state.lines.length - rows.length;
    setHTML(meta, `${rows.length} line${rows.length === 1 ? '' : 's'}${hid ? ` · ${hid} filtered out` : ''} · <span class="muted">${new Date(state.at).toLocaleTimeString()}</span>${state.tailing ? ' · <span class="t-green">live</span>' : ''}`);
    empty.hidden = !!rows.length;
    setText(empty, state.err || 'No lines match. Try a wider search, another level, or Reload.');
    if (state.auto && rows.length) box.scrollTop = box.scrollHeight;
    dlBtn.href = `/api/logs?src=${encodeURIComponent(state.src)}&lines=${count.value}&grep=${encodeURIComponent(grep.value.trim())}&level=${level}&format=text`;
  }

  function stopTail(note) {
    if (state.es) { state.es.close(); state.es = null; }
    state.tailing = false;
    liveBtn.innerHTML = `${icon('play', 14)} Live tail`;
    liveBtn.classList.remove('danger');
    if (note) toast(note, 'err');
  }

  function startTail() {
    if (!state.src) return;
    stopTail('');
    const es = new EventSource(`/api/logs/stream?src=${encodeURIComponent(state.src)}&lines=${count.value}`);
    state.es = es;
    state.tailing = true;
    liveBtn.innerHTML = `${icon('pause', 14)} Pause`;
    liveBtn.classList.add('danger');
    es.onmessage = (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      state.lines = state.lines.concat(d).slice(-MAX_KEEP);
      state.at = Date.now();
      render();
    };
    es.addEventListener('error', (e) => {
      let msg = 'tail stream ended';
      try { msg = JSON.parse(e.data || '{}').message || msg; } catch { /* connection-level error has no data */ }
      stopTail(msg);
    });
    es.addEventListener('end', (e) => {
      let why = 'closed';
      try { why = JSON.parse(e.data || '{}').why || why; } catch { /* ignore */ }
      stopTail('');
      toast(`Live tail stopped: ${why}`);
    });
  }

  async function loadSources() {
    let info;
    try { info = await api('/logs/sources'); } catch (e) { state.err = e.message; render(); return; }
    setText(controls.refs.body.querySelector('[data-f=cap]'), String(info.stream_max));
    setText(controls.refs.body.querySelector('[data-f=idle]'), String(info.idle_min));
    state.max = info.max_lines;
    aiBtn.disabled = !info.ai;
    aiBtn.title = info.ai ? '' : 'Set AI_PROVIDER and AI_API_KEY in .env to use this';
    if (!info.sources.length) {
      src.innerHTML = '<option value="">no sources</option>';
      state.err = 'LOG_SOURCES is empty — add name=journal:unit, name:pm2:app or name:file:/path entries in .env';
      empty.hidden = false;
      return;
    }
    src.innerHTML = info.sources.map((s) => `<option value="${esc(s.name)}">${esc(s.label)}</option>`).join('');
    if (!info.sources.some((s) => s.name === state.src)) state.src = info.sources[0].name;
    src.value = state.src;
    await load();
  }

  async function load() {
    if (!state.src) return;
    state.err = '';
    try {
      const j = await api(`/logs?src=${encodeURIComponent(state.src)}&lines=${count.value}`);
      state.lines = (j.lines || []).slice(-Math.min(+count.value, state.max));
      state.at = Date.now();
    } catch (e) {
      state.lines = [];
      state.err = e.message;
    }
    render();
  }

  src.onchange = async () => { stopTail(''); state.src = src.value; await load(); };
  count.onchange = async () => { if (state.tailing) startTail(); await load(); };
  grep.oninput = render;
  levels.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    level = b.dataset.v;
    levels.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  };
  liveBtn.onclick = () => (state.tailing ? stopTail('') : startTail());
  controls.refs.body.querySelector('[data-f=reload]').onclick = () => load();
  autoChk.onchange = () => { state.auto = autoChk.checked; if (state.auto) render(); };
  dlBtn.onclick = (e) => { if (!state.src) e.preventDefault(); };
  aiCard.refs.tools.querySelector('[data-f=close]').onclick = () => { aiCard.hidden = true; };

  aiBtn.onclick = async () => {
    const sel = String(window.getSelection() || '');
    const text = (sel.trim() || state.lines.map((x) => x.l).join('\n')).slice(0, 200000);
    aiBtn.disabled = true;
    aiCard.hidden = false;
    setText(aiOut, 'Asking the model…');
    try {
      const j = await api('/logs/explain', { method: 'POST', body: { src: state.src, text } });
      setText(aiOut, j.ai || '(no answer)');
      setText(used, `${j.used_lines} line${j.used_lines === 1 ? '' : 's'}${j.errors_only ? ' · errors only' : ''}`);
    } catch (e) {
      setText(aiOut, e.message);
    } finally {
      aiBtn.disabled = false;
    }
  };

  render();
  loadSources();

  return {
    update() {
      // The 30s app tick must not steal lines the operator is reading — only repaint the header.
      if (!state.tailing && !state.lines.length) load();
      setText(meta, state.lines.length ? meta.textContent.replace(/\d+ line/, `${state.lines.length} line`) : '—');
    },
    destroy() { if (state.es) { state.es.close(); state.es = null; } },
  };
}
