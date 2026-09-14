// execute-plan.js — decomposition + day-scheduling engine behind EXECUTE,
// plus its prompt lab (mirrors live-prompt.js: get/deploy/test/refine/revert).
//
// The lab prompt of record lives in execute-plan-prompt.json (gitignored —
// personal tuning, like writing-voice). Every decompose/schedule call is logged
// to execute-plan-runs.json: the eval trajectory for the planning loop.
'use strict';

const fs = require('fs');
const path = require('path');
const agentUsage = require('./agent-usage');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLAN_MODEL =
  process.env.OPENROUTER_CAPTURE_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const REFINE_MODEL = process.env.PLAN_REFINE_MODEL || 'anthropic/claude-opus-4.8';
const PROMPT_FILE = path.join(__dirname, 'execute-plan-prompt.json');
const RUNS_FILE = path.join(__dirname, 'execute-plan-runs.json');
const VERSION_CAP = 30;
const RUN_CAP = 50;

const DEFAULT_DECOMPOSE_PROMPT = `You break one task or brain-dump into small executable pieces for Savar's Execute board.

First, in one or two sentences, say what you think is happening (your read of the task).
Then, ONLY if something is genuinely ambiguous and blocks good decomposition, ask up to 3 clarifying questions — each with 2-4 concrete options to pick from.
Then propose 2-7 subtasks. Each must be completable in one sitting with a provable end state. Do not invent facts beyond the input. Prefer the smallest real move that creates momentum. Order them in the sequence Savar should do them.

Sizing guide (be honest about DOING time, not how it feels):
<2min = a quick send/click/one-liner; <15min = a short focused sitting; >15min = real work.

Return STRICT JSON only, no prose:
{
  "summary": "your 1-2 sentence read of what is happening",
  "questions": [{ "question": "...", "options": ["...", "..."] }],
  "suggestions": [
    { "title": "<=8 words", "outcome": "doable end state (<=20 words)",
      "duration_bucket": "<2min | <15min | >15min",
      "action_type": "draft | reply | transact | schedule | errand | other",
      "why": "one short sentence: why this piece, why in this position" }
  ]
}
If the input is already atomic, return it as a single suggestion with no questions.`;

const SCHEDULE_SYSTEM = `You order today's backlog into hour blocks. You get tasks with size buckets: <2min (~5 min), <15min (~15 min), >15min (~45 min). Schedule hardest/longest first, keep replies and quick sends as palate cleansers between deep blocks, and leave a 15-min buffer after every >15min block.

Hard constraints — never violate these:
- The current time is given. Every block must start AT OR AFTER the current time and end BY 23:00.
- Busy ranges are given. No block may overlap a busy range.
- If everything does not fit in the remaining day, schedule what fits in priority order and OMIT the rest (do not emit them at all — the caller marks omitted tasks unscheduled).
- Start the first block at the given day-start time or later.

Return STRICT JSON only, no prose:
{ "blocks": [{ "taskId": "...", "start": "HH:MM", "end": "HH:MM", "reason": "<=12 words" }] }
Include each scheduled taskId exactly once, in 24h HH:MM.`;

const REFINE_SYSTEM = `You edit the system prompt behind Savar's Execute planning engine (it decomposes tasks into sized subtasks and proposes day schedules).

Rules for the rewrite:
- Make the SMALLEST targeted edit that addresses the feedback. Preserve everything that already works.
- Keep the JSON contract intact: the prompt must still demand STRICT JSON with summary/questions/suggestions and the exact field names and enums.
- Keep the sizing guide unless the feedback asks to change it.
- Do not add greetings, examples of full conversations, or meta-commentary about prompts.
- Return ONLY the full revised system prompt. No quotes, no preamble, no explanation.`;

const BUCKET_MINUTES = { '<2min': 5, '<15min': 15, '>15min': 45 };

// ---- prompt store -------------------------------------------------------
function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROMPT_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch { /* first run */ }
  return { prompt: DEFAULT_DECOMPOSE_PROMPT, versions: [] };
}

function writeStore(store) {
  fs.writeFileSync(PROMPT_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function activePrompt() {
  return readStore().prompt || DEFAULT_DECOMPOSE_PROMPT;
}

function getLab() {
  const store = readStore();
  return {
    prompt: store.prompt || DEFAULT_DECOMPOSE_PROMPT,
    defaultPrompt: DEFAULT_DECOMPOSE_PROMPT,
    isDefault: !store.prompt || store.prompt === DEFAULT_DECOMPOSE_PROMPT,
    versions: (store.versions || []).map((v) => ({
      id: v.id, ts: v.ts, note: v.note || '', chars: (v.prompt || '').length,
    })),
    hasKey: Boolean(process.env.OPENROUTER_API_KEY),
  };
}

function deployPrompt(prompt, note) {
  const text = String(prompt || '').trim();
  if (!text) throw Object.assign(new Error('empty prompt'), { status: 400 });
  if (text.length > 20000) throw Object.assign(new Error('prompt too long (20k max)'), { status: 400 });
  const store = readStore();
  const versions = store.versions || [];
  versions.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(), note: String(note || '').slice(0, 200), prompt: text,
  });
  store.prompt = text;
  store.versions = versions.slice(0, VERSION_CAP);
  writeStore(store);
  return getLab();
}

