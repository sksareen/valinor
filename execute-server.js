// execute-server.js — the EXECUTE task store + review turn.
//
// The execution loop that sits after INGEST/PLAN: tangible outcomes become tasks that move
// Backlog -> Active (timer runs) -> Review (proof attached, agent asks a question) -> Done.
// One JSON file IS the store; proof screenshots live alongside as <taskId>.<ext>.
// Default: the user data home's execute/ dir (override with EXECUTE_DIR).
// Personal task data stays out of git by construction.
const fs = require('fs');
const path = require('path');
const dataHome = require('./data-home');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const agentUsage = require('./agent-usage');
const REVIEW_MODEL =
  process.env.OPENROUTER_CAPTURE_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

// Task store home: EXECUTE_DIR, then the user data home. Outside the repo.
const EXECUTE_DIR =
  process.env.EXECUTE_DIR || path.join(dataHome.dataDir(), 'execute');
const TASKS_FILE = path.join(EXECUTE_DIR, 'tasks.json');
const EVENTS_FILE = path.join(EXECUTE_DIR, 'events.jsonl');
// Notes the render step evaluated and judged genuinely non-actionable (pure journal/vibes).
// Persisted so the auto-render path (and the batch backstop) never re-processes them on
// every capture. NOTE: only genuine non-actionable notes are recorded here — render/model
// FAILURES are NOT, so the batch backstop can still retry those later.
const SKIPPED_FILE = path.join(EXECUTE_DIR, 'skipped-ingest.json');
const SCAN_HOURS = 48;
const SCAN_NOTE_CAP = 30;

function ensureDir() {
  fs.mkdirSync(EXECUTE_DIR, { recursive: true });
  return EXECUTE_DIR;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ---- completion-engine fields --------------------------------------------
// action_type enum used at render time (slice archetype = 'draft').
const ACTION_TYPES = ['draft', 'reply', 'transact', 'schedule', 'errand', 'other'];
const DURATION_BUCKETS = ['<2min', '<15min', '>15min'];

// Backfill the completion-engine fields on legacy tasks so nothing breaks on read.
// Mutates & returns the same object (safe: readAll owns freshly-parsed objects).
function backfill(t) {
  if (!t || typeof t !== 'object') return t;
  if (!('intent' in t)) t.intent = null;
  if (!('action_type' in t)) t.action_type = null;
  if (!('duration_bucket' in t)) t.duration_bucket = null;
  if (!('prestaged_ref' in t)) t.prestaged_ref = null;
  if (!('scheduled_block' in t)) t.scheduled_block = null;
  if (!('outcome_meta' in t)) t.outcome_meta = null;
  // Original ingest context, snapshotted at creation so the task stays
  // understandable even if the capture is edited or deleted later.
  if (!('sourceTitle' in t)) t.sourceTitle = null;
  if (!('sourceBody' in t)) t.sourceBody = null;
  if (!Array.isArray(t.state_history)) {
    // Seed history with the task's current status so re-enter counting has a baseline.
    t.state_history = t.status
      ? [{ state: t.status, at: t.created || t.updated || new Date().toISOString() }]
      : [];
  }
  return t;
}

// ---- store read/write ----------------------------------------------------
function readAll() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    const arr = Array.isArray(j) ? j : Array.isArray(j.tasks) ? j.tasks : [];
    return arr.map(backfill);
  } catch (e) {
    return [];
  }
}

function writeAll(tasks) {
  ensureDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  return tasks;
}

function appendEvent({ type, id, ingestId, title, meta } = {}) {
  if (!type) return;
  ensureDir();
  const row = { t: Date.now(), type };
  if (id) row.id = id;
  if (ingestId) row.ingestId = ingestId;
  if (title) row.title = title;
  if (meta && typeof meta === 'object') row.meta = meta;
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(row) + '\n', 'utf8');
}

// ---- non-actionable skip-set (P1: mark, don't reprocess) -----------------
function readSkipSet() {
  ensureDir();
  if (!fs.existsSync(SKIPPED_FILE)) return new Set();
  try {
    const j = JSON.parse(fs.readFileSync(SKIPPED_FILE, 'utf8'));
    const arr = Array.isArray(j) ? j : Array.isArray(j.ids) ? j.ids : [];
    return new Set(arr.filter(Boolean));
  } catch {
    return new Set();
  }
}

