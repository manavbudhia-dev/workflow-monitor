import express from 'express';
import { cfg } from '../config.js';
import { explain, aiReady } from '../ai/explain.js';
import { scrub } from '../ai/logs.js';
import { sourceList, findSource, snapshot, openStream, activeStreams, levelOf } from '../collectors/logs.js';

export const router = express.Router();

const enabled = (res) => {
  if (cfg.logEnabled) return true;
  res.status(409).json({ error: 'log viewer is off — set LOG_ENABLED=true in .env' });
  return false;
};

const count = (v) => Math.min(Math.max(+v || 50, 1), cfg.logMaxLines);

/** Filter that both the JSON snapshot and the text download share. */
function applyFilter(rows, { grep = '', level = '' }) {
  const needle = String(grep).toLowerCase();
  return rows.filter((r) =>
    (!needle || r.l.toLowerCase().includes(needle)) &&
    (!level || level === 'all' || r.v === level));
}

router.get('/logs/sources', (req, res) => {
  if (!enabled(res)) return;
  res.json({
    enabled: cfg.logEnabled,
    max_lines: cfg.logMaxLines,
    stream_max: cfg.logStreamMax,
    stream_active: activeStreams(),
    idle_min: cfg.logIdleMin,
    ai: aiReady(),
    sources: sourceList(),
  });
});

router.get('/logs', async (req, res) => {
  if (!enabled(res)) return;
  const src = findSource(req.query.src);
  if (!src) return res.status(400).json({ error: `unknown log source "${req.query.src || ''}" — add it to LOG_SOURCES in .env` });
  let snap;
  try { snap = await snapshot(src, count(req.query.lines)); } catch (e) { return res.status(502).json({ error: e.message }); }
  const rows = applyFilter(snap.lines, req.query);
  if (req.query.format === 'text') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${src.name.replace(/[^A-Za-z0-9._-]/g, '_')}.log"`);
    return res.send(`${rows.map((r) => r.l).join('\n')}\n`);
  }
  res.json({ ...snap, lines: rows, hidden: snap.lines.length - rows.length });
});

/** Server-sent events tail. One child or poller per connection, killed on close/idle/over-cap. */
router.get('/logs/stream', async (req, res) => {
  if (!enabled(res)) return;
  const src = findSource(req.query.src);
  if (!src) return res.status(400).json({ error: `unknown log source "${req.query.src || ''}"` });
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
  const r = await openStream(res, src, { from: count(req.query.lines) }).catch((e) => ({ error: e.message }));
  if (r?.error) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: r.error })}\n\n`);
    res.end();
  }
});

/** Ask the existing AI layer about what is on screen — selected lines, else the last 50 errors. */
router.post('/logs/explain', async (req, res) => {
  if (!enabled(res)) return;
  const src = findSource(req.body?.src);
  if (!src) return res.status(400).json({ error: `unknown log source "${req.body?.src || ''}" — add it to LOG_SOURCES in .env` });
  if (!aiReady()) return res.status(400).json({ error: 'AI is off — set AI_PROVIDER and AI_API_KEY in .env' });
  const body = String(req.body?.text || '');
  const lines = body.split(/\r?\n/).filter(Boolean).length ? body.split(/\r?\n/)
    : (await snapshot(src, cfg.logMaxLines).catch(() => ({ lines: [] }))).lines.map((r) => r.l);
  const errs = lines.filter((l) => levelOf(l) === 'error').slice(-50);
  const logs = scrub(errs.length ? errs.join('\n') : lines.slice(-50).join('\n'));
  if (!logs.trim()) return res.status(400).json({ error: 'nothing to explain — the source returned no lines' });
  const text = await explain({
    title: `Log review: ${src.name} (${src.kind} ${src.target})`,
    detail: String(req.body?.note || 'operator asked for a root cause from the log viewer'),
    logs,
  });
  res.json({ ai: text, used_lines: logs.split(/\r?\n/).filter(Boolean).length, errors_only: errs.length > 0 });
});