function revertVersion(id) {
  const store = readStore();
  const v = (store.versions || []).find((x) => x.id === String(id));
  if (!v) throw Object.assign(new Error('version not found'), { status: 404 });
  return deployPrompt(v.prompt, 'revert to ' + String(id));
}

// ---- runs log (planning eval trajectories) -------------------------------
function readRuns() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function logRun(entry) {
  try {
    const runs = readRuns();
    runs.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), ...entry });
    fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(0, RUN_CAP), null, 2), 'utf8');
  } catch { /* logging never breaks the turn */ }
}

function listRuns(limit) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  return readRuns().slice(0, n);
}

// ---- model call ----------------------------------------------------------
async function callModel({ system, user, apiKey, label, model, temperature }) {
  if (!apiKey) {
    const e = new Error('OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).');
    e.status = 500;
    throw e;
  }
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  let res, json;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'HudHub Execute Plan',
      },
      body: JSON.stringify({
        model: model || PLAN_MODEL,
        temperature: temperature == null ? 0.4 : temperature,
        response_format: { type: 'json_object' },
        usage: { include: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    agentUsage.record({ surface: 'execute-plan', model: model || PLAN_MODEL, latencyMs, ok: false, label });
    const msg = json?.error?.message || json?.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  let parsed = {};
  const content = json?.choices?.[0]?.message?.content || '{}';
  try { parsed = JSON.parse(content); } catch { parsed = {}; }
  agentUsage.record({
    surface: 'execute-plan', model: json?.model || model || PLAN_MODEL, latencyMs,
    usage: json?.usage || {}, cost: json?.usage?.cost ?? null, ok: true, label,
    input: String(user).slice(0, 4000), output: content,
  });
  return parsed;
}

function cleanSuggestions(raw) {
  const out = [];
  const buckets = ['<2min', '<15min', '>15min'];
  const actions = ['draft', 'reply', 'transact', 'schedule', 'errand', 'other'];
  for (const s of (Array.isArray(raw) ? raw : []).slice(0, 10)) {
    if (!s || typeof s !== 'object') continue;
    const title = String(s.title || s.outcome || '').trim();
    const outcome = String(s.outcome || '').trim();
    if (!title && !outcome) continue;
    const db = String(s.duration_bucket || '').trim();
    const at = String(s.action_type || '').trim().toLowerCase();
    out.push({
      title: (title || outcome).slice(0, 80),
      outcome: (outcome || title).slice(0, 140),
      duration_bucket: buckets.includes(db) ? db : null,
      action_type: actions.includes(at) ? at : null,
      why: String(s.why || '').trim().slice(0, 200),
    });
  }
  return out;
}

// ---- decompose: one task/capture -> summary + questions + suggestions -----
// Pure: proposes, never persists. Caller promotes chosen pieces via createTask.
async function decompose({ title, outcome, sourceBody, why, prompt } = {}, apiKey) {
  const input = [
    title ? `Task: ${title}` : null,
    outcome ? `Outcome: ${outcome}` : null,
    why ? `Why: ${why}` : null,
    sourceBody ? `Original note:\n${String(sourceBody).slice(0, 2000)}` : null,
  ].filter(Boolean).join('\n\n') || '(empty)';
  const system = String(prompt || '').trim() || activePrompt();
  const parsed = await callModel({ system, user: input, apiKey, label: 'decompose' });
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .filter((q) => q && (q.question || q.q))
    .slice(0, 3)
    .map((q) => ({
      question: String(q.question || q.q || '').slice(0, 300),
      options: (Array.isArray(q.options) ? q.options : []).map((o) => String(o).slice(0, 120)).slice(0, 4),
    }));
  const result = {
    summary: String(parsed.summary || '').slice(0, 600),
    questions,
    suggestions: cleanSuggestions(parsed.suggestions),
  };
  logRun({ kind: 'decompose', input: input.slice(0, 1500), output: result });
  return result;
}

// ---- schedule: backlog tasks -> ordered hour blocks for a day ------------
// currentTime ('HH:MM') is the earliest anything may start; blocks before it
// are dropped so a mid-afternoon suggest never books the morning again.
// busy ([{start, end, label}]) marks occupied ranges (meals, breaks, already
// scheduled work) — proposals overlapping them are dropped.
async function suggestSchedule({ tasks, date, startHour, currentTime, busy } = {}, apiKey) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.id);
  if (!list.length) return { date: date || null, blocks: [] };
  const lines = list.map((t) =>
    `- id: ${t.id} | ${t.title || '(untitled)'}${t.outcome ? ` — ${t.outcome}` : ''} [${t.duration_bucket || '?'}]`
    + ` (~${BUCKET_MINUTES[t.duration_bucket] || 20} min)`);
  const now = /^\d{2}:\d{2}$/.test(String(currentTime || '')) ? currentTime : null;
  const busyList = (Array.isArray(busy) ? busy : []).filter((b) =>
    /^\d{2}:\d{2}$/.test(String((b && b.start) || '')) && /^\d{2}:\d{2}$/.test(String((b && b.end) || '')));
  const user = `Date: ${date || 'today'}. Day starts at ${startHour || '09:00'}.`
    + (now ? `\nCurrent time: ${now} — nothing may start before now, everything ends by 23:00. Fit what fits; omit the rest.` : '')
    + (busyList.length ? `\nBusy — do NOT overlap these:\n${busyList.map((b) => `- ${b.start}–${b.end}${b.label ? ` (${b.label})` : ''}`).join('\n')}` : '')
    + `\n\nTasks:\n${lines.join('\n')}`;
  const parsed = await callModel({
    system: SCHEDULE_SYSTEM, user, apiKey, label: 'schedule', temperature: 0.3,
  });
  const overlaps = (s, e) => busyList.some((b) => String(s) < String(b.end) && String(b.start) < String(e));
  const byId = new Map(list.map((t) => [String(t.id), t]));
  const seen = new Set();
  const blocks = [];
  for (const b of (Array.isArray(parsed.blocks) ? parsed.blocks : [])) {
    const id = String((b && b.taskId) || '');
    if (!id || !byId.has(id) || seen.has(id)) continue;
    if (!/^\d{2}:\d{2}$/.test(String(b.start || '')) || !/^\d{2}:\d{2}$/.test(String(b.end || ''))) continue;
    if (now && String(b.start) < now) continue; // guardrail: never book the past
    if (String(b.end) > '23:00') continue;
    if (overlaps(b.start, b.end)) continue; // guardrail: never double-book
    seen.add(id);
    blocks.push({
      taskId: id,
      start: b.start, end: b.end,
      reason: String(b.reason || '').slice(0, 120),
    });
  }
  // Any task the model dropped still needs a home: append in board order.
  for (const t of list) {
    if (!seen.has(String(t.id))) {
      blocks.push({ taskId: String(t.id), start: null, end: null, reason: 'unscheduled — place me' });
    }
  }
  const result = { date: date || null, blocks };
  logRun({ kind: 'schedule', input: user.slice(0, 1500), output: result });
  return result;
}

