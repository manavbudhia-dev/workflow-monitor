import { cfg } from './config.js';

/**
 * Turn whatever a user pasted into the n8n address they open in the browser:
 * "n8n.acme.com", "https://n8n.acme.com/", ".../api/v1", ".../workflow/12", ".../home/workflows".
 * A path prefix in front of those (n8n behind /n8n/) is kept.
 */
export function n8nBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|127\.|10\.|192\.168\.|\[?::1)/i.test(s) ? 'http' : 'https'}://${s}`;
  let u;
  try { u = new URL(s); } catch { return s.replace(/\/+$/, ''); }
  const cut = u.pathname.search(/\/(api\/v\d+|rest|workflows?|executions?|home|signin|credentials|settings|projects)(\/|$)/i);
  const path = (cut >= 0 ? u.pathname.slice(0, cut) : u.pathname).replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** A workflow link ("…/workflow/AbC123?x") or a bare id → the id. */
export function n8nWorkflowId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\/workflows?\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]) : s;
}

/** Base + key for one monitor's config, falling back to N8N_URL / N8N_API_KEY. */
export const n8nAuth = (c = {}) => ({ base: n8nBase(c.url || cfg.n8nUrl), key: c.api_key || cfg.n8nKey });

/** Link into the n8n editor for a monitor, or null without an address. */
export function n8nLink(c = {}) {
  const { base } = n8nAuth(c);
  if (!base) return null;
  return c.workflow_id ? `${base}/workflow/${encodeURIComponent(c.workflow_id)}` : `${base}/home/workflows`;
}

/** GET an n8n public-API path; errors are worded for people, not for engineers. */
export async function n8nGet(base, key, path, ms = 15000) {
  if (!base) throw new Error('n8n address is not set — enter the address you open n8n at');
  if (!key) throw new Error('n8n API key is not set — create one in n8n: Settings → n8n API');
  let r;
  try {
    r = await fetch(`${base}/api/v1${path}`, { headers: { 'x-n8n-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const code = e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.name || '';
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) throw new Error(`Can't find ${base} — check the address for typos`);
    if (/ECONNREFUSED/.test(code)) throw new Error(`${base} refused the connection — is n8n running?`);
    if (/Timeout|Abort/i.test(code)) throw new Error(`${base} did not answer in ${Math.round(ms / 1000)}s`);
    if (/CERT|SSL|TLS/i.test(code)) throw new Error(`${base} has an HTTPS certificate problem (${code})`);
    throw new Error(`Can't reach ${base} (${code || e.message})`);
  }
  if (r.status === 401 || r.status === 403) throw new Error('n8n rejected the API key — create a new one in n8n: Settings → n8n API');
  if (r.status === 404) throw new Error(`No n8n API at ${base} — check the address (and that the n8n public API is enabled)`);
  if (!r.ok) throw new Error(`n8n answered ${r.status} ${r.statusText}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`${base} answered, but not like n8n — check the address`); }
}

/** Every workflow (id, name, active), following n8n's cursor paging up to 1000 items. */
export async function n8nWorkflows(base, key) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 4; i++) {
    const j = await n8nGet(base, key, `/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const w of j.data || []) out.push({ id: String(w.id), name: w.name || `Workflow ${w.id}`, active: !!w.active });
    cursor = j.nextCursor;
    if (!cursor) break;
  }
  return out.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
}
