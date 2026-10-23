import { icon } from './js/icons.js';

document.querySelector('#brand').innerHTML = icon('activity', 21);

const form = document.querySelector('#f');
const btn = form.querySelector('button[type=submit]');
const err = document.querySelector('#err');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
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
