/**
 * Watches ssh logins, listening ports and fail2ban on the hub box.
 * The line parser is pure, so the rules can be exercised on a fixture log
 * anywhere; only the readers (file tail, journalctl, ss, fail2ban-client) need Linux.
 */
import fs from 'node:fs';
import { cfg } from '../config.js';
import { q, get, run, now, setSetting, setting, localServerId } from '../db.js';
import { cooldownOk } from '../notify.js';
import { send } from '../alerts/telegram.js';
import { cap, sys } from '../shell.js';

const MIN = 60000;
const clean = (s) => String(s || '').replace(/^\[?:::ffff:/i, '').replace(/[\]]$/g, '');
const isIp = (s) => /^[0-9a-fA-F:.]{3,45}$/.test(s);

/** One sshd log line -> { kind, ip, user } or null. */
export function parseLine(line) {
  let m;
  if ((m = /Failed password for (?:invalid user )?(\S+) from (\S+?)(?: port|$)/i.exec(line))) return { kind: 'ssh_fail', user: m[1], ip: clean(m[2]) };
  if ((m = /Authentication failed for (?:invalid user )?(\S+) from (\S+?)(?: port|$)/i.exec(line))) return { kind: 'ssh_fail', user: m[1], ip: clean(m[2]) };
  if ((m = /Accepted (\S+) for (?:invalid user )?(\S+) from (\S+)/i.exec(line))) {
    const [, how, user, ip] = m;
    return { kind: user === 'root' ? 'ssh_root' : 'ssh_ok', user, ip: clean(ip), detail: how };
  }
  return null;
}

export const parseChunk = (text) => text.split(/\r?\n/).map(parseLine).filter(Boolean).filter((e) => isIp(e.ip));

/** Failures are stored one aggregated row per ip per scan so an attack cannot flood the table. */
function recordFails(rows) {
  const byIp = new Map();
  for (const r of rows) {
    const e = byIp.get(r.ip) || { n: 0, users: new Set() };
    e.n++; e.users.add(r.user);
    byIp.set(r.ip, e);
  }
  for (const [ip, e] of byIp) {
    run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)',
      'ssh_fail', ip, [...e.users].slice(0, 5).join(','), `failed password x${e.n}`, e.n, now());
  }
  return [...byIp.keys()];
}

const failTotal = (ip) => get('SELECT COALESCE(SUM(count), 0) n FROM sec_event WHERE kind=? AND ip=? AND created_at>?', 'ssh_fail', ip, now() - cfg.sshFailedWindowMin * MIN).n;

async function alertBrute(ip) {
  const n = failTotal(ip);
  if (n <= cfg.sshFailedLimit) return;
  const row = get('SELECT user FROM sec_event WHERE kind=? AND ip=? ORDER BY id DESC LIMIT 1', 'ssh_fail', ip);
  if (!cooldownOk(`sec:brute:${ip}`, cfg.securityCooldownMin)) return;
  run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)', 'brute', ip, row?.user || '', `${n} failures in ${cfg.sshFailedWindowMin}m`, n, now());
  await send(`🚨 *SSH BRUTE FORCE*\n${n} failed logins from ${ip} in the last ${cfg.sshFailedWindowMin} min\nusers tried: ${row?.user || '-'}`);
}

async function acceptLogin(e) {
  run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)',
    e.kind, e.ip, e.user, `${e.kind === 'ssh_root' ? 'root' : 'accepted'} login via ${e.detail || 'ssh'}`, 1, now());
  const known = get('SELECT ip FROM sec_known_ip WHERE ip=?', e.ip);
  run('INSERT INTO sec_known_ip(ip, user, first_seen, last_seen) VALUES(?,?,?,?) ON CONFLICT(ip) DO UPDATE SET last_seen=excluded.last_seen, user=excluded.user',
    e.ip, e.user, now(), now());
  if (e.kind === 'ssh_root') {
    if (cooldownOk('sec:root', cfg.securityCooldownMin)) {
      run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)', 'root', e.ip, e.user, 'root login', 1, now());
      await send(`👑 *ROOT SSH LOGIN*\nuser root accepted (${e.detail}) from ${e.ip}${known ? '' : ' — new IP'}`);
    }
    return;
  }
  if (known || !cooldownOk(`sec:newip:${e.ip}`, cfg.securityCooldownMin)) return;
  run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)', 'new_ip', e.ip, e.user, 'first login from this IP', 1, now());
  await send(`🔑 *NEW SSH LOGIN*\n${e.user}@${e.ip}\nThis IP has never logged in successfully before.`);
}

