import { store, api } from '../api.js';
import { icon } from '../icons.js';
import { card, openMenu } from '../components.js';
import { toast, bus } from '../actions.js';
import { openModal, closeModal } from '../modals.js';
import { el, esc, syncList, setText, setHTML, copy } from '../util.js';

const clientCard = () => el(`<div class="dcard">
  <header><span class="dot"></span><b data-f=name></b><span data-f=badge></span></header>
  <div class="kvs" data-f=kvs></div>
  <div class="copy-row"><input readonly data-f=link><button type="button" class="btn sm" data-f=copy>${icon('copy', 13)} Copy link</button></div>
  <div class="row"><button class="btn soft sm" data-f=edit>${icon('pencil', 14)} Edit</button>
    <a class="btn sm" data-f=open target="_blank" rel="noopener">${icon('eye', 14)} Status page</a>
    <span class="spacer"></span><button class="icon-btn" data-f=menu>${icon('dots', 16)}</button></div>
</div>`);

export function build(root) {
  const grid = card({
    id: 'clientGrid', title: 'Clients', iconName: 'layers',
    tools: `<button class="btn primary sm" data-f=add>${icon('plus', 15)} Add client</button>`,
    body: '<div class="cards" data-f=body></div><div class="empty" data-f=empty hidden>No clients yet. Add one, then pick it on a monitor (Edit monitor → Client) or on an agent (Hosts → ⋯ → Assign to client).</div>',
  });
  const note = el(`<div class="note">A client gets alerts for their own monitors in their Telegram group or inbox (no logs, AI notes, restarts or security events), a read-only status page behind the secret link, and a weekly report. You keep getting every alert as before. To find a group's chat id: add your bot to the group, send a message, then open <span class="kv-code">https://api.telegram.org/bot&lt;token&gt;/getUpdates</span>.</div>`);
  root.append(grid, note);
  const body = grid.refs.body.querySelector('[data-f=body]');
  const empty = grid.refs.body.querySelector('[data-f=empty]');
  let rows = [];

  async function load() {
    try { rows = await api('/clients'); } catch (e) { toast(e.message, 'err'); }
    paint();
  }

  function form(c) {
    const b = el(`<form>
      <div class="form-grid">
        <label class="fl">Client name<input data-k=name required placeholder="Kalyanakuri" value="${esc(c?.name || '')}"></label>
        <label class="fl">Telegram chat ids<input data-k=telegram_chats placeholder="-1001234567890" value="${esc((c?.telegram_chats || []).join(', '))}"></label>
        <label class="fl">Alert emails<input data-k=emails placeholder="owner@client.com" value="${esc((c?.emails || []).join(', '))}"></label>
      </div>
      <label class="chk"><input type="checkbox" data-k=weekly_report ${!c || c.weekly_report ? 'checked' : ''}> Send the weekly report</label>
      <div class="hint">Separate several ids or emails with commas. Telegram needs <span class="kv-code">TELEGRAM_BOT_TOKEN</span>; email needs <span class="kv-code">RESEND_API_KEY</span>.</div>
    </form>`);
    const save = async () => {
      const v = (k) => b.querySelector(`[data-k=${k}]`);
      const payload = { name: v('name').value.trim(), telegram_chats: v('telegram_chats').value, emails: v('emails').value, weekly_report: v('weekly_report').checked };
      try {
        await api(c ? `/clients/${c.id}` : '/clients', { method: c ? 'PUT' : 'POST', body: payload });
        closeModal();
        toast(`${payload.name} saved`);
        await load();
        bus.refresh();
      } catch (e) { document.querySelector('.modal [data-slot=msg]').textContent = e.message; }
    };
    openModal({
      title: c ? `Edit ${c.name}` : 'New client', body: b,
      foot: `<button class="btn ghost" data-slot=cancel>Cancel</button><button class="btn primary" data-slot=save>${c ? 'Save' : 'Create client'}</button>`,
      onMount: (h) => {
        h.querySelector('[data-slot=cancel]').onclick = closeModal;
        h.querySelector('[data-slot=save]').onclick = (e) => { e.preventDefault(); save(); };
        b.onsubmit = (e) => { e.preventDefault(); save(); };
      },
    });
  }

  async function act(path, ok, method = 'POST') {
    try { const r = await api(path, { method }); toast(typeof ok === 'function' ? ok(r) : ok); await load(); bus.refresh(); return r; }
    catch (e) { toast(e.message, 'err'); return null; }
  }

  async function preview(c) {
    try {
      const r = await api(`/clients/${c.id}/report`);
      const b = el(`<div><pre class="block" style="white-space:pre-wrap">${esc(r.text)}</pre></div>`);
      openModal({
        title: `${c.name} · weekly report`, body: b,
        foot: '<button class="btn ghost" data-slot=close>Close</button><button class="btn primary" data-slot=send>Send now</button>',
        onMount: (h) => {
          h.querySelector('[data-slot=close]').onclick = closeModal;
          h.querySelector('[data-slot=send]').onclick = async () => { closeModal(); await act(`/clients/${c.id}/report`, (x) => `Report sent${x.telegram ? ' · Telegram ✓' : ''}${x.email ? ' · email ✓' : ''}`); };
        },
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  function paint() {
    empty.hidden = rows.length > 0;
    syncList(body, rows, (c) => c.id, clientCard, (node, c) => {
      node.querySelector('.dot').className = `dot ${c.down ? 'down' : c.monitors ? 'up' : 'pending'}`;
      setText(node.querySelector('[data-f=name]'), c.name);
      setHTML(node.querySelector('[data-f=badge]'), c.down ? `<span class="badge">${c.down} down</span>` : '<span class="badge plain">all good</span>');
      setHTML(node.querySelector('[data-f=kvs]'), `
        <div><span>Monitors</span><span>${c.monitors}</span></div>
        <div><span>Servers (agents)</span><span>${c.servers}</span></div>
        <div><span>Telegram</span><span>${c.telegram_chats.length ? `${c.telegram_chats.length} chat${c.telegram_chats.length === 1 ? '' : 's'}` : '—'}</span></div>
        <div><span>Email</span><span>${c.emails.length ? esc(c.emails.join(', ')) : '—'}</span></div>
        <div><span>Weekly report</span><span>${c.weekly_report ? 'on' : 'off'}</span></div>`);
      const link = node.querySelector('[data-f=link]');
      if (link.value !== c.status_url) link.value = c.status_url;
      node.querySelector('[data-f=copy]').onclick = (e) => copy(c.status_url, e.currentTarget);
      node.querySelector('[data-f=open]').href = c.status_url;
      node.querySelector('[data-f=edit]').onclick = () => form(c);
      node.querySelector('[data-f=menu]').onclick = (e) => openMenu(e.currentTarget, [
        { label: 'Send test alert', icon: 'send', fn: () => act(`/clients/${c.id}/test`, (r) => `Test sent${r.telegram ? ' · Telegram ✓' : r.telegram === false ? ' · Telegram ✗' : ''}${r.email ? ' · email ✓' : r.email === false ? ` · email ✗ ${r.email_error || ''}` : ''}`) },
        { label: 'Preview / send weekly report', icon: 'chart', fn: () => preview(c) },
        { label: 'New status link (old one stops working)', icon: 'key', fn: () => confirm(`Make a new status link for ${c.name}? The current link stops working.`) && act(`/clients/${c.id}/token`, 'New link created') },
        { label: 'Delete client', icon: 'trash', danger: true, fn: () => confirm(`Delete ${c.name}? Their monitors and servers stay, as your own.`) && act(`/clients/${c.id}`, `${c.name} deleted`, 'DELETE') },
      ]);
    });
    setText(grid.querySelector('.panel-head h2 span'), `Clients · ${rows.length}`);
  }

  grid.refs.tools.querySelector('[data-f=add]').onclick = () => form(null);
  load();
  return { update: () => { if (store.summary) paint(); } };
}
