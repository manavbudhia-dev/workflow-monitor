import express from 'express';
import { pushReady, pushInfo, addSubscription, dropSubscription, pushPing } from '../alerts/push.js';

export const router = express.Router();

const off = (res) => {
  if (pushReady()) return true;
  res.status(409).json({ error: 'push is off — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env' });
  return false;
};

router.get('/push/info', (req, res) => res.json(pushInfo()));

/** The browser sends the raw PushSubscription.toJSON() object; the endpoint is validated before storing. */
router.post('/push/subscribe', (req, res) => {
  if (!off(res)) return;
  const r = addSubscription(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.post('/push/unsubscribe', (req, res) => {
  if (!off(res)) return;
  res.json(dropSubscription(req.body?.endpoint));
});

/** Ping every subscriber so the toggle can be proven to work without waiting for an incident. */
router.post('/push/test', async (req, res) => {
  if (!off(res)) return;
  const r = await pushPing({ title: 'Workflow Monitor', tag: 'wm-test', body: 'Test notification from the dashboard' }).catch((e) => ({ error: e.message }));
  res.json({ ...r, ...pushInfo() });
});
