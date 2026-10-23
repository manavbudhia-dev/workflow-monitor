import si from 'systeminformation';
import os from 'node:os';
import { cfg } from '../config.js';
import { run, now, localServerId } from '../db.js';
import { edge } from '../notify.js';

const pct = (v) => Math.round(v * 10) / 10;

export async function sampleSystem(serverId = localServerId) {
  const [load, mem, mounts, nets, cpu] = await Promise.all([
    si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(), si.cpu(),
  ]);
  const root = mounts.filter((m) => !/proc|sys|dev|run|boot\/efi/i.test(m.mount)).sort((a, b) => b.use - a.use)[0] || { use: 0 };
  const m = {
    cpu: pct(load.currentLoad),
    mem: pct((mem.active / mem.total) * 100),
    disk: pct(root.use),
    load: pct(os.loadavg()[0]),
    uptime: Math.round(os.uptime()),
    net_in: pct((nets.reduce((s, n) => s + (n.rx_sec || 0), 0) / 1048576) * 8),
    net_out: pct((nets.reduce((s, n) => s + (n.tx_sec || 0), 0) / 1048576) * 8),
    cores: cpu.cores || 1,
  };
  run('INSERT INTO metrics(server_id, cpu, mem, disk, load, uptime, net_in, net_out, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    serverId, m.cpu, m.mem, m.disk, m.load, m.uptime, m.net_in, m.net_out, now());
  run('UPDATE servers SET last_seen=? WHERE id=?', now(), serverId);
  await evaluate(serverId, m, m.cores);
  return m;
}

/** Threshold alerts for a metric set — used for local samples and remote agent pushes alike. */
export async function evaluate(serverId, m, cores = 1) {
  const gb = Math.round(os.totalmem() / 1073741824);
  const limits = [
    ['cpu', m.cpu, cfg.cpuWarnPct, `CPU at ${m.cpu}% (limit ${cfg.cpuWarnPct}%)`],
    ['mem', m.mem, cfg.memWarnPct, `RAM at ${m.mem}% of ~${gb}GB (limit ${cfg.memWarnPct}%)`],
    ['disk', m.disk, cfg.diskWarnPct, `Disk at ${m.disk}% (limit ${cfg.diskWarnPct}%)`],
    ['load', m.load, cfg.loadWarnFactor * cores, `Load avg ${m.load} on ${cores} cores (limit ${(cfg.loadWarnFactor * cores).toFixed(1)})`],
  ];
  const streaks = evaluate.streaks || (evaluate.streaks = new Map());
  for (const [name, value, limit, detail] of limits) {
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    const over = value > limit;
    const k = `res:${serverId}:${name}`;
    const n = streaks.get(k) || 0;
    streaks.set(k, over ? n + 1 : 0);
    if (!over) await edge({ key: k, ok: true, serverId, kind: `resource:${name}`, title: `High ${name}`, detail, threshold: true });
    else if (n + 1 >= cfg.warnStreak) await edge({ key: k, ok: false, serverId, kind: `resource:${name}`, title: `High ${name}`, detail, threshold: true });
  }
}

export function startMetricsLoop() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await sampleSystem(); } catch (e) { console.error('[metrics]', e.message); }
    finally { busy = false; }
  };
  tick();
  setInterval(tick, cfg.metricsIntervalSec * 1000).unref();
}
