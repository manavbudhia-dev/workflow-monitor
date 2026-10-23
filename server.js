import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './src/config.js';
import { router as authRouter, auth } from './src/routes/auth.js';
import { router as agentRouter } from './src/routes/agent.js';
import { router as monitorsRouter } from './src/routes/monitors.js';
import { router as dataRouter } from './src/routes/data.js';
import { router as securityRouter } from './src/routes/security.js';
import { router as logsRouter } from './src/routes/logs.js';
import { router as pushRouter } from './src/routes/push.js';
import { startMetricsLoop } from './src/collectors/metrics.js';
import { startScheduler } from './src/collectors/scheduler.js';
import { closeAllStreams } from './src/collectors/logs.js';
import { openIncidents, servers, get } from './src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), open: openIncidents().length }));
app.use('/api', agentRouter);
app.use('/api', authRouter);
app.use('/api', auth);
app.use('/api', monitorsRouter, dataRouter, securityRouter, logsRouter, pushRouter);

const chart = path.join(here, 'node_modules/chart.js/dist/chart.umd.js');
app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(chart));
// express 4's mime map has no .webmanifest entry, and a cached sw.js would delay an update by minutes
app.get('/manifest.webmanifest', (req, res) => res.setHeader('cache-control', 'no-store').type('application/manifest+json').sendFile(path.join(here, 'public', 'manifest.webmanifest')));
app.get('/sw.js', (req, res) => res.setHeader('cache-control', 'no-store').type('application/javascript').sendFile(path.join(here, 'public', 'sw.js')));
app.use(express.static(path.join(here, 'public'), {
  index: 'index.html', maxAge: '5m',
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('cache-control', 'no-store'); },
}));

app.use('/api', (req, res) => res.status(404).json({ error: `no such endpoint ${req.path}` }));
app.use((err, req, res, next) => {
  console.error('[http]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'server error' });
});

if (!process.env.WM_NO_LOOPS) {
  startMetricsLoop();
  startScheduler();
}

// A live tail runs as a child process (sometimes under sudo) — never let one outlive the app.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { closeAllStreams(); process.exit(0); });

app.listen(cfg.port, cfg.bind, () => {
  const local = get('SELECT * FROM servers WHERE is_local=1');
  console.log(`workflow-monitor listening on http://${cfg.bind === '0.0.0.0' ? 'localhost' : cfg.bind}:${cfg.port}  (public: ${cfg.publicUrl})`);
  console.log(`  login password: ${cfg.password === 'admin' ? 'admin (CHANGE PASSWORD IN .ENV!)' : 'set from .env'}`);
  console.log(`  metrics every ${cfg.metricsIntervalSec}s, checks every ${cfg.checkIntervalSec}s, db ${cfg.dbPath}`);
  console.log(`  servers: ${servers().length}, telegram: ${cfg.telegramToken ? 'configured' : 'off'}, ai: ${cfg.aiProvider}${cfg.apiKey ? '' : ' (no key)'}`);
  if (local) console.log(`  local agent id ${local.id}`);
  console.log(`  auto-restart: ${cfg.restartEnabled ? `${cfg.restartAllow.length} whitelisted command(s)` : 'off'}, security: ${cfg.securityEnabled ? cfg.authLogSource : 'off'}`);
});
