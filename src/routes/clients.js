import express from 'express';
import { q, get, run, now, clients, client } from '../db.js';
import { list, newToken, statusUrl, statusData, statusPage, sendWeeklyReport, weeklyReportText, clientMonitors, clientServers } from '../clients.js';
import { sendTo } from '../alerts/telegram.js';
import { sendEmail, alertEmail } from '../alerts/email.js';

export const router = express.Router();

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const view = (c) => ({
  id: c.id, name: c.name, telegram_chats: list(c.telegram_chats), emails: list(c.emails), weekly_report: !!c.weekly_report,
  status_url: statusUrl(c), monitors: clientMonitors(c).length, servers: clientServers(c).length, created_at: c.created_at,
  down: clientMonitors(c).filter((m) => m.enabled && m.last_ok === 0).length,
});

function fields(b, old = {}) {
  const name = String(b.name ?? old.name ?? '').trim().slice(0, 80);
  if (!name) return { error: 'name is required' };
  const chats = b.telegram_chats !== undefined ? list(Array.isArray(b.telegram_chats) ? b.telegram_chats.join(',') : b.telegram_chats) : list(old.telegram_chats);
  if (chats.some((c) => !/^-?\d{3,20}$/.test(c))) return { error: 'Telegram chat ids are numbers, e.g. -1001234567890 for a group' };
  const emails = b.emails !== undefined ? list(Array.isArray(b.emails) ? b.emails.join(',') : b.emails) : list(old.emails);
  const badMail = emails.find((e) => !EMAIL.test(e));
  if (badMail) return { error: `not an email address: ${badMail}` };
  const weekly = b.weekly_report === undefined ? (old.weekly_report ?? 1) : (b.weekly_report ? 1 : 0);
  return { name, chats: chats.slice(0, 10).join(','), emails: emails.slice(0, 10).join(','), weekly };
}

router.get('/clients', (req, res) => res.json(clients().map(view)));

router.post('/clients', (req, res) => {
  const f = fields(req.body || {});
  if (f.error) return res.status(400).json({ error: f.error });
  try {
    const r = run('INSERT INTO clients(name, telegram_chats, emails, status_token, weekly_report, created_at) VALUES(?,?,?,?,?,?)', f.name, f.chats, f.emails, newToken(), f.weekly, now());
    res.json(view(client(r.lastInsertRowid)));
  } catch { res.status(409).json({ error: 'a client with that name already exists' }); }
});

const load = (req, res) => {
  const c = client(req.params.id);
  if (!c) res.status(404).json({ error: 'client not found' });
  return c;
};

router.put('/clients/:id', (req, res) => {
  const c = load(req, res); if (!c) return;
  const f = fields(req.body || {}, c);
  if (f.error) return res.status(400).json({ error: f.error });
  try { run('UPDATE clients SET name=?, telegram_chats=?, emails=?, weekly_report=? WHERE id=?', f.name, f.chats, f.emails, f.weekly, c.id); }
  catch { return res.status(409).json({ error: 'a client with that name already exists' }); }
  res.json(view(client(c.id)));
});

/** The monitors and servers stay; they just go back to being your own. */
router.delete('/clients/:id', (req, res) => {
  const c = load(req, res); if (!c) return;
  run('UPDATE monitors SET client_id=NULL WHERE client_id=?', c.id);
  run('UPDATE servers SET client_id=NULL WHERE client_id=?', c.id);
  run('DELETE FROM clients WHERE id=?', c.id);
  res.json({ ok: true });
});

/** New secret link; the old one stops working at once. */
router.post('/clients/:id/token', (req, res) => {
  const c = load(req, res); if (!c) return;
  run('UPDATE clients SET status_token=? WHERE id=?', newToken(), c.id);
  res.json(view(client(c.id)));
});

router.get('/clients/:id/status', (req, res) => { const c = load(req, res); if (c) res.json(statusData(c)); });
router.get('/clients/:id/report', (req, res) => { const c = load(req, res); if (c) res.json({ text: weeklyReportText(c) }); });
router.post('/clients/:id/report', async (req, res) => { const c = load(req, res); if (c) res.json(await sendWeeklyReport(c)); });

router.post('/clients/:id/test', async (req, res) => {
  const c = load(req, res); if (!c) return;
  const chats = list(c.telegram_chats), emails = list(c.emails);
  if (!chats.length && !emails.length) return res.status(400).json({ error: 'Add a Telegram chat id or an email first' });
  const text = `✅ Monitoring alerts for ${c.name} will arrive here.\nLive status: ${statusUrl(c)}`;
  const [telegram, mail] = await Promise.all([
    chats.length ? sendTo(chats, text) : null,
    emails.length ? sendEmail({ to: emails, subject: `✅ Monitoring alerts for ${c.name}`, ...alertEmail({ down: false, title: `Alerts for ${c.name} are set up`, label: 'TEST', links: [['Open status page', statusUrl(c)]] }) }) : null,
  ]);
  res.json({ telegram, email: mail ? mail.sent : null, email_error: mail?.error || null });
});

/** Assign one server (its agent metrics, and every monitor on it without its own client) to a client. */
router.put('/servers/:id/client', (req, res) => {
  const s = get('SELECT * FROM servers WHERE id=?', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'server not found' });
  const cid = req.body?.client_id ? Number(req.body.client_id) : null;
  if (cid && !client(cid)) return res.status(400).json({ error: 'unknown client' });
  if (s.is_local && cid) return res.status(400).json({ error: 'the hub itself stays yours; assign its monitors to the client instead' });
  run('UPDATE servers SET client_id=? WHERE id=?', cid, s.id);
  res.json({ ok: true, id: s.id, client_id: cid });
});

/* ---------- public: the client's status page (no login; the secret link is the credential) ---------- */

export const publicRouter = express.Router();
const byToken = (t) => (/^[A-Za-z0-9_-]{16,64}$/.test(String(t)) ? get('SELECT * FROM clients WHERE status_token=?', String(t)) : undefined);

publicRouter.get('/status/:token', (req, res) => {
  const c = byToken(req.params.token);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  if (!c) return res.status(404).type('html').send('<!doctype html><meta name="robots" content="noindex"><title>Not found</title><p style="font-family:system-ui;padding:40px">This status link is not valid. Ask for a new one.</p>');
  res.type('html').send(statusPage(statusData(c)));
});
publicRouter.get('/api/public/status/:token', (req, res) => {
  const c = byToken(req.params.token);
  res.setHeader('cache-control', 'no-store');
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(statusData(c));
});
