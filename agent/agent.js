#!/usr/bin/env node
// Runs on any extra server: pushes metrics to the workflow-monitor hub.
//   HUB_URL=https://your-oci-host:4180 HUB_KEY=<api key from the dashboard> node agent/agent.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import si from 'systeminformation';

const env = (k, d) => process.env[k] || d;
for (const f of [path.resolve(process.cwd(), '.env'), path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.env')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
}

const hub = env('HUB_URL', '').replace(/\/+$/, '');
const key = env('HUB_KEY', env('AGENT_API_KEY', ''));
const name = env('SERVER_NAME', os.hostname());
const every = Math.max(10, +env('INTERVAL_SEC', '30')) * 1000;

if (!hub || !key) {
  console.error('agent needs HUB_URL and HUB_KEY (set in .env or environment)');
  process.exit(2);
}

const pct = (v) => Math.round(v * 10) / 10;

async function payload() {
  const [load, mem, mounts, nets, cpu] = await Promise.all([
    si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(), si.cpu(),
  ]);
  const root = mounts.filter((m) => !/proc|sys|dev|run|boot\/efi/i.test(m.mount)).sort((a, b) => b.use - a.use)[0] || { use: 0 };
  return {
    name,
    cpu: pct(load.currentLoad),
    mem: pct((mem.active / mem.total) * 100),
    disk: pct(root.use),
    load: pct(os.loadavg()[0]),
    uptime: Math.round(os.uptime()),
    net_in: pct((nets.reduce((s, n) => s + (n.rx_sec || 0), 0) / 1048576) * 8),
    net_out: pct((nets.reduce((s, n) => s + (n.tx_sec || 0), 0) / 1048576) * 8),
    cores: cpu.cores,
  };
}

async function tick() {
  try {
    const body = await payload();
    const r = await fetch(`${hub}/api/agent/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) console.error(`hub replied ${r.status}: ${(await r.text()).slice(0, 160)}`);
    else console.log(`sent ${name}: cpu ${body.cpu}% ram ${body.mem}% disk ${body.disk}%`);
  } catch (e) { console.error('push failed:', e.message); }
}

console.log(`workflow-monitor agent -> ${hub} every ${every / 1000}s as "${name}"`);
tick();
setInterval(tick, every);
