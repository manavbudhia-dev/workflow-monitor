/*
 * Pulse Monitor service worker.
 * Shell: cache-first with a background refresh, so a cold phone opens the dashboard offline.
 * API:   network-first, and the last good JSON response per URL is kept as the offline fallback.
 * Log tail (SSE) and every non-GET are never touched.
 */
const V = 'pulse-v1';
const SHELL = [
  '/', '/index.html', '/login.html', '/login.js', '/manifest.webmanifest',
  '/css/pulse.css', '/vendor/chart.umd.js',
  '/js/app.js', '/js/api.js', '/js/actions.js', '/js/charts.js', '/js/components.js',
  '/js/icons.js', '/js/modals.js', '/js/pwa.js', '/js/util.js',
  '/js/pages/overview.js', '/js/pages/monitors.js', '/js/pages/workflows.js', '/js/pages/incidents.js',
  '/js/pages/security.js', '/js/pages/logs.js', '/js/pages/hosts.js', '/js/pages/integrations.js', '/js/pages/settings.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-192.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(`${V}-shell`).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(V)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const tell = (offline) => self.clients.matchAll({ type: 'window' })
  .then((list) => list.forEach((cl) => cl.postMessage({ type: 'net', offline })));

/** Keep the newest good response per API URL so an offline reload still shows real numbers. */
async function apiFirst(req) {
  const cache = await caches.open(`${V}-api`);
  try {
    const res = await fetch(req);
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      cache.put(req.url, res.clone()).catch(() => { /* quota */ });
      tell(false);
    }
    return res;
  } catch (e) {
    const last = await cache.match(req.url);
    tell(true);
    if (last) {
      const body = new Response(last.body, last);
      body.headers.append('x-served-from', 'cache');
      return body;
    }
    return new Response(JSON.stringify({ error: 'offline and nothing cached yet' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
}

/** Assets: return the cached copy immediately, then refresh it in the background. */
async function shellFirst(req) {
  const cache = await caches.open(`${V}-shell`);
  const hit = await cache.match(req.url, { ignoreSearch: true });
  const live = fetch(req).then((res) => {
    if (res.ok) cache.put(req.url, res.clone()).catch(() => { /* quota */ });
    return res;
  }).catch(() => null);
  if (hit) { live.then((r) => r?.body?.cancel?.()); return hit; }
  const net = await live;
  if (net) return net;
  const fallback = req.mode === 'navigate' ? await cache.match('/index.html') : null;
  return fallback || new Response('offline', { status: 503 });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/api/')) {
    if (u.pathname.endsWith('/stream')) return; // live tail: hand it straight to the network
    e.respondWith(apiFirst(req));
    return;
  }
  e.respondWith(shellFirst(req));
});

/* ---------- web push ---------- */

self.addEventListener('push', (e) => {
  // The server pings with no payload on purpose: the text is read back from the authenticated API,
  // so nothing sensitive ever sits in a push service's queue.
  e.waitUntil((async () => {
    let body = 'Open the dashboard for details.';
    try {
      const r = await fetch('/api/incidents?state=open&limit=5', { credentials: 'same-origin' });
      if (r.ok) {
        const rows = await r.json();
        body = rows.length ? `${rows.length} open incident${rows.length === 1 ? '' : 's'}: ${rows.map((x) => x.title).join(', ')}`.slice(0, 180) : 'No open incidents right now.';
      } else if (r.status === 401) body = 'Sign in to the dashboard to see what changed.';
    } catch { /* offline — the generic body is fine */ }
    return self.registration.showNotification('Workflow Monitor', { body, tag: 'wm', icon: '/icons/icon-192.png', badge: '/icons/maskable-192.png', data: { url: '/#/incidents' } });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const cl of list) {
      if ('focus' in cl) { cl.navigate(e.notification.data.url); return cl.focus(); }
    }
    return self.clients.openWindow(e.notification.data.url);
  })());
});
