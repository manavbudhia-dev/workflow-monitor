import { api, store, logSourceFor } from './api.js';
import { icon } from './icons.js';
import { esc, el, ago, dur, copy } from './util.js';
import { toast } from './actions.js';

const host = el(`<div class="modal" hidden><div class="modal-box">
  <div class="modal-head"><h3 data-slot=title></h3><button class="icon-btn" data-slot=x>${icon('x', 16)}</button></div>
  <div class="modal-body" data-slot=body></div>
  <div class="modal-foot"><span class="msg" data-slot=msg></span><span class="spacer"></span><span data-slot=foot></span></div>
</div></div>`);

export function mountModal(root = document.body) { root.append(host); }

export function closeModal() { host.hidden = true; host.querySelector('[data-slot=body]').innerHTML = ''; }

export function openModal({ title, body, foot = '', onMount }) {
  host.querySelector('[data-slot=title]').textContent = title;
  host.querySelector('[data-slot=msg]').textContent = '';
  host.querySelector('[data-slot=msg]').className = 'msg';
  const b = host.querySelector('[data-slot=body]');
  b.innerHTML = '';
  b.append(body);
  host.querySelector('[data-slot=foot]').innerHTML = foot;
  host.hidden = false;
  onMount?.(host);
  return host;
}
host.querySelector('[data-slot=x]').onclick = closeModal;
host.onclick = (e) => { if (e.target === host) closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !host.hidden) closeModal(); });

const say = (text, ok = false) => {
  const m = host.querySelector('[data-slot=msg]');
  m.textContent = text;
  m.className = `msg ${ok ? 'ok' : ''}`;
};

/* ---------- monitor form (schema driven, same endpoints as before) ---------- */

