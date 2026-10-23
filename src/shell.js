import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run1 = promisify(execFile);

/** Run a program without a shell so operator-supplied names cannot inject arguments. */
export async function cap(bin, args, ms = 12000) {
  const { stdout, stderr } = await run1(bin, args, { maxBuffer: 4 * 1024 * 1024, timeout: ms });
  return `${stdout}${stderr}`.trim();
}

const nonRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0;

/** systemctl/journalctl need root; install.sh grants a narrow sudoers rule for the service user. */
export const sys = (bin, args, ms) => (nonRoot ? cap('sudo', ['-n', bin, ...args], ms) : cap(bin, args, ms));

/** Long-lived follower for the log tailer: same no-shell argv rule, stdout streamed. */
export function stream(bin, args) {
  const [b, a] = nonRoot ? ['sudo', ['-n', bin, ...args]] : [bin, args];
  const child = spawn(b, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => { /* surfaced through the caller's stderr/exit handler */ });
  return child;
}
