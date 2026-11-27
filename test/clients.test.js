// Clients: CRUD, assigning monitors/servers, client alerts (via a mock Resend), the public status page and the report.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4277, MAIL = 4278, DEAD = 4279;
const APP = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-clients-'));
const mails = [];
let child, cookie = '';

const mail = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => { mails.push(JSON.parse(raw)); res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"m1"}'); });
});

async function call(method, p, body) {
  const r = await fetch(APP + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text, headers: r.headers };
}
const until = async (fn, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out: ${what}`);
};

before(async () => {
  await new Promise((r) => mail.listen(MAIL, r));
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, WM_NO_LOOPS: '1', PORT: String(PORT), BIND_HOST: '127.0.0.1', DB_PATH: path.join(dir, 'm.db'),
      PASSWORD: 'correct-horse-battery', SESSION_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://monitor.example.com',
      RESEND_API_KEY: 're_test', RESEND_BASE_URL: `http://127.0.0.1:${MAIL}`, ALERT_EMAIL_TO: 'me@ops.test',
      TELEGRAM_BOT_TOKEN: '', SECURITY_ENABLED: 'false', BRAND_NAME: 'ZealCoder',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await until(() => fetch(`${APP}/healthz`).then((r) => r.ok).catch(() => false), 'server start');
  const r = await fetch(`${APP}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => { child?.kill(); mail.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('clients: create, validate, assign, alert, status page, report, delete', async () => {
  assert.equal((await call('POST', '/api/clients', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/clients', { name: 'X', emails: 'not-an-email' })).status, 400);
  assert.equal((await call('POST', '/api/clients', { name: 'X', telegram_chats: 'abc' })).status, 400);
  const c = (await call('POST', '/api/clients', { name: 'Kalyanakuri', emails: 'owner@client.test', telegram_chats: '-1001234567890' })).json;
  assert.equal(c.name, 'Kalyanakuri');
  assert.match(c.status_url, /^https:\/\/monitor\.example\.com\/status\/[A-Za-z0-9_-]{20,}$/);
  assert.equal((await call('POST', '/api/clients', { name: 'Kalyanakuri' })).status, 409);

  // A monitor for the client that is down (nothing listens on DEAD), and one of my own.
  const mon = (await call('POST', '/api/monitors', { name: 'Client site', type: 'port', config: { host: '127.0.0.1', port: DEAD, timeout_ms: 500 }, client_id: c.id, check: false })).json;
  assert.equal(mon.client_id, c.id);
  const mine = (await call('POST', '/api/monitors', { name: 'My thing', type: 'port', config: { host: '127.0.0.1', port: DEAD, timeout_ms: 500 }, check: false })).json;
  assert.equal(mine.client_id, null);
  assert.equal((await call('POST', '/api/monitors', { name: 'x', type: 'port', config: { port: 1 }, client_id: 999, check: false })).status, 400);

  await call('POST', `/api/monitors/${mon.id}/check`);
  const toClient = await until(() => mails.find((m) => m.to.includes('owner@client.test')), 'client alert email');
  assert.match(toClient.subject, /Client site needs attention/);
  assert.match(toClient.html, /NEEDS ATTENTION/);
  assert.match(toClient.html, /monitored by ZealCoder/);
  assert.ok(mails.some((m) => m.to.includes('me@ops.test') && /Client site/.test(m.subject)), 'the operator still gets the alert');

  const n = mails.length;
  await call('POST', `/api/monitors/${mine.id}/check`);
  await until(() => mails.length > n, 'operator alert for own monitor');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!mails.slice(n).some((m) => m.to.includes('owner@client.test')), 'a client never hears about my own monitors');

  // Public status page: no login, only the client's own monitors, no internal detail.
  const token = c.status_url.split('/').pop();
  const page = await fetch(`${APP}/status/${token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Kalyanakuri/);
  assert.match(html, /Client site/);
  assert.doesNotMatch(html, /My thing/);
  assert.match(html, /need[s]? attention/);
  assert.match(html, /noindex/);
  assert.equal((await fetch(`${APP}/status/not-a-real-token-123456`)).status, 404);
  const json = await (await fetch(`${APP}/api/public/status/${token}`)).json();
  assert.deepEqual(json.monitors.map((m) => m.name), ['Client site']);
  assert.equal(json.incidents.length, 1);

  const rep = (await call('GET', `/api/clients/${c.id}/report`)).json.text;
  assert.match(rep, /Weekly report — Kalyanakuri/);
  assert.match(rep, /Incidents: 1/);

  // Rotating the link kills the old one.
  const rotated = (await call('POST', `/api/clients/${c.id}/token`)).json;
  assert.notEqual(rotated.status_url, c.status_url);
  assert.equal((await fetch(`${APP}/status/${token}`)).status, 404);

  // An agent server can be assigned; the hub cannot.
  const srv = (await call('POST', '/api/servers', { name: 'client-vps' })).json;
  assert.equal((await call('PUT', `/api/servers/${srv.id}/client`, { client_id: c.id })).status, 200);
  assert.equal((await call('PUT', '/api/servers/1/client', { client_id: c.id })).status, 400);
  assert.equal((await call('GET', '/api/clients')).json[0].servers, 1);

  // Deleting a client keeps its monitors, as mine.
  assert.equal((await call('DELETE', `/api/clients/${c.id}`)).status, 200);
  const after = (await call('GET', '/api/monitors')).json.find((m) => m.id === mon.id);
  assert.equal(after.client_id, null);
});
