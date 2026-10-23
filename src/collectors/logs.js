/**
 * Read-only log tailer. Every source is a .env whitelist entry (LOG_SOURCES); the UI can only
 * ever name one of them, and the name is resolved to a fixed argv array — nothing reaches a shell.
 * journal + pm2 follow with a spawned child (journalctl -f / pm2 logs), file sources are polled
 * by byte offset so a log tail never needs a binary on the box.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from '../config.js';
import { scrub, tailFile } from '../ai/logs.js';
import { cap, sys, stream } from '../shell.js';

const isLinux = process.platform === 'linux';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const clip = (s, n = 600) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Same words the dashboard colour-codes with, so filter and highlight can never disagree. */
export function levelOf(line) {
  if (/\b(error|fatal|panic|exception|traceback|failed|failure|denied|refused|unauthorized|crit)\b/i.test(line)) return 'error';
  if (/\b(warn(?:ing)?|deprecat|retry|timeout|slow|high)\b/i.test(line)) return 'warn';
  return 'info';
}

/** Names and kinds only — an absolute path on the box has no business being sent to a browser. */
export const sourceList = () => cfg.logSources.map((s) => ({ name: s.name, kind: s.kind, label: `${s.name} · ${s.kind}` }));

export function findSource(name) {
  const key = String(name || '').trim();
  return cfg.logSources.find((s) => s.name === key) || null;
}

const lines = (text, n) => text.split(/\r?\n/).map(strip).filter((l) => l.trim()).slice(-n);

/** journalctl prints its own timestamp column; keep it, the UI shows it as the line text. */
async function journalText(src, count) {
  if (!isLinux) throw new Error(`journalctl needs Linux (running on ${process.platform})`);
  return sys('journalctl', ['-n', String(count), '--no-pager', '-u', src.target], 20000);
}

async function fileText(p, count, label = p) {
  if (!fs.existsSync(p)) throw new Error(`${label} not found or not readable (is the service user allowed to read it?)`);
  return tailFile(p, count);
}

function pm2Files(src) {
  const dir = process.env.PM2_HOME ? path.join(process.env.PM2_HOME, 'logs') : path.join(os.homedir(), '.pm2', 'logs');
  return [{ tag: 'out', p: path.join(dir, `${src.target}-out.log`) }, { tag: 'err', p: path.join(dir, `${src.target}-error.log`) }]
    .filter((f) => fs.existsSync(f.p));
}

/** One snapshot of up to `count` masked lines, newest last. */
export async function snapshot(src, count) {
  const n = Math.min(Math.max(+count || 50, 1), cfg.logMaxLines);
  let text = '';
  if (src.kind === 'journal') text = await journalText(src, n);
  else if (src.kind === 'file') text = await fileText(src.target, n, `source "${src.name}"`);
  else {
    const files = pm2Files(src);
    if (files.length) text = (await Promise.all(files.map((f) => fileText(f.p, Math.ceil(n / files.length), `pm2 ${f.tag} log`)))).join('\n');
    else text = await cap('pm2', ['logs', src.target, '--lines', String(n), '--nostream', '--raw'], 20000)
      .catch((e) => { throw new Error(`pm2 app "${src.target}" has no log files here and pm2 logs failed (${e.message})`); });
  }
  const rows = lines(text, n).map((l) => ({ l: clip(scrub(l)), v: levelOf(l) }));
  return { source: src.name, kind: src.kind, lines: rows, truncated: rows.length >= n };
}

/* ---------- live tail streams ---------- */

const streams_ = new Map();
let seq = 0;
export const activeStreams = () => streams_.size;

function stop(s) {
  clearInterval(s.keep);
  clearInterval(s.idle);
  clearInterval(s.poll);
  if (s.child) { try { s.child.kill(); } catch { /* already gone */ } }
}

function endStream(id, why) {
  const s = streams_.get(id);
  if (!s) return;
  streams_.delete(id);
  stop(s);
  try { s.res.write(`event: end\ndata: ${JSON.stringify({ why: why || 'closed' })}\n\n`); s.res.end(); } catch { /* socket is gone */ }
}

