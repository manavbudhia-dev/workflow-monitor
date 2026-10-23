/**
 * Stand-in broken service, used to try auto-restart and the alert paths without a real
 * systemd unit (works on any OS):
 *   node scripts/fake-service.js restart fake     start a listener on FAKE_PORT, exit 0
 *   node scripts/fake-service.js restart broken   exit 0 but stay dead (tests give-up)
 *   node scripts/fake-service.js stop
 * Env: FAKE_PORT (4188), FAKE_TTL_SEC (60) — how long it stays up before "crashing".
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = +(process.env.FAKE_PORT || 4188);
const ttl = +(process.env.FAKE_TTL_SEC || 60);
const here = import.meta.filename;
const pidFile = path.resolve('data', `fake-service-${port}.pid`);
const [cmd = 'help', name = 'fake'] = process.argv.slice(2);

const killOld = () => {
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ }
  fs.rmSync(pidFile, { force: true });
};

if (cmd === 'serve') {
  net.createServer((s) => s.end('fake-service ok\n')).listen(port, '127.0.0.1', () => {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
    console.log(`fake-service listening on ${port} (pid ${process.pid}, ttl ${ttl}s)`);
  });
  setTimeout(() => process.exit(0), ttl * 1000).unref();
  process.on('SIGTERM', () => process.exit(0));
} else if (cmd === 'restart' || cmd === 'start') {
  killOld();
  if (name === 'broken') { console.log(`fake-service ${name}: restart accepted, service stayed down`); process.exit(0); }
  const child = spawn(process.execPath, [here, 'serve'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  console.log(`fake-service restarted (pid ${child.pid})`);
  process.exit(0);
} else if (cmd === 'stop') {
  killOld();
  console.log('fake-service stopped');
  process.exit(0);
} else {
  console.log('usage: node scripts/fake-service.js "restart fake | restart broken | stop"');
}
