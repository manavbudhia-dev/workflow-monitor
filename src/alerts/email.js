import { cfg } from '../config.js';

/** Email alerts through Resend (https://resend.com). Off unless RESEND_API_KEY and ALERT_EMAIL_TO are set. */
export const emailEnabled = () => !!(cfg.resendKey && cfg.emailTo.length);
export const emailInfo = () => ({ configured: emailEnabled(), key: !!cfg.resendKey, to: cfg.emailTo.length, from: cfg.emailFrom });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Returns { sent, id?, error? } — never throws, so a mail outage can't break the alert path. */
export async function sendEmail({ subject, text, html, to }) {
  // `to` sends to someone other than ALERT_EMAIL_TO (a client); that only needs the Resend key.
  const rcpt = to?.length ? to : cfg.emailTo;
  if (!cfg.resendKey || !rcpt.length) return { sent: false, error: 'Set RESEND_API_KEY and ALERT_EMAIL_TO in .env and restart.' };
  try {
    const r = await fetch(`${cfg.resendBaseUrl}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.emailFrom, to: rcpt, subject: subject.slice(0, 200), text, html }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = j.message || j.error || `${r.status} ${r.statusText}`;
      console.error('[email]', why);
      return { sent: false, error: r.status === 401 || r.status === 403 ? `Resend rejected the request: ${why}` : `Resend error: ${why}` };
    }
    return { sent: true, id: j.id };
  } catch (e) {
    console.error('[email]', e.message);
    return { sent: false, error: `Can't reach Resend (${e.cause?.code || e.message})` };
  }
}

/**
 * One alert email. `rows` are [label, value] pairs; `links` are [label, url] buttons.
 * Plain inline styles only — mail clients ignore stylesheets.
 */
export function alertEmail({ down, title, rows = [], links = [], body = '', label, footer = 'Sent by Pulse Monitor' }) {
  const color = down ? '#dc2626' : '#16a34a';
  const text = [title, '', ...rows.map(([k, v]) => `${k}: ${v}`), body ? `\n${body}` : '', ...links.map(([k, u]) => `${k}: ${u}`)].filter((x) => x !== '').join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111">
  <div style="border-left:4px solid ${color};padding:12px 16px;background:#f8fafc;border-radius:6px">
    <div style="font-size:12px;font-weight:700;letter-spacing:.06em;color:${color}">${esc(label || (down ? 'FAILED' : 'RECOVERED'))}</div>
    <div style="font-size:18px;font-weight:650;margin-top:4px">${esc(title)}</div>
  </div>
  <table style="margin-top:14px;font-size:14px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#64748b;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')}</table>
  ${body ? `<pre style="margin-top:14px;padding:10px 12px;background:#f1f5f9;border-radius:6px;font-size:12px;white-space:pre-wrap">${esc(body)}</pre>` : ''}
  <div style="margin-top:16px">${links.map(([k, u]) => `<a href="${esc(u)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;background:#2f7bff;color:#fff;border-radius:6px;text-decoration:none;font-size:14px">${esc(k)}</a>`).join('')}</div>
  <div style="margin-top:18px;font-size:12px;color:#94a3b8">${esc(footer)}</div>
</div>`;
  return { text, html };
}
