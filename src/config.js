import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
}
loadEnv();

const num = (k, d) => (process.env[k] === undefined || process.env[k] === '' || isNaN(+process.env[k]) ? d : +process.env[k]);
const bool = (k, d) => (process.env[k] === undefined ? d : /^(1|true|yes|on)$/i.test(process.env[k]));
const list = (k) => (process.env[k] || '').split(/[,\s]+/).filter(Boolean);
/** RESTART_ALLOW holds whole commands, so entries are separated by ';' instead of ','. */
const semis = (k) => (process.env[k] || '').split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
const some = (k, d) => (list(k).length ? list(k) : d);

/** LOG_SOURCES entry: `name=journal:unit` | `name=pm2:app` | `name=file:/abs/path`. */
function logSource(entry) {
  const eq = entry.indexOf('=');
  if (eq < 1) return null;
  const name = entry.slice(0, eq).trim();
  const rest = entry.slice(eq + 1).trim();
  const colon = rest.indexOf(':');
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name) || colon < 0) return null;
  const kind = rest.slice(0, colon).toLowerCase();
  const target = rest.slice(colon + 1).trim();
  if (!['journal', 'pm2', 'file'].includes(kind) || !target) return null;
  return { name, kind, target };
}

export const cfg = {
  port: num('PORT', 4180),
  bind: process.env.BIND_HOST || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${num('PORT', 4180)}`).replace(/\/+$/, ''),
  dbPath: process.env.DB_PATH || path.resolve('data/monitor.db'),

  password: process.env.PASSWORD || 'admin',
  sessionSecret: process.env.SESSION_SECRET || 'change-me-session-secret',
  sessionHours: num('SESSION_HOURS', 72),

  metricsIntervalSec: num('METRICS_INTERVAL_SEC', 30),
  checkIntervalSec: num('CHECK_INTERVAL_SEC', 60),
  retentionDays: num('RETENTION_DAYS', 7),

  agentKeys: list('AGENT_API_KEYS'),

  cpuWarnPct: num('CPU_WARN_PCT', 90),
  memWarnPct: num('MEM_WARN_PCT', 90),
  diskWarnPct: num('DISK_WARN_PCT', 90),
  loadWarnFactor: num('LOAD_WARN_FACTOR', 2),
  warnStreak: num('WARN_STREAK', 3),
  sslWarnDays: num('SSL_WARN_DAYS', 14),

  cooldownMin: num('ALERT_COOLDOWN_MIN', 30),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChats: list('TELEGRAM_CHAT_IDS'),
  telegramOwners: list('TELEGRAM_OWNER_IDS'),
  dailySummary: bool('DAILY_SUMMARY', true),
  summaryHour: num('SUMMARY_HOUR', 8),

  aiProvider: (process.env.AI_PROVIDER || 'none').toLowerCase(),
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'gpt-4o-mini',
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  n8nUrl: process.env.N8N_URL || '',
  n8nKey: process.env.N8N_API_KEY || '',

  restartEnabled: bool('RESTART_ENABLED', true),
  restartAllow: semis('RESTART_ALLOW'),
  restartBins: some('RESTART_ALLOW_BINS', ['systemctl', 'service', 'pm2']),
  restartVerbs: some('RESTART_ALLOW_VERBS', ['restart', 'start', 'reload', 'reload-or-restart', 'try-restart']),
  restartWaitSec: num('RESTART_WAIT_SEC', 15),
  restartRetries: num('RESTART_MAX_RETRIES', 3),
  restartCooldownMin: num('RESTART_COOLDOWN_MIN', 10),

  backupEnabled: bool('BACKUP_ENABLED', true),

  securityEnabled: bool('SECURITY_ENABLED', true),
  securityIntervalSec: num('SECURITY_INTERVAL_SEC', 60),
  authLogSource: process.env.AUTH_LOG_SOURCE || '/var/log/auth.log',
  sshFailedLimit: num('SSH_FAILED_LIMIT', 10),
  sshFailedWindowMin: num('SSH_FAILED_WINDOW_MIN', 10),
  securityCooldownMin: num('SECURITY_COOLDOWN_MIN', 30),
  portScan: bool('PORT_SCAN_ENABLED', true),
  fail2banJails: list('FAIL2BAN_JAILS'),

  logEnabled: bool('LOG_ENABLED', true),
  logSources: semis('LOG_SOURCES').map(logSource).filter(Boolean),
  logMaxLines: Math.min(Math.max(num('LOG_MAX_LINES', 1000), 50), 5000),
  logStreamMax: Math.max(num('LOG_STREAM_MAX', 2), 1),
  logIdleMin: Math.max(num('LOG_IDLE_MIN', 10), 1),
  logPollMs: Math.max(num('LOG_POLL_MS', 1000), 250),

  pushPublic: process.env.VAPID_PUBLIC_KEY || '',
  pushPrivate: process.env.VAPID_PRIVATE_KEY || '',
  pushSubject: process.env.VAPID_SUBJECT || 'mailto@admin.local',
};