/** Tail a plain log file, remembering the byte offset; rotation (size shrink) restarts at 0. */
function readLogFile(p) {
  let st;
  try { st = fs.statSync(p); } catch { return { error: `${p} not readable (${process.platform === 'linux' ? 'is the service user in the adm group?' : 'file missing'})` }; }
  const key = `sec_off:${p}`;
  const prev = Number(setting(key, -1));
  if (prev < 0 || st.size < prev) { if (prev < 0) setSetting(key, st.size); return { text: '', first: true }; }
  const size = Math.min(st.size - prev, 512 * 1024);
  const buf = Buffer.alloc(size);
  const fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, buf, 0, size, prev); } finally { fs.closeSync(fd); }
  setSetting(key, prev + size);
  return { text: buf.toString('utf8') };
}

async function readJournal(unit) {
  const since = `${cfg.securityIntervalSec + 5}s ago`;
  const args = (u) => ['-u', u, '--no-pager', '-o', 'short-iso', '--since', since];
  for (const u of (unit === 'ssh' ? ['ssh', 'sshd'] : [unit])) {
    for (const fn of [cap, sys]) {
      try { const out = await fn('journalctl', args(u), 12000); if (out) return { text: out, unit: u }; } catch { /* try the next way in */ }
    }
  }
  return { text: '' };
}

/** `ss -tuln` text -> listeners keyed by proto|addr|port. Pure, so the baseline rules are testable anywhere. */
export function parseSs(out) {
  const seen = new Map();
  const PROTOS = /^(tcp|udp|sctp|udplite)$/i;
  for (const line of String(out || '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4 || p[0] === 'Netid') continue;
    // ss prints a Netid column only when more than one protocol family is asked for, which shifts everything.
    const named = PROTOS.test(p[0]);
    const local = p[named ? 4 : 3];
    const m = /^(.*):(\d+|\*)$/.exec(local || '');
    if (!m) continue;
    const proto = named ? p[0].toLowerCase() : (p[1] === 'LISTEN' || p[0] === 'LISTEN' ? 'tcp' : 'udp');
    const addr = m[1] || '*';
    seen.set(`${proto}|${addr}|${m[2]}`, { proto, addr, port: m[2] });
  }
  return seen;
}

/** Diff a scan against the saved baseline rows: {new, gone, kept}. */
export function diffPorts(seen, before) {
  const known = new Map(before.map((r) => [`${r.proto}|${r.addr}|${r.port}`, r]));
  const changes = [];
  const kept = [];
  for (const [k, v] of seen) (known.has(k) ? kept : changes).push({ dir: known.has(k) ? 'same' : 'new', ...v });
  for (const [k, r] of known) if (!seen.has(k)) changes.push({ dir: 'gone', proto: r.proto, addr: r.addr, port: r.port });
  return { changes, kept };
}

/** ss -tuln vs the saved baseline: first scan seeds silently, later diffs alert. */
async function portScan() {
  let out;
  try { out = await sys('ss', ['-tuln'], 8000); } catch (e) { return { ports: q('SELECT * FROM sec_port ORDER BY proto, port'), error: `ss unavailable (${e.code || e.message})` }; }
  const seen = parseSs(out);
  const before = q('SELECT * FROM sec_port WHERE state=?', 'open');
  if (!before.length && !seen.size) return { ports: [], seeded: false };
  const first = !before.length;
  const { changes, kept } = diffPorts(seen, before);
  for (const v of kept) run('UPDATE sec_port SET last_seen=? WHERE state=? AND proto=? AND addr=? AND port=?', now(), 'open', v.proto, v.addr, v.port);
  for (const ch of changes.filter((c) => c.dir === 'new')) {
    run(`INSERT INTO sec_port(proto, addr, port, first_seen, last_seen, state) VALUES(?,?,?,?,?,'open')
      ON CONFLICT(proto, addr, port) DO UPDATE SET last_seen=excluded.last_seen, state='open'`, ch.proto, ch.addr, ch.port, now(), now());
  }
  for (const ch of changes.filter((c) => c.dir === 'gone')) {
    run('UPDATE sec_port SET state=?, last_seen=? WHERE proto=? AND addr=? AND port=?', 'closed', now(), ch.proto, ch.addr, ch.port);
  }
  if (!first) {
    for (const ch of changes) {
      if (!cooldownOk(`sec:port:${ch.dir}:${ch.proto}:${ch.addr}:${ch.port}`, cfg.securityCooldownMin)) continue;
      run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)',
        ch.dir === 'new' ? 'port_new' : 'port_gone', '', '', `${ch.proto} ${ch.addr}:${ch.port}`, 1, now());
      await send(`${ch.dir === 'new' ? '🚪 *NEW LISTENING PORT*' : '🚫 *PORT STOPPED LISTENING*'}\n${ch.proto} ${ch.addr}:${ch.port}\nChecked against the saved ss -tuln baseline.`);
    }
  }
  return { ports: q('SELECT * FROM sec_port ORDER BY state DESC, proto, port + 0'), seeded: first };
}

