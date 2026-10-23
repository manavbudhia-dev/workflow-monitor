/** API client + derived metrics. Every number in the UI comes from these endpoints — nothing is faked. */
export async function api(path, opts = {}) {
  const r = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && !path.startsWith('/login')) { location.href = '/login.html'; throw new Error('Session expired, sign in again.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}

export const store = {
  summary: null, schema: null, metrics: null, n8n: [], incidents: [], servers: [],
  backups: null, security: null, restarts: [], logSources: null,
  hours: 24, serverId: 0, openIncident: 0, tab: 'all', query: '', sort: 'name',
};

export async function loadSummary() {
  store.summary = await api('/summary');
  const s = store.summary.servers;
  if (!s.some((x) => x.id === store.serverId)) store.serverId = (s.find((x) => x.is_local) || s[0] || {}).id || 0;
  return store.summary;
}

export async function loadSchema() {
  if (!store.schema) store.schema = await api('/schema');
  return store.schema;
}

export async function loadMetrics() {
  store.metrics = await api(`/metrics?hours=${store.hours}&server_id=${store.serverId}`);
  return store.metrics;
}
export const loadN8n = () => api('/n8n').then((r) => (store.n8n = r));
export const loadIncidents = (state = '') => api(`/incidents?limit=200${state ? `&state=${state}` : ''}`).then((r) => (store.incidents = r));
export const loadServers = () => api('/servers').then((r) => (store.servers = r));
export const loadBackups = () => api('/backups').then((r) => (store.backups = r));
export const loadSecurity = () => api('/security').then((r) => (store.security = r));
export const loadRestarts = () => api('/restarts?limit=60').then((r) => (store.restarts = r));

/** Fetched once: the whitelist is .env-driven, so it only changes when the server restarts. */
export async function loadLogSources(force) {
  if (store.logSources && !force) return store.logSources;
  try { store.logSources = (await api('/logs/sources')).sources; } catch { store.logSources = []; }
  return store.logSources;
}

/** Which whitelisted log source belongs to a monitor, if the operator named one for it. */
export function logSourceFor(m) {
  const list = store.logSources || [];
  if (!m || !list.length) return null;
  let c = m.config || {};
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  const keys = [m.name, c.unit, c.name, c.service, c.log?.unit, c.log?.name]
    .filter(Boolean).map((s) => String(s).trim().toLowerCase());
  return list.find((s) => keys.includes(String(s.name).toLowerCase()))?.name || null;
}

/* ---------- status derivation ---------- */

/** Backend stores a boolean; the design needs a 4th state for "up but flapping". */
export function statusOf(m) {
  if (!m.enabled) return 'paused';
  if (m.ok === null || m.ok === undefined) return 'pending';
  if (m.ok === false) return 'down';
  if (m.uptime !== null && m.uptime < 100) return 'degraded';
  if (/expir|restart|overdue/i.test(m.detail || '')) return 'degraded';
  return 'up';
}
export const STATUS_LABEL = { up: 'UP', down: 'DOWN', degraded: 'DEGRADED', pending: 'PENDING', paused: 'PAUSED' };

export const enabledMonitors = () => (store.summary?.monitors || []).filter((m) => m.enabled);

/* ---------- uptime from incident wall-clock windows ---------- */

const HOUR = 36e5;
const downWindowsFor = (incidents, monitorId) =>
  incidents.filter((i) => i.monitor_id === monitorId).map((i) => [i.started_at, i.resolved_at || Date.now()]);

const overlapMs = (windows, from, to) =>
  windows.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);

/**
 * Hourly uptime buckets over the last `buckets` hours, averaged across enabled monitors.
 * Wall-clock downtime is the honest definition of uptime; the per-monitor "24h" column in the
 * table stays checks-based because that is what the scheduler actually sampled.
 */
export function uptimeSeries(incidents, monitors, buckets = 24, offsetHours = 0) {
  const now = Date.now();
  const ids = monitors.map((m) => m.id);
  if (!ids.length) return { series: Array(buckets).fill(100), avg: null };
  const wins = new Map(ids.map((id) => [id, downWindowsFor(incidents, id)]));
  const series = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const to = now - (i + offsetHours) * HOUR;
    const from = to - HOUR;
    let up = 0;
    for (const id of ids) up += 1 - Math.min(1, overlapMs(wins.get(id), from, to) / HOUR);
    series.push(Math.round((up / ids.length) * 10000) / 100);
  }
  return { series, avg: Math.round((series.reduce((a, b) => a + b, 0) / series.length) * 100) / 100 };
}