/**
 * Attach an SSE response to a source. Returns { id } or { error } when the cap is hit.
 * The child / poller is created per stream and always torn down on socket close or idle.
 */
export async function openStream(res, src, { from = 50 } = {}) {
  if (streams_.size >= cfg.logStreamMax) {
    return { error: `${cfg.logStreamMax} live tail streams are already open — close one and retry` };
  }
  const id = ++seq;
  const s = { id, res, src, keep: null, idle: null, child: null, poll: null, last: Date.now() };
  streams_.set(id, s);
  res.on('close', () => endStream(id, 'client left'));

  const emit = (line) => {
    if (!streams_.has(id)) return;
    s.last = Date.now();
    res.write(`data: ${JSON.stringify({ l: clip(scrub(line)), v: levelOf(line), t: Date.now() })}\n\n`);
  };
  const fail = (message) => {
    res.write(`event: error\ndata: ${JSON.stringify({ message: String(message).slice(0, 300) })}\n\n`);
    endStream(id, 'source error');
  };

  res.write('retry: 4000\n');
  s.keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { endStream(id, 'write failed'); } }, 25000).unref();
  s.idle = setInterval(() => {
    if (Date.now() - s.last > cfg.logIdleMin * 60000) endStream(id, `idle for ${cfg.logIdleMin} minutes`);
  }, 30000).unref();

  try {
    if (src.kind === 'journal') {
      if (!isLinux) throw new Error(`journalctl needs Linux (running on ${process.platform})`);
      const args = ['-f', '--no-pager', '-n', String(Math.min(from, cfg.logMaxLines)), '-u', src.target];
      s.child = stream('journalctl', args);
    } else if (src.kind === 'pm2') {
      s.child = stream('pm2', ['logs', src.target, '--lines', String(Math.min(from, cfg.logMaxLines)), '--raw']);
    } else {
      if (!fs.existsSync(src.target)) throw new Error(`${src.name} points at a file that is not readable on this host`);
      startFilePoll(s, emit, fail);
    }
  } catch (e) {
    // release the slot without touching the response — the route still has to write its error event
    streams_.delete(id);
    stop(s);
    return { error: e.message };
  }

  if (s.child) {
    let carry = '';
    const onData = (buf) => {
      const parts = (carry + buf.toString('utf8')).split(/\r?\n/);
      carry = parts.pop();
      for (const p of parts) if (p.trim()) emit(p);
    };
    s.child.stdout.on('data', onData);
    s.child.stderr.on('data', onData);
    s.child.on('error', (e) => fail(`${e.code === 'ENOENT' ? `${e.path || 'the log command'} is not installed on this host` : e.message}`));
    s.child.on('exit', (code) => { if (streams_.has(id)) { fail(`log reader exited with code ${code}`); } });
  }

  return { id };
}

/** file sources: read appended bytes by offset, so rotation and truncation are handled without a tail binary. */
function startFilePoll(s, emit, fail) {
  const p = s.src.target;
  let size = 0;
  let carry = '';
  try { size = fs.statSync(p).size; } catch (e) { return fail(e.message); }
  emit(`— tailing ${s.src.name} from ${Math.round(size / 1024)} KB —`);
  s.poll = setInterval(() => {
    if (!streams_.has(s.id)) return;
    let st;
    try { st = fs.statSync(p); } catch { return endStream(s.id, `${s.src.name} disappeared`); }
    if (st.size < size) size = 0;
    if (st.size === size) return;
    const len = Math.min(st.size - size, 128 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, size); } finally { fs.closeSync(fd); }
    size += len;
    const parts = (carry + buf.toString('utf8')).split(/\r?\n/);
    carry = parts.pop();
    for (const line of parts) if (line.trim()) emit(line);
  }, cfg.logPollMs);
  s.poll.unref();
}

/** Kill every follower — used on shutdown so no sudo journalctl child outlives the app. */
export function closeAllStreams() {
  for (const id of [...streams_.keys()]) endStream(id, 'server shutting down');
}

export const streamInfo = () => ({ active: [...streams_.values()].map((s) => ({ id: s.id, source: s.src.name })) });
