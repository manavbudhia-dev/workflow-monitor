import { cfg } from '../config.js';
import { run, incident, get } from '../db.js';

export const aiReady = () => cfg.aiProvider !== 'none' && !!cfg.apiKey;

const SYS = 'You are a Linux / n8n / Node.js SRE assistant. From the incident and log excerpt, answer in at most 5 short bullet lines: probable root cause, the log evidence for it, the exact command(s) to fix it, and what to verify next. Be concrete. No preamble, no disclaimers.';

export async function explain({ title, detail, logs }) {
  if (!aiReady()) return null;
  const user = `Incident: ${title}\nDetector said: ${detail}\nLast log lines:\n---\n${String(logs || '(no logs captured)').slice(-6000)}\n---`;
  try {
    if (cfg.aiProvider.startsWith('anthropic')) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.aiModel, max_tokens: 500, system: SYS, messages: [{ role: 'user', content: user }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      return (j.content || []).map((p) => p.text || '').join('').trim();
    }
    const r = await fetch(`${cfg.aiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.aiModel, temperature: 0.2, max_tokens: 500, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return (j.choices?.[0]?.message?.content || '').trim();
  } catch (e) { return `[AI error] ${e.message}`; }
}

export async function explainAndSave(id, ctx) {
  const text = await explain(ctx);
  if (text) run('UPDATE incidents SET ai=? WHERE id=?', text, id);
  return text;
}

/** Re-run the model for a stored incident, using whatever logs it already has. */
export async function explainIncident(id) {
  const inc = incident(id);
  if (!inc) return { error: 'incident not found', status: 404 };
  const m = get('SELECT * FROM monitors WHERE id=?', inc.monitor_id);
  const text = await explain({
    title: inc.title + (m ? ` (${m.type})` : ''), detail: inc.detail, logs: inc.logs,
  });
  if (!text) return { error: `AI is disabled — set AI_PROVIDER and AI_API_KEY in .env`, status: 400 };
  run('UPDATE incidents SET ai=? WHERE id=?', text, id);
  return { ok: true, ai: text };
}