// ---- lab refine: feedback -> revised prompt -------------------------------
async function refinePrompt({ prompt, testInput, testResponse, feedback } = {}, apiKey) {
  const current = String(prompt || '').trim() || activePrompt();
  const user = [
    `CURRENT PROMPT:\n${current}`,
    testInput ? `TEST INPUT:\n${String(testInput).slice(0, 2000)}` : null,
    testResponse ? `ITS OUTPUT:\n${String(testResponse).slice(0, 3000)}` : null,
    `FEEDBACK:\n${String(feedback || '').trim()}`,
  ].filter(Boolean).join('\n\n');
  if (!String(feedback || '').trim()) throw Object.assign(new Error('feedback required'), { status: 400 });
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4777',
      'X-Title': 'HudHub Execute Plan Lab',
    },
    body: JSON.stringify({
      model: REFINE_MODEL,
      temperature: 0.3,
      usage: { include: true },
      messages: [
        { role: 'system', content: REFINE_SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  agentUsage.record({
    surface: 'execute-plan', model: json?.model || REFINE_MODEL, latencyMs: 0,
    usage: json?.usage || {}, cost: json?.usage?.cost ?? null, ok: true, label: 'lab-refine',
    input: user.slice(0, 4000), output: json?.choices?.[0]?.message?.content || '',
  });
  return { prompt: String(json?.choices?.[0]?.message?.content || '').trim() };
}

module.exports = {
  PLAN_MODEL,
  DEFAULT_DECOMPOSE_PROMPT,
  BUCKET_MINUTES,
  getLab,
  deployPrompt,
  revertVersion,
  listRuns,
  decompose,
  suggestSchedule,
  refinePrompt,
};