function markSkipped(ingestId) {
  const id = String(ingestId || '').trim();
  if (!id) return;
  const set = readSkipSet();
  if (set.has(id)) return;
  set.add(id);
  ensureDir();
  fs.writeFileSync(SKIPPED_FILE, JSON.stringify({ ids: [...set] }, null, 2), 'utf8');
}

function findProof(id, task) {
  const safe = path.basename(String(id || ''));
  if (!safe) return null;
  const named = task && task.proof ? path.join(EXECUTE_DIR, path.basename(String(task.proof))) : null;
  if (named && fs.existsSync(named)) return named;
  try {
    const files = fs.readdirSync(EXECUTE_DIR);
    const hit = files.find((f) => f.startsWith(safe + '.') && !f.endsWith('.json') && !f.endsWith('.jsonl'));
    if (hit) return path.join(EXECUTE_DIR, hit);
  } catch { /* ignore */ }
  for (const ext of ['.png', '.jpg', '.webp', '.jpeg']) {
    const p = path.join(EXECUTE_DIR, `${safe}${ext === '.jpeg' ? '.jpg' : ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isImageMime(mime) {
  return /^image\//i.test(String(mime || ''));
}

function extFromName(name, mime) {
  const fromName = path.extname(String(name || '')).toLowerCase();
  if (fromName && /^\.[a-z0-9]{1,8}$/i.test(fromName)) return fromName === '.jpeg' ? '.jpg' : fromName;
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'application/pdf') return '.pdf';
  if (m === 'text/plain') return '.txt';
  if (m === 'text/markdown') return '.md';
  if (m === 'application/zip') return '.zip';
  if (m === 'application/json') return '.json';
  return '.bin';
}

function safeOriginalName(name, ext) {
  const base = path.basename(String(name || 'proof')).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 80);
  if (!base || base === '.' || base === '..') return `proof${ext || ''}`;
  if (ext && !base.toLowerCase().endsWith(ext.toLowerCase())) return base + ext;
  return base;
}

function mimeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.pdf') return 'application/pdf';
  if (e === '.txt') return 'text/plain';
  if (e === '.md') return 'text/markdown';
  if (e === '.zip') return 'application/zip';
  if (e === '.json') return 'application/json';
  return 'application/octet-stream';
}

// A task, decorated with a live proofUrl for the client.
function decorate(t) {
  const mime = t.proofMime || (t.proof ? mimeFromExt(path.extname(t.proof)) : null);
  if (!t.proof) return { ...t, proofUrl: null, proofIsImage: false, proofName: t.proofName || null, proofMime: null };
  const bust = encodeURIComponent(t.updated || t.proof);
  return {
    ...t,
    proofUrl: `/api/execute/proof/media?id=${encodeURIComponent(t.id)}&t=${bust}`,
    proofIsImage: isImageMime(mime),
    proofName: t.proofName || t.proof,
    proofMime: mime,
  };
}

function listTasks() {
  const tasks = readAll().filter((t) => t.status !== 'archived');
  // newest first by created
  tasks.sort((a, b) => Date.parse(b.created || 0) - Date.parse(a.created || 0));
  return tasks.map((t) => decorate({ ...t, kind: t.kind || 'task' }));
}

function getTask(id) {
  const safe = path.basename(String(id || ''));
  return readAll().find((t) => t.id === safe) || null;
}

// Snapshot the originating ingest note's title + body text onto the task.
// Prefers caller-passed values; fills gaps from the ingest store so manual
// routes (To Execute / Add to backlog) get context without client changes.
// Never throws — worst case the task just carries no snapshot.
function fillSourceContext({ sourceIngestId, sourceTitle, sourceBody } = {}) {
  let title = String(sourceTitle || '').trim() || null;
  let body = String(sourceBody || '').trim() || null;
  const ingestId = String(sourceIngestId || '').trim();
  if (ingestId && (!title || !body)) {
    try {
      const ingest = require('./ingest-server');
      const rec = ingest.readCapture(ingestId);
      if (rec) {
        if (!title) title = String((rec.meta && rec.meta.title) || '').trim() || ingestId;
        if (!body) body = noteBody(rec.markdown).slice(0, 1500) || null;
      }
    } catch { /* ingest unavailable — leave the snapshot empty */ }
  }
  return { title, body };
}

function createTask({ title, outcome, sourceIngestId, comment, kind, why, intent, action_type, duration_bucket, sourceTitle, sourceBody } = {}) {
  const outcomeText = String(outcome || '').trim();
  const titleText = String(title || outcomeText || '').trim();
  if (!titleText && !outcomeText) {
    const e = new Error('a task needs a title or outcome');
    e.status = 400;
    throw e;
  }
  // Snapshot the original ingest context so the task carries what it came from —
  // not just the rendered action. Callers may pass it directly; otherwise fill it
  // here from the ingest store (covers manual To Execute / Add to backlog posts).
  const src = fillSourceContext({ sourceIngestId, sourceTitle, sourceBody });
  const created = new Date().toISOString();
  const id = `${stamp(new Date(created))}-${Math.random().toString(36).slice(2, 6)}`;
  const comments = [];
  const c = String(comment || '').trim();
  if (c) comments.push({ ts: created, text: c });
  const isSuggestion = kind === 'suggestion';
  const at = String(action_type || '').trim().toLowerCase();
  const db = String(duration_bucket || '').trim();
  const task = {
    id,
    created,
    updated: created,
    status: 'backlog',
    kind: isSuggestion ? 'suggestion' : 'task',
    title: titleText || outcomeText.slice(0, 60),
    outcome: outcomeText,
    why: String(why || '').trim() || null,
    sourceIngestId: sourceIngestId || null,
    sourceTitle: src.title,
    sourceBody: src.body,
    comments,
    startedAt: null,
    elapsedMs: 0,
    proof: null,
    review: null,
    // completion-engine fields
    intent: String(intent || '').trim() || null,
    action_type: ACTION_TYPES.includes(at) ? at : null,
    duration_bucket: DURATION_BUCKETS.includes(db) ? db : null,
    prestaged_ref: null,
    scheduled_block: null,
    state_history: [{ state: 'backlog', at: created }],
    outcome_meta: null,
  };
  const tasks = readAll();
  tasks.push(task);
  writeAll(tasks);
  if (isSuggestion) {
    appendEvent({
      type: 'execute.suggestion.created',
      id: task.id,
      ingestId: task.sourceIngestId,
      title: task.title,
    });
  }
  return decorate(task);
}

function mutate(id, fn) {
  const safe = path.basename(String(id || ''));
  const tasks = readAll();
  const idx = tasks.findIndex((t) => t.id === safe);
  if (idx < 0) { const e = new Error('task not found'); e.status = 404; throw e; }
  const prevStatus = tasks[idx].status;
  const updated = backfill(fn(tasks[idx]));
  const now = new Date().toISOString();
  updated.updated = now;
  // Append-only state_history on EVERY state change; stamp outcome_meta on terminal `done`.
  if (updated.status !== prevStatus) {
    updated.state_history = [...(updated.state_history || []), { state: updated.status, at: now }];
    if (updated.status === 'done') {
      const createdMs = Date.parse(updated.created);
      updated.outcome_meta = {
        completed_at: now,
        time_to_completion_ms: Number.isFinite(createdMs) ? Date.parse(now) - createdMs : null,
      };
    }
  }
  tasks[idx] = updated;
  writeAll(tasks);
  return decorate(updated);
}

// Generic edit: title/outcome edits and appending a comment.
function updateTask(id, { title, outcome, comment } = {}) {
  return mutate(id, (t) => {
    if (typeof title === 'string') t.title = title.trim() || t.title;
    if (typeof outcome === 'string') t.outcome = outcome.trim();
    const c = String(comment || '').trim();
    if (c) t.comments = [...(t.comments || []), { ts: new Date().toISOString(), text: c }];
    return t;
  });
}

function startTask(id) {
  return mutate(id, (t) => {
    if ((t.kind || 'task') === 'suggestion') {
      const e = new Error('promote the suggestion before starting it');
      e.status = 400;
      throw e;
    }
    if (t.status === 'active') return t; // idempotent
    t.status = 'active';
    t.startedAt = new Date().toISOString();
    return t;
  });
}

function promoteTask(id) {
  const task = mutate(id, (t) => {
    if ((t.kind || 'task') !== 'suggestion') {
      const e = new Error('not a suggestion');
      e.status = 400;
      throw e;
    }
    if (t.status === 'archived') {
      const e = new Error('archived suggestion');
      e.status = 400;
      throw e;
    }
    t.kind = 'task';
    t.status = 'backlog';
    return t;
  });
  appendEvent({
    type: 'execute.suggestion.promoted',
    id: task.id,
    ingestId: task.sourceIngestId,
    title: task.title,
  });
  return task;
}

function archiveTask(id) {
  const task = mutate(id, (t) => {
    if ((t.kind || 'task') !== 'suggestion') {
      const e = new Error('not a suggestion');
      e.status = 400;
      throw e;
    }
    t.status = 'archived';
    return t;
  });
  appendEvent({
    type: 'execute.suggestion.archived',
    id: task.id,
    ingestId: task.sourceIngestId,
    title: task.title,
  });
  return task;
}

function unlinkProof(id) {
  const task = getTask(id);
  const proof = findProof(id, task);
  if (proof) { try { fs.unlinkSync(proof); } catch { /* ignore */ } }
}

// One column back: Done → Review, Review → Active (drops the proof), Active → Backlog.
function unstepTask(id) {
  return mutate(id, (t) => {
    if (t.status === 'done') {
      t.status = 'review';
      t.review = {
        question: (t.review && t.review.question) || 'What did completing this unlock, and what is the next move?',
        answer: null,
        answeredAt: null,
      };
      return t;
    }
    if (t.status === 'review') {
      unlinkProof(t.id);
      t.status = 'active';
      t.startedAt = new Date().toISOString();
      t.proof = null;
      t.proofName = null;
      t.proofMime = null;
      t.review = null;
      return t;
    }
    if (t.status === 'active') {
      const started = t.startedAt ? Date.parse(t.startedAt) : NaN;
      if (!Number.isNaN(started)) t.elapsedMs = (t.elapsedMs || 0) + Math.max(0, Date.now() - started);
      t.startedAt = null;
      t.status = 'backlog';
      return t;
    }
    const e = new Error('already in backlog');
    e.status = 400;
    throw e;
  });
}

function deleteTask(id) {
  const safe = path.basename(String(id || ''));
  const tasks = readAll();
  const idx = tasks.findIndex((t) => t.id === safe);
  if (idx < 0) return false;
  tasks.splice(idx, 1);
  writeAll(tasks);
  unlinkProof(safe);
  return true;
}

// Archive every completed run (status === 'done'). Done cards leave the board but stay
// in the store as status 'archived' WITH outcome_meta intact, so the eval drawer can
// keep mining them. Returns { archived }.
function archiveCompleted() {
  const tasks = readAll();
  const now = new Date().toISOString();
  let n = 0;
  for (const t of tasks) {
    if (t.status !== 'done') continue;
    backfill(t);
    t.status = 'archived';
    t.updated = now;
    t.state_history = [...(t.state_history || []), { state: 'archived', at: now }];
    n += 1;
  }
  if (n) {
    writeAll(tasks);
    appendEvent({ type: 'execute.archive_done', meta: { archived: n } });
  }
  return { archived: n };
}

// ---- eval runs: completed trajectories for the Execution eval loop ------------
function reenterCount(t) {
  const hist = Array.isArray(t.state_history) ? t.state_history : [];
  const counts = {};
  let reenters = 0;
  for (const h of hist) {
    const s = h && h.state;
    if (!s) continue;
    counts[s] = (counts[s] || 0) + 1;
    if (counts[s] > 1 && (s === 'backlog' || s === 'active' || s === 'review')) reenters += 1;
  }
  return reenters;
}

// Every finished run: live dones + archived tasks that completed (outcome_meta set).
// Newest completion first. Decorated with proofUrl + eval-relevant rollups so the
// far-right EVALS drawer (and any future judge) has the full trajectory in one call.
function evalRuns({ limit = 50 } = {}) {
  const cap = Math.min(200, Math.max(1, Number(limit) || 50));
  const all = readAll();
  const runs = all.filter((t) => {
    if (t.status === 'done') return (t.kind || 'task') !== 'suggestion';
    if (t.status === 'archived' && t.outcome_meta) return true;
    return false;
  });
  runs.sort((a, b) => {
    const am = Date.parse((a.outcome_meta && a.outcome_meta.completed_at) || a.updated || a.created || 0) || 0;
    const bm = Date.parse((b.outcome_meta && b.outcome_meta.completed_at) || b.updated || b.created || 0) || 0;
    return bm - am;
  });
  const sliced = runs.slice(0, cap).map((t) => {
    const d = decorate(backfill({ ...t }));
    const ans = (d.review && d.review.answer) || '';
    return {
      ...d,
      completedAt: (d.outcome_meta && d.outcome_meta.completed_at) || d.updated || null,
      timeToCompletionMs:
        (d.outcome_meta && d.outcome_meta.time_to_completion_ms) != null
          ? d.outcome_meta.time_to_completion_ms
          : null,
      reenters: reenterCount(d),
      shallow: ans.trim().length > 0 && ans.trim().length < 20,
    };
  });
  const withTTC = sliced.filter((r) => Number.isFinite(r.timeToCompletionMs));
  const summary = {
    total: sliced.length,
    avgTimeToCompletionMs: withTTC.length
      ? Math.round(withTTC.reduce((s, r) => s + r.timeToCompletionMs, 0) / withTTC.length)
      : null,
    shallowCount: sliced.filter((r) => r.shallow).length,
    reenterTotal: sliced.reduce((s, r) => s + (r.reenters || 0), 0),
  };
  return { runs: sliced, summary };
}

// Attach proof: from Active, stops the timer, moves to Review, asks the reflection
// question. From Review, just replaces the file and keeps the existing question.
async function attachProof({ id, buf, mime, filename }, apiKey) {
  ensureDir();
  if (!buf || !buf.length) { const e = new Error('empty proof file'); e.status = 400; throw e; }
  if (buf.length > 12 * 1024 * 1024) {
    const e = new Error('proof file is too large (12 MB max)');
    e.status = 400;
    throw e;
  }
  const safe = path.basename(String(id || ''));
  const task = getTask(safe);
  if (!task) { const e = new Error('task not found'); e.status = 404; throw e; }
  if (task.status !== 'active' && task.status !== 'review') {
    const e = new Error('attach proof from Active or Review');
    e.status = 400;
    throw e;
  }
  const replacing = task.status === 'review';
  const ext = extFromName(filename, mime);
  const origName = safeOriginalName(filename, ext);
  unlinkProof(safe);
  const proofName = `${safe}${ext}`;
  fs.writeFileSync(path.join(EXECUTE_DIR, proofName), buf);

  let question = (replacing && task.review && task.review.question)
    || 'What did completing this unlock, and what is the next move?';
  if (!replacing) {
    try {
      question = await reviewQuestion({ ...task, proofName: origName, proofMime: mime || mimeFromExt(ext) }, apiKey);
    } catch (e) {
      // Non-fatal: fall back to the default prompt if the model call fails.
      console.warn('[execute] review question failed:', e && e.message ? e.message : e);
    }
  }

  return mutate(safe, (t) => {
    if (!replacing) {
      const started = t.startedAt ? Date.parse(t.startedAt) : NaN;
      if (!Number.isNaN(started)) t.elapsedMs = (t.elapsedMs || 0) + Math.max(0, Date.now() - started);
      t.startedAt = null;
      t.review = { question, answer: null, answeredAt: null };
    }
    t.proof = proofName;
    t.proofName = origName;
    t.proofMime = mime || mimeFromExt(ext);
    t.status = 'review';
    return t;
  });
}

// Save the review answer -> Done. Returns the task; the loop-back into ingest is the
// caller's job (server.js), so this module stays free of an ingest dependency.
function saveReview(id, answer) {
  const ans = String(answer || '').trim();
  if (!ans) { const e = new Error('an answer is required'); e.status = 400; throw e; }
  return mutate(id, (t) => {
    t.review = { ...(t.review || { question: '' }), answer: ans, answeredAt: new Date().toISOString() };
    t.status = 'done';
    return t;
  });
}

function readProof(id) {
  ensureDir();
  const task = getTask(id);
  const file = findProof(id, task);
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  const mime = (task && task.proofMime) || mimeFromExt(ext);
  return {
    path: file,
    mime,
    name: (task && task.proofName) || path.basename(file),
    buffer: fs.readFileSync(file),
  };
}

// ---- review: task -> ONE reflection question ------------------------------
const REVIEW_PROMPT = `A person just completed a tangible outcome and attached proof.
Ask ONE short reflection question (<=25 words) that helps them realize the value of what they
did and see what needs to happen next — how to improve or what it unlocked. Be direct, specific
to the outcome, no preamble.

Return STRICT JSON only: { "question": "..." }`;

async function reviewQuestion(task, apiKey) {
  if (!apiKey) return 'What did completing this unlock, and what is the next move?';
  const comments = (task.comments || []).map((c) => `- ${c.text}`).join('\n');
  const attached = task.proofName ? `Attached: ${task.proofName}\n` : '';
  const userText =
    `Outcome: ${task.outcome || task.title}\n` +
    attached +
    (comments ? `Notes while working:\n${comments}\n` : '');
  const t0 = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  let res, json;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'HudHub Execute',
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        usage: { include: true },
        messages: [
          { role: 'system', content: REVIEW_PROMPT },
          { role: 'user', content: userText },
        ],
      }),
    });
    json = await res.json();
  } finally {
    clearTimeout(t);
  }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    agentUsage.record({ surface: 'execute', model: REVIEW_MODEL, latencyMs, ok: false, label: 'review' });
    const msg = json?.error?.message || json?.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  const usage = json?.usage || {};
  let parsed = {};
  try { parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}'); } catch (e) { parsed = {}; }
  agentUsage.record({
    surface: 'execute', model: json?.model || REVIEW_MODEL, latencyMs, usage,
    cost: usage.cost ?? null, ok: true, label: 'review',
    input: userText,
    output: parsed.question || '',
  });
  return parsed.question || 'What did completing this unlock, and what is the next move?';
}

// ---- scan: recent ingest notes -> backlog suggestions --------------------
const SCAN_PROMPT = `You read recently captured notes and decide which ones need a to-do.
Propose ZERO or ONE tangible outcome per note. Skip notes that are journal-only, already done,
vague vibes, or have no doable next move. Do not invent facts beyond the note. Prefer the
smallest real move that creates momentum. Do not duplicate existing backlog titles.

Return STRICT JSON only, no prose:
{
  "suggestions": [
    {
      "ingestId": "the note id from the input",
      "title": "short task title (<=8 words)",
      "intent": "the bare intent behind the note, pre-render (<=12 words)",
      "outcome": "the one tangible outcome, phrased as a doable action (<=20 words)",
      "action_type": "one of: draft | reply | transact | schedule | errand | other",
      "duration_bucket": "one of: <2min | <15min | >15min",
      "why": "one short sentence on why this is the right next move"
    }
  ]
}
action_type guide: draft = produce a new artifact (doc/message/post); reply = respond to
someone; transact = buy/pay/sign up via a service; schedule = book time; errand = a physical
real-world chore; other = none of these.
duration_bucket guide: estimate HONESTLY how long the outcome takes to DO (not how it feels).
<2min = a quick one-liner/send/click; <15min = a short focused sitting; >15min = real work.
If nothing needs a todo, return { "suggestions": [] }.`;

function noteBody(markdown) {
  const text = String(markdown || '');
  const parts = text.split(/^---\s*$/m);
  const body = parts.length >= 3 ? parts.slice(2).join('---') : text;
  return body.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

// Read a note's body for the model, from the ingest record (fallback to preview).
function noteForRender(n, ingest) {
  const rec = ingest.readCapture(n.id);
  const body = rec ? noteBody(rec.markdown) : (n.preview || '');
  return { ingestId: n.id, title: n.title, created: n.created, source: n.source, body };
}

// The set of ingest ids we must NOT (re)render: already claimed by a task/suggestion,
// plus notes the render step already judged non-actionable. Used by BOTH the per-capture
// render path and the batch backstop so nothing is proposed twice or re-billed forever.
function claimedIngestIds() {
  const claimed = new Set(readAll().map((t) => t.sourceIngestId).filter(Boolean));
  for (const id of readSkipSet()) claimed.add(id);
  return claimed;
}

// Existing titles/outcomes to hand the model as "do not duplicate" context.
function existingSummaries() {
  return readAll()
    .filter((t) => t.status !== 'archived')
    .map((t) => `- ${t.title}${t.outcome ? ` — ${t.outcome}` : ''}`)
    .slice(0, 40);
}

function buildScanUserText(notes, existing, headerLabel) {
  return (
    (existing.length
      ? `Existing backlog / active / review / done (do not duplicate):\n${existing.join('\n')}\n\n`
      : '') +
    `${headerLabel}:\n` +
    notes
      .map((n) => `---\ningestId: ${n.ingestId}\ntitle: ${n.title}\nsource: ${n.source || ''}\n${n.body || '(empty)'}`)
      .join('\n')
  );
}

// Shared model call for both scan (batch) and render (single note). Uses SCAN_PROMPT.
// Returns the parsed JSON ({ suggestions: [...] }); throws on HTTP error.
async function callScanModel(userText, apiKey, { label = 'scan', timeoutMs = 60000 } = {}) {
  if (!apiKey) {
    const e = new Error('OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).');
    e.status = 500;
    throw e;
  }
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res, json;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'HudHub Execute',
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        usage: { include: true },
        messages: [
          { role: 'system', content: SCAN_PROMPT },
          { role: 'user', content: userText },
        ],
      }),
    });
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    agentUsage.record({ surface: 'execute', model: REVIEW_MODEL, latencyMs, ok: false, label });
    const msg = json?.error?.message || json?.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  let parsed = {};
  try { parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
  const usage = json?.usage || {};
  agentUsage.record({
    surface: 'execute', model: json?.model || REVIEW_MODEL, latencyMs, usage,
    cost: usage.cost ?? null, ok: true, label,
    input: userText.slice(0, 4000),
    output: json?.choices?.[0]?.message?.content || '',
  });
  return parsed;
}

// Turn parsed model suggestions into persisted suggestion tasks. Enforces P1 (never a bare
// suggestion), the dedup contract (allowed ids only, no double-claim), and sets action_type
// AND duration_bucket at render time (createTask validates both against the enums).
function materializeSuggestions(parsed, notes, claimed) {
  const allowed = new Set(notes.map((n) => n.ingestId));
  const byId = new Map(notes.map((n) => [n.ingestId, n]));
  const raw = Array.isArray(parsed && parsed.suggestions) ? parsed.suggestions : [];
  const seen = new Set();
  const freshClaimed = new Set(claimed);
  const created = [];
  for (const s of raw) {
    const ingestId = String((s && s.ingestId) || '').trim();
    if (!ingestId || !allowed.has(ingestId) || seen.has(ingestId) || freshClaimed.has(ingestId)) continue;
    const outcome = String(s.outcome || '').trim();
    const title = String(s.title || outcome || '').trim();
    if (!title && !outcome) continue; // P1: never persist an empty/bare suggestion
    seen.add(ingestId);
    freshClaimed.add(ingestId);
    const note = byId.get(ingestId) || {};
    created.push(createTask({
      title: title || outcome.slice(0, 60),
      intent: String(s.intent || '').trim(),
      outcome,
      action_type: s.action_type,          // createTask sanitizes against ACTION_TYPES
      duration_bucket: s.duration_bucket,   // render is the source of truth for the bucket
      why: String(s.why || '').trim(),
      sourceIngestId: ingestId,
      sourceTitle: note.title,             // snapshot the original so context survives
      sourceBody: note.body,
      kind: 'suggestion',
    }));
  }
  return created;
}

async function scanIngest(apiKey, { sinceHours = SCAN_HOURS, limit = SCAN_NOTE_CAP } = {}) {
  const hours = Number(sinceHours) > 0 ? Number(sinceHours) : SCAN_HOURS;
  const cap = Math.min(60, Math.max(1, Number(limit) || SCAN_NOTE_CAP));
  const ingest = require('./ingest-server');
  appendEvent({ type: 'execute.scan.started', meta: { hours, cap } });

  const cutoff = Date.now() - hours * 3600 * 1000;
  const listed = ingest.listCaptures(120);
  const recent = listed.filter((n) => {
    const ts = n.created ? Date.parse(n.created) : NaN;
    return Number.isFinite(ts) && ts >= cutoff;
  });
  const claimed = claimedIngestIds();
  const skipped = recent.filter((n) => claimed.has(n.id)).length;
  const candidates = recent.filter((n) => !claimed.has(n.id)).slice(0, cap);

  if (!candidates.length) {
    appendEvent({
      type: 'execute.scan.completed',
      meta: { added: 0, skipped, scanned: 0, hours },
    });
    return { added: 0, skipped, scanned: 0, suggestions: [] };
  }

  const notes = candidates.map((n) => noteForRender(n, ingest));
  const userText = buildScanUserText(notes, existingSummaries(), `Notes (last ${hours}h)`);
  const parsed = await callScanModel(userText, apiKey, { label: 'scan', timeoutMs: 60000 });
  const suggestions = materializeSuggestions(parsed, notes, claimed);

  appendEvent({
    type: 'execute.scan.completed',
    meta: { added: suggestions.length, skipped, scanned: notes.length, hours },
  });
  return { added: suggestions.length, skipped, scanned: notes.length, suggestions };
}

// ---- render ONE ingest note -> ONE suggestion (Epic 1: auto-render on capture) ----
// Fire-and-forget from the capture route. Reuses the scan render path (SCAN_PROMPT) on a
// single note. Never throws for the caller's benefit at the route, but IS async — the caller
// must not await it (that is how capture stays instant). Contract:
//  - Dedup: skip notes already claimed by a task/suggestion, or already marked non-actionable.
//  - P1: if the model returns a real outcome, persist ONE suggestion (with action_type +
//    duration_bucket set here). If it returns nothing (pure journal/vibes), mark the note
//    skipped so it is NOT reprocessed on every capture — and never create a bare suggestion.
//  - Model/network FAILURE marks nothing skipped, so the batch "Scan ingest" backstop retries.
async function renderNoteToSuggestion(ingestId, apiKey) {
  const id = String(ingestId || '').trim();
  if (!id) return { rendered: false, reason: 'no-id' };
  // No key → don't mark skipped; leave it for the batch backstop once a key exists.
  if (!apiKey) return { rendered: false, reason: 'no-key' };

  const claimed = claimedIngestIds();
  if (claimed.has(id)) return { rendered: false, reason: 'already-claimed' };

  const ingest = require('./ingest-server');
  const rec = ingest.readCapture(id);
  if (!rec) return { rendered: false, reason: 'not-found' };

  const note = {
    ingestId: id,
    title: (rec.meta && rec.meta.title) || id,
    created: (rec.meta && rec.meta.created) || null,
    source: (rec.meta && rec.meta.source) || '',
    body: noteBody(rec.markdown),
  };
  appendEvent({ type: 'execute.render.started', ingestId: id });

  const userText = buildScanUserText([note], existingSummaries(), 'Note');
  const parsed = await callScanModel(userText, apiKey, { label: 'render', timeoutMs: 30000 });

  // Re-read claimed just before persisting so a concurrent scan can't double-create.
  const built = materializeSuggestions(parsed, [note], claimedIngestIds());
  if (built.length) {
    appendEvent({ type: 'execute.render.completed', ingestId: id, id: built[0].id, title: built[0].title });
    return { rendered: true, suggestion: built[0] };
  }

  // P1: genuinely non-actionable — record so we never re-render/re-bill this note.
  markSkipped(id);
  appendEvent({ type: 'execute.render.skipped', ingestId: id, meta: { nonActionable: true } });
  return { rendered: false, reason: 'non-actionable' };
}

module.exports = {
  EXECUTE_DIR,
  REVIEW_MODEL,
  ensureDir,
  listTasks,
  getTask,
  createTask,
  updateTask,
  startTask,
  promoteTask,
  archiveTask,
  archiveCompleted,
  evalRuns,
  scanIngest,
  renderNoteToSuggestion,
  unstepTask,
  attachProof,
  saveReview,
  deleteTask,
  readProof,
  ACTION_TYPES,
  DURATION_BUCKETS,
};
