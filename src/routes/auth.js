import crypto from 'node:crypto';
import express from 'express';
import { cfg } from '../config.js';
import { setting, setSetting, run, now } from '../db.js';
import { send } from '../alerts/telegram.js';

const NAME = 'wm_session';

/**
 * The cookie signing key. Without SESSION_SECRET in .env the old fallback was a constant string
 * published in this repo, so anyone could mint a valid admin cookie. Now an unset secret becomes a
 * random one, kept in the database so logins survive a restart.
 */
const SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = setting('session_secret', '');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); }
  return s;
})();
const b64 = (s) => Buffer.from(s).toString('base64url');
const logoutAt = () => Number(setting('logout_at') || 0);

const sign = (payload) => {
  const body = b64(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};

function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    // iat < logout_at means this token predates the last logout, so it is dead even though the signature is valid
    return p.exp > Date.now() && (p.iat || 0) >= logoutAt() ? p : null;
  } catch { return null; }
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Cross-site request guard on top of SameSite=Strict: a state-changing call whose Origin
 * (or Referer) names another site is refused even if a browser did attach the cookie.
 */
function sameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const src = req.get('origin') || req.get('referer');
  if (!src) return true; // curl and other non-browser clients send neither
  try { return new URL(src).host === req.get('host'); } catch { return false; }
}

export function auth(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-site request refused' });
  const p = verify(parseCookies(req)[NAME]);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  req.user = p;
  next();
}

const attempts = new Map();
const BLOCK_MS = 10 * 60000;
const MAX_FAILS = 6;
const hash = (p) => crypto.scryptSync(String(p), SECRET, 32);
const WANT = hash(cfg.password);

/** Passwords anyone would try first. With one of these, the dashboard only opens from this box. */
const WEAK = new Set(['', 'admin', 'changeme', 'password', '123456', 'pulse', 'monitor']);
export const weakPassword = () => WEAK.has(String(cfg.password).toLowerCase()) || String(cfg.password).length < 8;
const isLoopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(String(ip || ''));

// All IPs together: scrypt is deliberately slow, so a flood from many addresses must not pin the CPU.
let globalWindow = { t: 0, n: 0 };
const GLOBAL_PER_MIN = 30;

/** Login/lockout events go to the Security page's alert list, so a lockout is never silent. */
const record = (kind, ip, detail) => {
  try { run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)', kind, ip, 'dashboard', detail, 1, now()); } catch { /* table missing in tests */ }
};

const cookie = (req, value, maxAge) =>
  `${NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

export const router = express.Router();

router.post('/login', async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-site request refused' });
  const ip = req.ip || 'unknown';
  const t = Date.now();
  if (t - globalWindow.t > 60000) globalWindow = { t, n: 0 };
  if (++globalWindow.n > GLOBAL_PER_MIN) return res.status(429).json({ error: 'Too many login attempts right now. Try again in a minute.' });

  // A stale entry should not keep re-locking forever, and the map must not grow without bound.
  if (attempts.size > 5000) for (const [k, v] of attempts) if (t - v.t > BLOCK_MS) attempts.delete(k);
  let rec = attempts.get(ip) || { n: 0, t: 0 };
  if (rec.n >= MAX_FAILS && t - rec.t >= BLOCK_MS) rec = { n: 0, t: 0 };
  if (rec.n >= MAX_FAILS) {
    return res.status(429).json({ error: `Too many failed logins. Retry in ${Math.ceil((BLOCK_MS - (t - rec.t)) / 1000)}s.` });
  }
  if (weakPassword() && !isLoopback(ip)) {
    return res.status(403).json({ error: 'PASSWORD in .env is a default or shorter than 8 characters, so remote logins are disabled. Set a strong PASSWORD and restart the service (or log in through an SSH tunnel).' });
  }
  const ok = crypto.timingSafeEqual(hash(String(req.body?.password || '')), WANT);
  if (!ok) {
    const n = rec.n + 1;
    attempts.set(ip, { n, t });
    console.warn(`[auth] failed login from ${ip} (${n})`);
    if (n === MAX_FAILS) {
      record('web_lock', ip, `dashboard locked for this IP after ${n} wrong passwords`);
      send(`🔒 *DASHBOARD LOGIN LOCKED*\n${n} wrong passwords from ${ip}\nThis IP is blocked for ${BLOCK_MS / 60000} min.`).catch(() => {});
    }
    // A small fixed delay makes guessing slower without holding a thread.
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'Wrong password.' });
  }
  attempts.delete(ip);
  record('web_login', ip, 'dashboard login');
  const token = sign({ u: 'admin', iat: Date.now(), exp: Date.now() + cfg.sessionHours * 36e5 });
  res.setHeader('set-cookie', cookie(req, token, cfg.sessionHours * 3600));
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-site request refused' });
  setSetting('logout_at', String(Date.now()));
  res.setHeader('set-cookie', cookie(req, '', 0));
  res.json({ ok: true });
});

// 401 when there is no session — the SPA's gate (and curl probes) depend on the status, not the body
router.get('/me', (req, res) => {
  const u = verify(parseCookies(req)[NAME])?.u;
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: u, ai: cfg.aiProvider, telegram: !!cfg.telegramToken });
});