export function uptimeStats() {
  const mons = enabledMonitors();
  const cur = uptimeSeries(store.incidents, mons, 24, 0);
  const prev = uptimeSeries(store.incidents, mons, 24, 24);
  const delta = cur.avg !== null && prev.avg !== null ? Math.round((cur.avg - prev.avg) * 100) / 100 : null;
  return { ...cur, prev: prev.avg, delta };
}

/* ---------- n8n workflow health ---------- */

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** Worst workflow right now, plus the numbers for the stat card and the health card. */
export function workflowStats() {
  const rows = store.n8n || [];
  if (!rows.length) return null;
  const score = (r) => (r.current ? r.current.rate : r.avg_24h === null || r.avg_24h === undefined ? 100 : r.avg_24h);
  const worst = rows.slice().sort((a, b) => score(a) - score(b))[0];
  const all = rows.flatMap((r) => r.samples || []);
  const now = Date.now();
  const rate = score(worst);
  const recent = avg(all.filter((s) => now - s.t <= 12 * HOUR).map((s) => s.rate));
  const older = avg(all.filter((s) => now - s.t > 12 * HOUR && now - s.t <= 48 * HOUR).map((s) => s.rate));
  return {
    worst,
    rate,
    delta: recent !== null && older !== null ? Math.round((recent - older) * 10) / 10 : null,
    spark: (worst.samples || []).slice(-24).map((s) => s.rate),
    runs: (worst.samples || []).slice(-24),
    failed: worst.current ? worst.current.failed : null,
    total: worst.current ? worst.current.total : null,
    lastRun: (worst.samples || []).length ? worst.samples[worst.samples.length - 1].t : null,
    avg24: worst.avg_24h,
    count: rows.length,
  };
}

/* ---------- host ---------- */

export function hostStats() {
  const s = (store.summary?.servers || []).find((x) => x.id === store.serverId) || {};
  return {
    server: s,
    cpu: s.cpu ?? null,
    mem: s.mem ?? null,
    disk: s.disk ?? null,
    load: s.load ?? null,
    cpuSeries: (store.metrics?.points || []).map((p) => p.cpu),
  };
}
export const currentServer = () => (store.summary?.servers || []).find((x) => x.id === store.serverId) || {};

export async function refreshAll() {
  await loadSummary();
  await Promise.all([
    loadMetrics().catch(() => null), loadN8n().catch(() => []),
    loadIncidents().catch(() => []), loadServers().catch(() => []),
    loadBackups().catch(() => null), loadSecurity().catch(() => null), loadRestarts().catch(() => []),
  ]);
}

/* ---------- backup + security derivations ---------- */

/** The backup monitor that needs attention most, plus its size history for the trend. */
export function backupStats() {
  const rows = (store.backups?.monitors || []).filter((r) => r.enabled);
  if (!rows.length) return null;
  const byNewest = (a, b) => (b.last?.mtime || 0) - (a.last?.mtime || 0);
  const pick = rows.filter((r) => r.ok === false).sort(byNewest)[0] || rows.slice().sort(byNewest)[0];
  const hist = pick?.history || [];
  return {
    count: rows.length,
    failing: rows.filter((r) => r.ok === false).length,
    pick,
    sizes: hist.map((h) => h.size),
    files: hist.map((h) => h.file),
    mtimes: hist.map((h) => h.mtime),
  };
}

export function securityStats() {
  const s = store.security;
  if (!s) return null;
  const day = Date.now() - 864e5;
  const attacks = (s.top_ips || []).slice(0, 5);
  return {
    enabled: s.enabled,
    alerts: (s.alerts || []).filter((a) => a.created_at > day).length,
    failures: (s.logins || []).filter((l) => l.kind === 'ssh_fail').reduce((n, l) => n + (l.count || 1), 0),
    attacks,
    top: attacks[0]?.n || 0,
    ports: (s.ports || []).filter((p) => p.state === 'open').length,
    banned: (s.bans?.jails || []).reduce((n, j) => n + (j.banned || 0), 0),
  };
}
