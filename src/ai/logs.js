import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from '../config.js';
import { q } from '../db.js';
import { cap, sys } from '../shell.js';

const LINES = 50;
const isLinux = process.platform === 'linux';

export function tailFile(file, lines = LINES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 96 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } finally { fs.closeSync(fd); }
}

/** Never let configured secrets leak into log payloads that go off-box. */
export function scrub(text) {
  let out = maskSecrets(text);
  for (const s of [cfg.n8nKey, cfg.apiKey, cfg.telegramToken, cfg.password, cfg.sessionSecret]) {
    if (s && s.length > 4) out = out.split(s).join('***');
  }
  return out;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Shape-based secret masking for anything shown in the browser or sent to the AI:
 * key=value pairs whose key smells secret, bearer/basic tokens, credentials in URLs
 * and well-known token prefixes. Values are replaced, never reordered.
 */
export function maskSecrets(text) {
  return String(text || '')
    .replace(ANSI, '')
    .replace(/(["']?[A-Za-z0-9_]*(?:token|key|secret|password|passwd|pwd|passphrase|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:"[^"\s]{4,}"|'[^'\s]{4,}'|[^\s"',;}&]{4,})/gi, '$1***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/g, '$1$2:***@')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|sk-proj|xoxb|xoxp|xoxa|AKIA|ASIA|ya29|\+sa)[A-Za-z0-9_-]{10,}/g, '***');
}

function history(m) {
  return q('SELECT ok, detail, created_at FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 10', m.id)
    .reverse().map((c) => `${new Date(c.created_at).toISOString()} ${c.ok ? 'OK ' : 'ERR'} ${c.detail}`)
    .join('\n') || '(no previous checks)';
}

/** Best-effort "last 50 log lines" for a failing monitor, for the AI root-cause step. */
export async function getLastLogs(m, c = {}) {
  const spec = c.log || {};
  try {
    if (spec.kind === 'file' && spec.path) return scrub(tailFile(spec.path, +spec.lines || LINES));
    if (spec.kind === 'journal' && spec.unit) return scrub(await sys('journalctl', ['-n', String(spec.lines || LINES), '--no-pager', '-u', spec.unit]));
    if (spec.kind === 'pm2' && spec.name) {
      const f = path.join(os.homedir(), '.pm2', 'logs', `${spec.name}-error.log`);
      if (fs.existsSync(f)) return scrub(tailFile(f, +spec.lines || LINES));
      return scrub(await cap('pm2', ['logs', spec.name, '--lines', String(spec.lines || LINES), '--nostream', '--raw']));
    }
    if (spec.kind === 'cmd' && spec.cmd && isLinux) return scrub(await cap('sh', ['-c', spec.cmd]));

    if (m.type === 'systemd' && c.unit && isLinux) return scrub(await sys('journalctl', ['-n', String(LINES), '--no-pager', '-u', c.unit]));
    if (m.type === 'pm2' && c.name) return await getLastLogs(m, { log: { kind: 'pm2', name: c.name } });
    if (m.type === 'n8n') {
      const base = String(c.url || cfg.n8nUrl || '').replace(/\/+$/, ''), key = c.api_key || cfg.n8nKey;
      let ids = [];
      try { ids = JSON.parse(q('SELECT detail FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 1', m.id)[0]?.detail || '{}').ids || []; } catch { ids = []; }
      ids = ids.slice(0, 2);
      if (base && key && ids.length) {
        const parts = [];
        for (const id of ids) {
          const j = await fetch(`${base}/executions/${id}`, { headers: { 'x-n8n-api-key': key }, signal: AbortSignal.timeout(12000) })
            .then((r) => r.json()).catch(() => null);
          if (j?.data ?? j) parts.push(JSON.stringify((j?.data ?? j)?.data ?? j, null, 1).slice(0, 4000));
        }
        if (parts.length) return scrub(`${history(m)}\n\nFailed execution payloads:\n${parts.join('\n---\n')}`);
      }
    }
  } catch (e) { return scrub(`[log capture failed: ${e.message}]\n\n${history(m)}`); }
  return scrub(history(m));
}
