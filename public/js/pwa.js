/**
 * Progressive-web-app layer: service worker, offline banner, install prompt,
 * pull-to-refresh and the web-push subscription helpers used by Settings.
 */
import { api } from './api.js';
import { icon } from './icons.js';
import { el, esc, setText } from './util.js';

const bar = el(`<div class="netbar" hidden><span class="dot"></span><b data-f=t></b></div>`);
document.body.append(bar);
export function netBanner(offline, msg) {
  bar.hidden = !offline;
  bar.classList.toggle('off', !!offline);
  document.body.classList.toggle('net-off', !!offline);
  setText(bar.querySelector('[data-f=t]'), msg || 'You are offline, showing last data');
}

// Registered while this module is still evaluating: the worker answers the very first
// blocked API call with a cached copy, and that message must not be missed.
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'net') netBanner(e.data.offline); });

let deferred = null;
let installBtn = null;

// Chrome can fire this before the dashboard finishes booting, so listen while this module is still loading.
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; wireInstall(); });
addEventListener('appinstalled', () => { deferred = null; setInstall(null); });

function setInstall(label, fn, hint) {
  if (!installBtn) {
    installBtn = el('<button class="btn sm" id="installBtn" type="button"></button>');
    document.querySelector('.topbar .tools')?.insertBefore(installBtn, document.querySelector('#refreshBtn'));
  }
  if (!label) { installBtn.hidden = true; return; }
  installBtn.hidden = false;
  installBtn.innerHTML = `${icon('download', 14)}<span>${esc(label)}</span>`;
  installBtn.title = hint || '';
  installBtn.onclick = fn;
}

function wireInstall() {
  if (!deferred) return;
  setInstall('Install app', async () => {
    deferred.prompt();
    const r = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (r.outcome === 'accepted') { deferred = null; setInstall(null); }
  });
}

export async function initPwa(refresh) {
  if (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)) {
    try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { /* http on a LAN ip: no SW, everything else still works */ }
  }
  window.addEventListener('online', () => netBanner(false));
  window.addEventListener('offline', () => netBanner(true));
  wireInstall();

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches) {
    setInstall('Add to Home Screen', () => {
      setInstall(null);
      localStorage.setItem('ios-hint', '1');
    }, 'Tap Share, then "Add to Home Screen" — iOS has no install prompt');
    if (!localStorage.getItem('ios-hint')) {
      document.body.append(el(`<div class="note ios-hint" id="iosHint">To install on iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.
        <button class="btn sm ghost" data-f=x>Got it</button></div>`));
      document.querySelector('#iosHint [data-f=x]').onclick = () => { document.querySelector('#iosHint').remove(); localStorage.setItem('ios-hint', '1'); };
    }
  }

  if (!/iphone|ipad|ipod/i.test(navigator.userAgent) && 'ontouchstart' in window) pullToRefresh(refresh);
}

/** Pull down from the very top of Overview and the dashboard re-reads the API. */
function pullToRefresh(refresh) {
  const ind = el('<div class="ptr" hidden>' + icon('refresh', 15) + '<span>Pull to refresh</span></div>');
  document.querySelector('.page')?.prepend(ind);
  let y0 = 0, dist = 0, busy = false;
  const page = document.scrollingElement || document.documentElement;
  window.addEventListener('touchstart', (e) => {
    y0 = e.touches[0].clientY; dist = 0;
    ind.hidden = page.scrollTop <= 0 && location.hash.replace(/^#\/?/, '').startsWith('overview') && !busy;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (ind.hidden) return;
    dist = Math.max(0, e.touches[0].clientY - y0);
    ind.style.transform = `translate(-50%, ${Math.min(dist * 0.5, 60)}px)`;
    ind.classList.toggle('ready', dist > 70);
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (ind.hidden || dist < 70 || busy) return;
    busy = true;
    ind.classList.add('spin');
    ind.querySelector('span').textContent = 'Refreshing…';
    await refresh().catch(() => null);
    ind.classList.remove('spin', 'ready');
    ind.hidden = true;
    ind.querySelector('span').textContent = 'Pull to refresh';
    busy = false;
  });
}

/* ---------- web push ---------- */

export async function pushStatus() {
  const info = await api('/push/info');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  const perm = navigator.permissions?.query ? (await navigator.permissions.query({ name: 'push' }).catch(() => null))?.state : 'prompt';
  const sub = supported ? await navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()) : null;
  return { ...info, supported, perm, subscribed: !!sub, endpoint_host: sub ? new URL(sub.endpoint).host : null };
}

export async function pushEnable() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser has no push support');
  const key = (await api('/push/info')).public_key;
  if (!key) throw new Error('VAPID_PUBLIC_KEY is not set in .env');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
  const j = await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  return { ...j, host: new URL(sub.endpoint).host };
}

export async function pushDisable() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
  return { ok: true };
}

function urlBase64ToBytes(key) {
  const pad = key.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
