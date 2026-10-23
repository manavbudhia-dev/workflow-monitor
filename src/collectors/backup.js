/**
 * Backup monitor: finds the newest file matching a pattern in a folder and grades it
 * by age, size and size drop against the previous backup. Pure filesystem, so it runs
 * on any host and is testable without a service.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { q, get, run, now, monitors, monitorConfig } from '../db.js';

export const fmtBytes = (n) => {
  if (n === null || n === undefined) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : v} ${u[i]}`;
};

export const fmtAgo = (ts) => {
  const min = Math.max(0, Math.round((now() - ts) / 60000));
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ${min % 60}m ago` : `${Math.floor(h / 24)}d ago`;
};

/** Tiny glob: only * and ?, everything else is escaped, so a pattern can never break out. */
const globRe = (g) => new RegExp(`^${String(g || '*').split('').map((ch) =>
  (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 'i');

const listFiles = (dir, glob) => fs.readdirSync(dir)
  .map((name) => {
    try { const s = fs.statSync(path.join(dir, name)); return s.isFile() ? { name, size: s.size, mtime: Math.round(s.mtimeMs) } : null; }
    catch { return null; }
  })
  .filter(Boolean)
  .filter((f) => globRe(glob).test(f.name))
  .sort((a, b) => b.mtime - a.mtime);

/** One row per distinct backup file, so the size trend is not one point per check. */
function record(monitorId, f) {
  const last = get('SELECT file, mtime FROM backup_history WHERE monitor_id=? ORDER BY id DESC LIMIT 1', monitorId);
  if (last && last.file === f.name && last.mtime === f.mtime) return;
  run('INSERT INTO backup_history(monitor_id, file, size, mtime, created_at) VALUES(?,?,?,?,?)', monitorId, f.name, f.size, f.mtime, now());
}

export async function checkBackup(c, m) {
  if (!cfg.backupEnabled) return { skip: 'backup checks are disabled (BACKUP_ENABLED=false)' };
  if (!c.path) return { ok: false, detail: 'no backup path configured' };
  let root;
  try { root = fs.statSync(c.path); } catch { return { ok: false, detail: `${c.path} does not exist (wrong path or volume not mounted?)` }; }
  const dir = root.isDirectory() ? c.path : path.dirname(c.path);
  const glob = root.isDirectory() ? (c.pattern || '*') : path.basename(c.path);
  let files;
  try { files = listFiles(dir, glob); } catch (e) { return { ok: false, detail: `cannot read ${dir} (${e.code || e.message})` }; }
  if (!files.length) return { ok: false, detail: `no file matching "${glob}" in ${dir}` };

  const cur = files[0];
  const maxAge = +c.max_age_hours || 26;
  const minMb = +c.min_size_mb || 0;
  const hours = (now() - cur.mtime) / 36e5;
  record(m.id, cur);
  const desc = `${cur.name} · ${fmtBytes(cur.size)} · ${fmtAgo(cur.mtime)}`;

  if (hours > maxAge) return { ok: false, detail: `backup too old: ${hours.toFixed(1)}h > max ${maxAge}h (${desc})` };
  const mb = cur.size / 1048576;
  if (minMb && mb < minMb) return { ok: false, detail: `backup too small: ${mb.toFixed(1)}MB < min ${minMb}MB (${desc})` };

  const snaps = q('SELECT file, size, mtime FROM backup_history WHERE monitor_id=? ORDER BY id DESC LIMIT 2', m.id);
  const prev = files[1] ? { file: files[1].name, size: files[1].size }
    : snaps.find((r) => !(r.file === cur.name && r.mtime === cur.mtime));
  if (prev && prev.size > 0 && cur.size < prev.size * 0.5) {
    const dropped = Math.round((1 - cur.size / prev.size) * 100);
    return { ok: false, detail: `backup shrank ${dropped}%: ${fmtBytes(cur.size)} now vs ${fmtBytes(prev.size)} in ${prev.file} (${desc})` };
  }
  return { ok: true, detail: desc };
}

/** Everything the dashboard needs for each backup monitor, newest first. */
export function backupRows() {
  return monitors()
    .filter((m) => m.type === 'backup')
    .map((m) => {
      const hist = q('SELECT file, size, mtime, created_at FROM backup_history WHERE monitor_id=? ORDER BY id DESC LIMIT 7', m.id).reverse();
      const c = monitorConfig(m);
      return {
        id: m.id, name: m.name, enabled: !!m.enabled, ok: m.last_ok === null ? null : !!m.last_ok,
        detail: m.last_detail, path: c.path || '', pattern: c.pattern || '*',
        max_age_hours: +c.max_age_hours || 26, min_size_mb: +c.min_size_mb || 0,
        last: hist[hist.length - 1] || null, history: hist,
      };
    });
}