let bans = { at: 0, jails: [], error: null };
const prevBanned = new Set();

/** fail2ban is optional: no binary, no news. */
async function fail2ban() {
  if (!cfg.fail2banJails.length) return { ...bans, skipped: 'FAIL2BAN_JAILS is empty' };
  const jails = [];
  for (const jail of cfg.fail2banJails) {
    try {
      const out = await sys('fail2ban-client', ['status', jail], 8000);
      const list = (out.match(/Currently banned:\s*(\d+)/i) || [])[1];
      const ips = ((out.match(/Banned IP list:\s*([^\n]*)/i) || [])[1] || '').split(/\s+/).filter(Boolean);
      jails.push({ jail, banned: +list || ips.length, ips });
      for (const ip of ips) if (!prevBanned.has(`${jail}|${ip}`)) {
        prevBanned.add(`${jail}|${ip}`);
        if (cooldownOk(`sec:f2b:${jail}`, cfg.securityCooldownMin)) {
          run('INSERT INTO sec_event(kind, ip, user, detail, count, created_at) VALUES(?,?,?,?,?,?)', 'banned', ip, jail, `banned by fail2ban ${jail}`, 1, now());
          await send(`🛡 *FAIL2BAN BANNED* ${ip}\njail: ${jail} · ${jails[jails.length - 1].banned} currently banned`);
        }
      }
    } catch (e) { jails.push({ jail, banned: null, ips: [], error: e.code === 'ENOENT' ? 'fail2ban-client not installed' : e.message }); }
  }
  for (const j of jails) {
    const live = new Set(j.ips.map((ip) => `${j.jail}|${ip}`));
    for (const k of [...prevBanned]) if (k.startsWith(`${j.jail}|`) && !live.has(k)) prevBanned.delete(k);
  }
  bans = { at: now(), jails, error: null };
  return bans;
}

export async function scanSecurity() {
  if (!cfg.securityEnabled) return { skipped: 'SECURITY_ENABLED=false' };
  const out = { events: 0, ports: null, bans: null };
  const src = cfg.authLogSource || '/var/log/auth.log';
  if (/^journalctl/i.test(src)) {
    const unit = (src.split(':')[1] || 'ssh').trim() || 'ssh';
    const r = await readJournal(unit);
    out.journal_unit = r.unit || unit;
    out.text = r.text;
  } else {
    const p = src.replace(/^file:/i, '');
    const r = readLogFile(p);
    if (r.error) out.log_error = r.error;
    if (r.first) out.log_note = 'cursor seeded at end of file — history is not replayed';
    out.text = r.text;
  }
  if (out.text) {
    const rows = parseChunk(out.text);
    const fails = rows.filter((r) => r.kind === 'ssh_fail');
    const ips = recordFails(fails);
    out.events = rows.length;
    for (const r of rows.filter((x) => x.kind !== 'ssh_fail')) await acceptLogin(r);
    for (const ip of ips) await alertBrute(ip);
  }
  if (cfg.portScan) out.ports = await portScan();
  if (cfg.fail2banJails.length) out.bans = await fail2ban();
  return out;
}

/** Everything the Security page renders — read-only, never spawns anything. */
export function securitySnapshot() {
  const day = now() - 864e5;
  return {
    enabled: cfg.securityEnabled,
    source: cfg.authLogSource,
    interval_sec: cfg.securityIntervalSec,
    rules: { failed_limit: cfg.sshFailedLimit, window_min: cfg.sshFailedWindowMin, cooldown_min: cfg.securityCooldownMin, port_scan: cfg.portScan },
    logins: q(`SELECT id, kind, ip, user, detail, count, created_at FROM sec_event WHERE kind IN ('ssh_fail','ssh_ok','ssh_root') AND created_at>? ORDER BY id DESC LIMIT 60`, day),
    alerts: q(`SELECT id, kind, ip, user, detail, count, created_at FROM sec_event WHERE kind NOT IN ('ssh_fail','ssh_ok','ssh_root') ORDER BY id DESC LIMIT 30`),
    top_ips: q(`SELECT ip, SUM(count) n, MAX(created_at) last_seen FROM sec_event WHERE kind='ssh_fail' AND created_at>? GROUP BY ip ORDER BY n DESC LIMIT 10`, now() - 7 * 864e5),
    ports: q('SELECT proto, addr, port, state, first_seen, last_seen FROM sec_port ORDER BY state DESC, proto, port + 0'),
    known_ips: q('SELECT ip, user, first_seen, last_seen FROM sec_known_ip ORDER BY last_seen DESC LIMIT 50'),
    bans,
    server: localServerId,
  };
}