export async function showMonitorForm(existing) {
  const schema = store.schema || (await api('/schema'));
  const servers = store.summary.servers;
  const m = existing ? { ...existing } : null;
  const cfg = m?.config || {};
  const body = el(`<form id="monForm">
    <div class="form-grid">
      <label class="fl">Name<input id="f-name" type="text" required placeholder="n8n nightly sync" value="${esc(m?.name || '')}"></label>
      <label class="fl">Server<select id="f-server">${servers.map((s) => `<option value="${s.id}" ${s.id === (m?.server_id || store.serverId) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="fl">Type<select id="f-type">${schema.types.map((t) => `<option value="${t}" ${t === (m?.type || 'http') ? 'selected' : ''}>${t.replace('_', ' ')}</option>`).join('')}</select></label>
      <label class="fl">Check every (sec)<input id="f-interval" type="number" min="10" step="10" placeholder="${schema.schema.http.at(-1).ph}" value=""></label>
    </div>
    <div class="form-grid" id="f-fields"></div>
    <label class="chk"><input type="checkbox" id="f-enabled" ${!m || m.enabled ? 'checked' : ''}> Enabled</label>
    <div id="f-extra"></div>
  </form>`);

  const draw = () => {
    const t = body.querySelector('#f-type').value;
    const fields = schema.schema[t].filter((s) => s.k !== 'interval_sec');
    const field = (s) => {
      const v = cfg[s.k];
      if (s.kind === 'checkbox') return `<label class="chk" style="align-self:end"><input data-k="${s.k}" type="checkbox" ${v ? 'checked' : ''}> ${esc(s.label)}</label>`;
      if (s.kind === 'select') {
        const opts = s.opts || [];
        const cur = String(v ?? '');
        const off = cur && !opts.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} — not in whitelist</option>` : '';
        return `<label class="fl">${esc(s.label)}<select data-k="${s.k}"><option value="">${opts.length ? '— none —' : '— RESTART_ALLOW is empty —'}</option>${off}${opts.map((o) => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      }
      return `<label class="fl">${esc(s.label)}<input data-k="${s.k}" type="text" value="${esc(v ?? '')}" placeholder="${esc(s.ph ?? '')}"></label>`;
    };
    body.querySelector('#f-fields').innerHTML = fields.map(field).join('');
    const extra = body.querySelector('#f-extra');
    extra.innerHTML = '';
    if (t === 'cron_heartbeat' && m?.ping_url) {
      const p = el(`<div class="hint">Ping URL (keep it secret):<div class="copy-row" style="margin-top:6px"><input readonly value="${esc(m.ping_url)}"><button type="button" class="btn sm">${icon('copy', 13)} Copy</button></div>
        <p style="margin:8px 0 0">Cron: <code>curl -fsS -m 10 "${esc(m.ping_url)}" || true</code></p></div>`);
      p.querySelector('button').onclick = (e) => copy(m.ping_url, e.currentTarget);
      extra.append(p);
    }
    if (t === 'n8n' && !cfg.url && !cfg.api_key) extra.innerHTML = '<div class="hint" style="margin-top:10px">Blank URL / key falls back to N8N_URL and N8N_API_KEY from .env.</div>';
    if (['systemd', 'pm2'].includes(t)) extra.innerHTML = '<div class="hint" style="margin-top:10px">Log source fields (journal / pm2 / file) feed the AI root-cause step when this monitor fails.</div>';
    if (t === 'backup') extra.innerHTML = '<div class="hint" style="margin-top:10px">A folder plus pattern, or a single file path. Fails when the newest match is older than max age, smaller than min size, or more than 50% smaller than the backup before it.</div>';
    if (!schema.restart?.allow?.length) extra.innerHTML = `${extra.innerHTML}<div class="hint" style="margin-top:10px">Auto-restart needs the command in RESTART_ALLOW (.env) — the list is empty, so saving it ticked will be refused.</div>`;
  };
  body.querySelector('#f-type').onchange = draw;
  draw();

  const save = async () => {
    const config = {};
    for (const i of body.querySelectorAll('#f-fields input, #f-fields select')) {
      if (i.type === 'checkbox') { if (i.checked) config[i.dataset.k] = 1; continue; }
      if (i.value.trim()) config[i.dataset.k] = i.value.trim();
    }
    const interval = body.querySelector('#f-interval').value.trim();
    if (interval) config.interval_sec = Number(interval);
    const payload = {
      name: body.querySelector('#f-name').value.trim(),
      type: body.querySelector('#f-type').value,
      server_id: +body.querySelector('#f-server').value,
      enabled: body.querySelector('#f-enabled').checked,
      config,
    };
    try {
      await api(m ? `/monitors/${m.id}` : '/monitors', { method: m ? 'PUT' : 'POST', body: payload });
      closeModal();
      toast(`${payload.name} saved`);
      await store.afterSave?.();
    } catch (e) { say(e.message); }
  };

  openModal({
    title: m ? `Edit ${m.name}` : 'New monitor',
    body,
    foot: `<button class="btn ghost" data-slot=cancel>Cancel</button><button class="btn primary" data-slot=save>${m ? 'Save changes' : 'Create monitor'}</button>`,
    onMount: (h) => {
      h.querySelector('[data-slot=cancel]').onclick = closeModal;
      h.querySelector('[data-slot=save]').onclick = (e) => { e.preventDefault(); save(); };
      body.onsubmit = (e) => { e.preventDefault(); save(); };
      body.querySelector('#f-name').focus();
    },
  });
}

/* ---------- incident detail + AI explain ---------- */

export async function showIncident(id) {
  const body = el('<div class="mono-block"><pre class="block" data-slot=logs>loading…</pre><div data-slot=restarts></div><div data-slot=aibox></div></div>');
  openModal({
    title: `Incident #${id}`,
    body,
    foot: `<button class="btn ghost" data-slot=close>Close</button><button class="btn primary" data-slot=ai>${icon('sparkles', 14)} Explain with AI</button>`,
    onMount: (h) => {
      h.querySelector('[data-slot=close]').onclick = closeModal;
      h.querySelector('[data-slot=ai]').onclick = () => runExplain(id, body, h);
    },
  });
  let i;
  try { i = await api(`/incidents/${id}`); } catch (e) { return say(e.message); }
  const modal = host;
  modal.querySelector('[data-slot=title]').textContent = `#${i.id} ${i.title || i.kind}`;
  const logs = i.logs || '';
  body.insertAdjacentHTML('afterbegin', `<div class="pill-row" style="margin-bottom:2px">
    <span class="badge ${i.state === 'open' ? 'blue' : ''}">${i.state}</span>
    <span class="muted">${esc(i.monitor?.name || (i.kind === 'monitor' ? 'monitor deleted' : i.kind === 'agent' ? 'agent heartbeat' : 'host resources'))} · started ${ago(i.started_at)} · ${dur((i.resolved_at || Date.now()) - i.started_at)}${logs ? ` · ${logs.length} chars of logs` : ''}</span></div>`);
  body.querySelector('[data-slot=logs]').textContent = logs || '(no logs captured)';
  const log = logSourceFor(i.monitor);
  if (log) {
    const link = el(`<a class="link" href="#/logs?src=${encodeURIComponent(log)}">${icon('logs', 13)} View ${esc(log)} logs</a>`);
    link.onclick = () => closeModal();
    body.querySelector('.pill-row').append(link);
  }
  if (i.restarts?.length) body.querySelector('[data-slot=restarts]').innerHTML = restartBlock(i.restarts);
  if (i.ai) body.querySelector('[data-slot=aibox]').innerHTML = aiBlock(i.ai);
  if (i.state === 'open') {
    const btn = el('<button class="btn sm">Mark resolved</button>');
    btn.onclick = async () => { await api(`/incidents/${i.id}/resolve`, { method: 'POST', body: {} }); closeModal(); toast(`Incident #${i.id} resolved`); store.afterSave?.(); };
    modal.querySelector('[data-slot=foot]').prepend(btn);
  }
}

