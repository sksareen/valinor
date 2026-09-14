// Agent usage sampler — OpenRouter call telemetry for ACTIVITY.
// Mirrors hw-sampler.js: in-memory ring + optional jsonl persistence + SSE subscribers.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_MAX = 2000;
const SERIES_MAX = 120; // buckets across the requested hours window

const history = []; // newest at end — raw call records
const listeners = new Set();
const BOOT_AT = Date.now();
const lifetime = emptyTotals();

function emptyTotals() {
  return {
    calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    cost: 0, costN: 0, errors: 0, firstAt: null, lastAt: null,
  };
}

function addTotals(acc, row) {
  acc.calls += 1;
  acc.prompt_tokens += row.prompt_tokens || 0;
  acc.completion_tokens += row.completion_tokens || 0;
  acc.total_tokens += row.total_tokens || 0;
  if (row.cost != null && Number.isFinite(row.cost)) { acc.cost += row.cost; acc.costN += 1; }
  if (!row.ok) acc.errors += 1;
  if (row.t) {
    if (acc.firstAt == null || row.t < acc.firstAt) acc.firstAt = row.t;
    if (acc.lastAt == null || row.t > acc.lastAt) acc.lastAt = row.t;
  }
}

function finishTotals(acc) {
  return {
    calls: acc.calls,
    prompt_tokens: acc.prompt_tokens,
    completion_tokens: acc.completion_tokens,
    total_tokens: acc.total_tokens,
    cost: acc.costN ? Math.round(acc.cost * 1e6) / 1e6 : null,
    errors: acc.errors,
    firstAt: acc.firstAt,
    lastAt: acc.lastAt,
  };
}

const LOG_CANDIDATES = [
  process.env.AGENT_USAGE_PATH,
  path.join(__dirname, 'agent-usage.jsonl'),
  path.join(os.homedir(), '.handviz', 'agent-usage.jsonl'),
].filter(Boolean);

let logPath = null;

function ensureLogPath() {
  if (logPath) return logPath;
  for (const p of LOG_CANDIDATES) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, '');
      logPath = p;
      return p;
    } catch { /* try next */ }
  }
  return null;
}

function loadFromDisk() {
  const p = ensureLogPath();
  if (!p) return;
  try {
    const text = fs.readFileSync(p, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const loaded = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (!row || typeof row.t !== 'number') continue;
        const n = normalize(row);
        addTotals(lifetime, n);
        loaded.push(n);
      } catch { /* skip bad line */ }
    }
    history.push(...loaded.slice(-HISTORY_MAX));
  } catch { /* fresh file ok */ }
}

function clipField(s, n = 480) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function normalize(raw) {
  const usage = raw.usage || {};
  const prompt = Number(raw.prompt_tokens ?? usage.prompt_tokens) || 0;
  const completion = Number(raw.completion_tokens ?? usage.completion_tokens) || 0;
  const total = Number(raw.total_tokens ?? usage.total_tokens) || (prompt + completion);
  const cost = raw.cost != null ? Number(raw.cost) : (usage.cost != null ? Number(usage.cost) : null);
  return {
    t: Number(raw.t) || Date.now(),
    surface: String(raw.surface || 'unknown'),
    model: String(raw.model || ''),
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cost: Number.isFinite(cost) ? cost : null,
    latencyMs: raw.latencyMs != null ? Number(raw.latencyMs) : null,
    ttftMs: raw.ttftMs != null ? Number(raw.ttftMs) : null,
    ok: raw.ok !== false,
    turnId: raw.turnId || null,
    label: raw.label || null,
    input: clipField(raw.input),
    output: clipField(raw.output),
  };
}

function persist(row) {
  const p = ensureLogPath();
  if (!p) return;
  try { fs.appendFileSync(p, JSON.stringify(row) + '\n'); } catch { /* ignore */ }
}

function broadcast(row) {
  for (const fn of listeners) {
    try { fn(row); } catch { listeners.delete(fn); }
  }
}

/** Record one completed OpenRouter (or equivalent) call. */
function record(partial) {
  const row = normalize({ t: Date.now(), ...partial });
  history.push(row);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  addTotals(lifetime, row);
  persist(row);
  broadcast(row);
  return row;
}

