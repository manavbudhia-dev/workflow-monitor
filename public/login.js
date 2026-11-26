import { icon } from './js/icons.js';

document.querySelector('#brand').innerHTML = icon('activity', 21);

const form = document.querySelector('#f');
const btn = form.querySelector('button[type=submit]');
const err = document.querySelector('#err');

const fromUrl = new URLSearchParams(location.search).get('error');
if (fromUrl) { err.textContent = fromUrl; history.replaceState(null, '', '/login.html'); }

fetch('/api/auth/config').then((r) => r.json()).then((c) => {
  document.querySelector('#google').hidden = !c.google;
  document.querySelector('#or').hidden = !(c.google && c.password);
  if (!c.password) { document.querySelector('#pwbox').remove(); form.onsubmit = (e) => e.preventDefault(); }
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.pw) return;
  err.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: form.pw.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    location.href = '/';
  } catch (e2) {
    err.textContent = e2.message;
    btn.disabled = false;
    form.pw.select();
  }
});