const aiBlock = (text) => `<div class="hint"><b class="strong">AI root cause</b><pre class="block" style="margin-top:6px">${esc(text)}</pre></div>`;

const RESTART_LABEL = { recovered: 'recovered', gave_up: 'gave up — manual fix', still_down: 'still down', blocked: 'refused by whitelist' };

/** restart_log rows for one monitor — used by the incident modal and the Incidents page. */
export const restartBlock = (rows, heading = `Auto-restart attempts (${rows.length})`) => `<div class="hint">${heading ? `<b class="strong">${esc(heading)}</b>` : ''}
  <div class="tbl-wrap" style="margin-top:6px"><table class="tbl"><tbody>${rows.map((r) => `<tr class="${r.result === 'blocked' ? 'bad' : r.result === 'recovered' ? '' : 'warn'}">
      <td class="mon">#${r.attempt} · ${esc(r.command || '(no command)')}</td>
      <td class="detail">${esc(RESTART_LABEL[r.result] || r.result)}${r.exit_code === null || r.exit_code === undefined ? '' : ` · exit ${r.exit_code}`}</td>
      <td class="num">${ago(r.started_at)}</td></tr>`).join('')}</tbody></table></div>
  ${rows.some((r) => r.output) ? `<pre class="block" style="margin-top:6px">${esc(rows.map((r) => `#${r.attempt} ${r.result} → ${r.output || 'no output'}`).join('\n\n'))}</pre>` : ''}</div>`;

async function runExplain(id, body, hostEl) {
  const slot = body.querySelector('[data-slot=aibox]');
  const btn = hostEl.querySelector('[data-slot=ai]');
  btn.disabled = true;
  btn.innerHTML = `${icon('refresh', 14)} Thinking…`;
  slot.innerHTML = '';
  try {
    const r = await api(`/incidents/${id}/explain`, { method: 'POST', body: {} });
    slot.innerHTML = aiBlock(r.ai || r.error || 'no answer');
  } catch (e) {
    slot.innerHTML = `<div class="hint"><pre class="block" style="border-color:rgba(239,68,68,.35)">${esc(e.message)}</pre></div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('sparkles', 14)} Re-run AI`;
  }
}
