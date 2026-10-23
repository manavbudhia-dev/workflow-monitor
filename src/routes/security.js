import express from 'express';
import { run } from '../db.js';
import { cfg } from '../config.js';
import { securitySnapshot, scanSecurity } from '../collectors/security.js';
import { whitelistInfo } from '../collectors/restart.js';

export const router = express.Router();

router.get('/security', (req, res) => res.json(securitySnapshot()));
router.get('/restart-config', (req, res) => res.json({ ...whitelistInfo(), allow: cfg.restartAllow }));

/** Force a scan now — used by the Security page and handy for testing the rules. */
router.post('/security/scan', async (req, res) => {
  const scanned = await scanSecurity().catch((e) => ({ error: e.message }));
  res.json({ scanned, ...securitySnapshot() });
});

/** Accept the current listeners as the new baseline so planned changes stop alerting. */
router.post('/security/reseed', (req, res) => {
  run('DELETE FROM sec_port');
  res.json({ ok: true, note: 'baseline cleared — the next scan seeds it silently' });
});