function since(hours) {
  const h = Math.max(0.25, Math.min(48, Number(hours) || 2));
  const cut = Date.now() - h * 3600_000;
  return history.filter((r) => r.t >= cut);
}

function breakdown(rows, key) {
  const map = Object.create(null);
  for (const r of rows) {
    const k = r[key] || 'unknown';
    if (!map[k]) map[k] = { key: k, calls: 0, tokens: 0, cost: 0, latencySum: 0, latencyN: 0, errors: 0 };
    const b = map[k];
    b.calls += 1;
    b.tokens += r.total_tokens;
    if (r.cost != null) b.cost += r.cost;
    if (r.latencyMs != null) { b.latencySum += r.latencyMs; b.latencyN += 1; }
    if (!r.ok) b.errors += 1;
  }
  return Object.values(map)
    .map((b) => ({
      name: b.key,
      calls: b.calls,
      tokens: b.tokens,
      cost: Math.round(b.cost * 1e6) / 1e6,
      latencyMs: b.latencyN ? Math.round(b.latencySum / b.latencyN) : null,
      errors: b.errors,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
}

function series(rows, hours = 2) {
  if (!rows.length) return [];
  const h = Math.max(0.25, Math.min(48, Number(hours) || 2));
  const span = h * 3600_000;
  const now = Date.now();
  const start = now - span;
  const bucketMs = span / SERIES_MAX;
  const buckets = [];
  for (let i = 0; i < SERIES_MAX; i++) {
    const t0 = start + i * bucketMs;
    buckets.push({ t: t0 + bucketMs / 2, tokens: 0, calls: 0, cost: 0, latencySum: 0, latencyN: 0 });
  }
  for (const r of rows) {
    if (r.t < start) continue;
    const idx = Math.min(SERIES_MAX - 1, Math.max(0, Math.floor((r.t - start) / bucketMs)));
    const b = buckets[idx];
    b.tokens += r.total_tokens;
    b.calls += 1;
    if (r.cost != null) b.cost += r.cost;
    if (r.latencyMs != null) { b.latencySum += r.latencyMs; b.latencyN += 1; }
  }
  return buckets.map((b) => ({
    t: b.t,
    tokens: b.tokens,
    calls: b.calls,
    cost: Math.round(b.cost * 1e6) / 1e6,
    latencyMs: b.latencyN ? Math.round(b.latencySum / b.latencyN) : null,
  }));
}

function summarize(rows) {
  let prompt = 0, completion = 0, tokens = 0, cost = 0, costN = 0;
  let latencySum = 0, latencyN = 0, errors = 0;
  for (const r of rows) {
    prompt += r.prompt_tokens;
    completion += r.completion_tokens;
    tokens += r.total_tokens;
    if (r.cost != null) { cost += r.cost; costN += 1; }
    if (r.latencyMs != null) { latencySum += r.latencyMs; latencyN += 1; }
    if (!r.ok) errors += 1;
  }
  return {
    calls: rows.length,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: tokens,
    cost: costN ? Math.round(cost * 1e6) / 1e6 : null,
    latencyMs: latencyN ? Math.round(latencySum / latencyN) : null,
    errors,
  };
}

function getSnapshot(hours = 2) {
  const h = Math.max(0.25, Math.min(48, Number(hours) || 2));
  const rows = since(h);
  const sessionRows = history.filter((r) => r.t >= BOOT_AT);
  return {
    at: Date.now(),
    hours: h,
    bootAt: BOOT_AT,
    logPath,
    totals: summarize(rows),
    session: summarize(sessionRows),
    lifetime: finishTotals(lifetime),
    bySurface: breakdown(rows, 'surface'),
    byModel: breakdown(rows, 'model'),
    series: series(rows, h),
    recent: rows.slice(-80).reverse(),
    log: history.slice(-250).reverse().map((r) => ({
      t: r.t,
      surface: r.surface,
      model: r.model,
      prompt_tokens: r.prompt_tokens,
      completion_tokens: r.completion_tokens,
      total_tokens: r.total_tokens,
      cost: r.cost,
      latencyMs: r.latencyMs,
      ok: r.ok,
      label: r.label,
      input: r.input || '',
      output: r.output || '',
    })),
  };
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

loadFromDisk();

module.exports = {
  record,
  getSnapshot,
  subscribe,
  HISTORY_MAX,
};
