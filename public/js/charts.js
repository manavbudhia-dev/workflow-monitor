/** Chart.js factories. Instances are keyed and updated in place so the 30s refresh never re-creates canvases. */
const charts = new Map();

export function draw(key, canvas, build) {
  const spec = build();
  const hit = charts.get(key);
  if (hit && hit.canvas === canvas) {
    hit.chart.data = spec.data;
    hit.chart.options = spec.options;
    hit.chart.update('none');
    return hit.chart;
  }
  if (hit) hit.chart.destroy();
  const chart = new Chart(canvas, { type: spec.type, data: spec.data, options: spec.options });
  charts.set(key, { chart, canvas });
  return chart;
}

/** Drop registry entries whose canvas left the DOM (page switches), so Chart.js leaks nothing. */
export function destroyAll(prefix = '') {
  for (const [k, hit] of [...charts]) {
    if (k.startsWith(prefix) && !document.contains(hit.canvas)) { hit.chart.destroy(); charts.delete(k); }
  }
}

const GRID = 'rgba(255,255,255,.05)';
const AXIS = { color: '#626e88', font: { size: 11 }, maxTicksLimit: 7 };
const base = (extra = {}) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { display: false }, tooltip: {
    backgroundColor: '#131e34', borderColor: '#1d2841', borderWidth: 1, padding: 9, displayColors: true, boxWidth: 8, boxHeight: 8, usePointStyle: true,
    titleColor: '#e9eef8', bodyColor: '#a9b4cc', titleFont: { size: 11.5 }, bodyFont: { size: 11.5 },
  } },
  elements: { point: { radius: 0, hitRadius: 14, hoverRadius: 4 }, line: { borderWidth: 1.8, tension: 0.32 } },
  ...extra,
});

export function sparkline(key, canvas, values, color) {
  const flat = new Set(values).size < 2;
  return draw(key, canvas, () => ({
    type: 'line',
    data: {
      labels: values.map((_, i) => i),
      datasets: [{
        data: values, borderColor: color, borderWidth: 1.7, tension: 0.35, pointRadius: 0,
        fill: !flat, backgroundColor: !flat ? soft(color) : undefined,
      }],
    },
    options: base({
      scales: { x: { display: false }, y: { display: false, min: yMin(values), max: yMax(values) } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      layout: { padding: 2 },
    }),
  }));
}

const yMin = (v) => { const m = Math.min(...v); return m > 0 ? Math.max(0, Math.floor(m * 0.9)) : m; };
const yMax = (v) => { const m = Math.max(...v); return m < 100 ? Math.min(100, Math.ceil(m * 1.08)) : 100; };
const soft = (hex) => `${hex}22`;

/** Host resource usage: CPU / Memory / Disk as % area lines. */
export function resourceChart(key, canvas, points) {
  const labels = points.map((p) => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const line = (k, color, fill) => ({
    label: k, data: points.map((p) => p[k] ?? null), borderColor: color,
    backgroundColor: fill ? soft(color) : 'transparent', fill: !!fill, pointRadius: 0, borderWidth: 1.8, tension: 0.3, spanGaps: true,
  });
  return draw(key, canvas, () => ({
    type: 'line',
    data: { labels, datasets: [line('cpu', '#2f7bff', true), line('mem', '#f5b73b', false), line('disk', '#ef4444', false)] },
    options: base({
      scales: {
        x: { grid: { color: GRID, drawTicks: false }, border: { display: false }, ticks: { ...AXIS, maxTicksLimit: 8, padding: 8 } },
        y: { min: 0, max: 100, grid: { color: GRID, drawTicks: false }, border: { display: false }, ticks: { ...AXIS, stepSize: 25, padding: 8, callback: (v) => `${v}%` } },
      },
    }),
  }));
}

/** Network throughput, used on the Hosts page. */
export function netChart(key, canvas, points) {
  const labels = points.map((p) => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const line = (k, color) => ({ label: k, data: points.map((p) => p[k] ?? null), borderColor: color, backgroundColor: soft(color), fill: true, pointRadius: 0, borderWidth: 1.8, tension: 0.3 });
  return draw(key, canvas, () => ({
    type: 'line',
    data: { labels, datasets: [line('net_in', '#2f7bff'), line('net_out', '#8b5cf6')] },
    options: base({
      scales: {
        x: { grid: { color: GRID, drawTicks: false }, border: { display: false }, ticks: { ...AXIS, maxTicksLimit: 6, padding: 8 } },
        y: { min: 0, grid: { color: GRID, drawTicks: false }, border: { display: false }, ticks: { ...AXIS, padding: 8, callback: (v) => `${v} Mb` } },
      },
    }),
  }));
}

/** Per-sample success bars for the workflow health card. */
export function runsChart(key, canvas, samples, minRate = 100) {
  return draw(key, canvas, () => ({
    type: 'bar',
    data: {
      labels: samples.map((s) => new Date(s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      datasets: [{
        data: samples.map((s) => s.rate),
        borderWidth: 0, borderRadius: 1, barPercentage: 0.62, categoryPercentage: 0.9,
        backgroundColor: samples.map((s) => (s.rate >= minRate ? '#22c55e' : s.rate >= minRate - 20 ? '#f5b73b' : '#ef4444')),
      }],
    },
    options: base({
      scales: { x: { display: false }, y: { display: false, min: 0, max: 105 } },
      plugins: { legend: { display: false }, tooltip: { enabled: true, callbacks: { label: (c) => `${c.parsed.y}% success` } } },
      elements: { line: {} },
    }),
  }));
}

/** Incident volume per day, used on the Incidents page. */
export function incidentBars(key, canvas, rows) {
  return draw(key, canvas, () => ({
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{ data: rows.map((r) => r.n), backgroundColor: '#ef4444', borderWidth: 0, borderRadius: 2, barPercentage: 0.55 }],
    },
    options: base({
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { ...AXIS, maxTicksLimit: 7, padding: 6 } },
        y: { display: false, min: 0 },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y} incidents` } } },
    }),
  }));
}

/** Sizes of the last backups, newest bar highlighted; always seven slots so the scale stays steady. */
export function backupTrend(key, canvas, rows) {
  const max = Math.max(...rows.map((r) => r.size || 0), 1);
  const [unit, div] = max >= 1073741824 ? ['GB', 1073741824] : max >= 1048576 ? ['MB', 1048576] : max >= 1024 ? ['KB', 1024] : ['B', 1];
  const pts = [...Array(Math.max(0, 7 - rows.length)).fill(null), ...rows.slice(-7)];
  return draw(key, canvas, () => ({
    type: 'bar',
    data: {
      labels: pts.map((_, i) => i + 1),
      datasets: [{
        data: pts.map((r) => (r ? +(r.size / div).toFixed(2) : null)),
        backgroundColor: pts.map((_, i) => (i === pts.length - 1 ? '#2f7bff' : '#2c3f66')),
        borderWidth: 0, borderRadius: 2, barPercentage: 0.62, maxBarThickness: 46,
      }],
    },
    options: base({
      scales: { x: { display: false }, y: { display: false, min: 0 } },
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: (c) => pts[c[0].dataIndex]?.file || '',
        label: (c) => `${c.parsed.y} ${unit} · ${new Date(pts[c.dataIndex].mtime).toLocaleString()}`,
      } } },
    }),
  }));
}
