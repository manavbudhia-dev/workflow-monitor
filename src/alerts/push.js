/**
 * Web Push with VAPID, written against node:crypto only (no extra packages).
 * The push itself is a silent ping: the service worker is told to look, then it fetches the
 * open-incident count over the normal same-origin API. No log lines or secrets go through a
 * push service, and the browser stays the source of truth for what is shown.
 */
import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { q, get, run, now } from '../db.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

export const pushReady = () => !!(cfg.pushPublic && cfg.pushPrivate);
export const pushCount = () => get('SELECT COUNT(*) n FROM push_sub').n;

/** P-256 signature: DER from node:crypto, fixed-width R||S as JSON Web Signature needs. */
function derToJose(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('bad signature');
  i++;
  const part = () => {
    if (der[i++] !== 0x02) throw new Error('bad signature');
    const len = der[i++];
    let bytes = der.subarray(i, i + len);
    i += len;
    while (bytes.length && bytes[0] === 0x00) bytes = bytes.subarray(1);
    if (bytes.length > 32) throw new Error('bad signature');
    return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
  };
  return Buffer.concat([part(), part()]);
}

function privateKey() {
  const d = fromB64u(cfg.pushPrivate);
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32 bytes of base64url');
  const pub = fromB64u(cfg.pushPublic);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY must be the 65-byte uncompressed point');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(d) },
  });
}

export function vapidHeaders(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: cfg.pushSubject }));
  const body = `${head}.${payload}`;
  const sig = derToJose(crypto.sign('sha256', Buffer.from(body), privateKey()));
  return { authorization: `vapid t=${body}.${b64u(sig)}, k=${cfg.pushPublic}` };
}

/** Only real push services — otherwise a stored subscription would turn into an SSRF. */
export function safeEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:') return 'push endpoints must be https';
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return 'push endpoint points at a private host';
  if (/^(127\.|10\.|192\.168\.|0\.)/.test(h)) return 'push endpoint points at a private address';
  if (/^\[?::1|^[fd78]:/i.test(h)) return 'push endpoint points at a loopback address';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'push endpoint points at a private address';
  return null;
}

export function addSubscription(sub) {
  const endpoint = String(sub?.endpoint || '');
  const bad = safeEndpoint(endpoint);
  if (bad) return { error: bad };
  const keys = { p256dh: String(sub?.keys?.p256dh || ''), auth: String(sub?.keys?.auth || '') };
  if (!keys.p256dh || !keys.auth) return { error: 'subscription is missing its p256dh / auth keys' };
  run('INSERT INTO push_sub(endpoint, keys, created_at) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys, last_error=NULL',
    endpoint, JSON.stringify(keys), now());
  return { ok: true, count: pushCount() };
}

export const dropSubscription = (endpoint) => {
  run('DELETE FROM push_sub WHERE endpoint=?', String(endpoint || ''));
  return { ok: true, count: pushCount() };
};

/** One ping per subscription. Expired endpoints are pruned the moment the push service says 404/410. */
export async function pushPing({ title = 'Workflow Monitor', tag = 'wm', body = '' } = {}) {
  if (!pushReady()) return { skipped: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set' };
  const rows = q('SELECT endpoint, keys FROM push_sub');
  if (!rows.length) return { skipped: 'nobody is subscribed' };
  const out = { sent: 0, failed: 0, pruned: 0, errors: [] };
  for (const r of rows) {
    try {
      const res = await fetch(r.endpoint, {
        method: 'POST',
        headers: { ...vapidHeaders(r.endpoint), ttl: '300', 'content-length': '0', 'x-notification': JSON.stringify({ title, tag }) },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 410) { run('DELETE FROM push_sub WHERE endpoint=?', r.endpoint); out.pruned++; continue; }
      if (!res.ok) throw new Error(`push service said ${res.status}`);
      run('UPDATE push_sub SET sent_at=? WHERE endpoint=?', now(), r.endpoint);
      out.sent++;
    } catch (e) {
      out.failed++;
      out.errors.push(`${new URL(r.endpoint).host}: ${e.message}`.slice(0, 200));
      run('UPDATE push_sub SET last_error=? WHERE endpoint=?', String(e.message).slice(0, 200), r.endpoint);
    }
  }
  return { ...out, total: rows.length };
}

export const pushInfo = () => ({
  ready: pushReady(),
  public_key: cfg.pushPublic || null,
  subscribers: pushCount(),
  rows: q('SELECT endpoint, last_error, sent_at, created_at FROM push_sub ORDER BY created_at DESC LIMIT 20')
    .map((r) => ({ host: (() => { try { return new URL(r.endpoint).host; } catch { return '?'; } })(), last_error: r.last_error, sent_at: r.sent_at, created_at: r.created_at })),
});
