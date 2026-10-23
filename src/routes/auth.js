import crypto from 'node:crypto';
import express from 'express';
import { cfg } from '../config.js';
import { setting, setSetting } from '../db.js';

const NAME = 'wm_session';
const b64 = (s) => Buffer.from(s).toString('base64url');
const logoutAt = () => Number(setting('logout_at') || 0);

const sign = (payload) => {
  const body = b64(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url')}`;
};

function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest();
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

export function auth(req, res, next) {
  const p = verify(parseCookies(req)[NAME]);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  req.user = p;
  next();
}

const attempts = new Map();
const BLOCK_MS = 10 * 60000;
const hash = (p) => crypto.scryptSync(String(p), cfg.sessionSecret, 32).toString('hex');

export const router = express.Router();

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const rec = attempts.get(ip) || { n: 0, t: 0 };
  if (rec.n >= 6 && Date.now() - rec.t < BLOCK_MS) {
    return res.status(429).json({ error: `Too many failed logins. Retry in ${Math.ceil((BLOCK_MS - (Date.now() - rec.t)) / 1000)}s.` });
  }
  const got = String(req.body?.password || '');
  const want = String(cfg.password);
  const ok = got.length > 0 && got.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(hash(got)), Buffer.from(hash(want)));
  if (!ok) {
    attempts.set(ip, { n: rec.n + 1, t: Date.now() });
    console.warn(`[auth] failed login from ${ip} (${rec.n + 1})`);
    return res.status(401).json({ error: 'Wrong password.' });
  }
  attempts.delete(ip);
  const token = sign({ u: 'admin', iat: Date.now(), exp: Date.now() + cfg.sessionHours * 36e5 });
  res.setHeader('set-cookie', `${NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${cfg.sessionHours * 3600}`);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  setSetting('logout_at', String(Date.now()));
  res.setHeader('set-cookie', `${NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// 401 when there is no session — the SPA's gate (and curl probes) depend on the status, not the body
router.get('/me', (req, res) => {
  const u = verify(parseCookies(req)[NAME])?.u;
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: u, ai: cfg.aiProvider, telegram: !!cfg.telegramToken });
});
