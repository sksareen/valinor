// Live companion: short streamed OpenRouter replies + durable session on disk.
// Zero npm deps — Node 22 global fetch. Required by server.js.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const agentUsage = require('./agent-usage');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash';
// Prefer lite for tick router; OPENROUTER_VISION_MODEL overrides when set.
const ROUTER_MODEL = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash-lite';
const HISTORY_FOR_MODEL = 20;
const HISTORY_FOR_CLIENT = 40;

const SYSTEM = `You ARE on a live video call with Savar (that is his name — never call him "that person", "the user", or "the guy"; address him as Savar or you). You can see the latest camera frame with each turn — react to what you see AND hear in 1–3 short conversational sentences. Never say you can't see them. You also get a hub digest of his Valinor workspace — use it when relevant; don't recite it. No lists, no markdown, no preamble — just talk.`;

const ROUTER_SYSTEM = `You watch a live webcam tick of Savar (his name is Savar — never "that person"). You also get a short hub digest.

Default to SKIP. Silence is correct. Only speak when something is clearly worth interrupting him for — a real change, a concrete observation that helps him right now, or something in the hub digest that matters in this moment.

SKIP for: still/unchanged scenes, vague vibes, filler ("looking focused", "still coding"), repeating yourself, narrating the obvious, or anything you are not sure about.

If you speak: exactly 1 short spoken sentence — no quotes, no lists, no SKIP elsewhere. Address him as Savar or you.`;

const DIGEST_MAX = 800;

/** Normalize optional image (data URL or raw base64) to a jpeg data URL, or null. */
function toImageDataUrl(image) {
  if (!image || typeof image !== 'string') return null;
  const s = image.trim();
  if (!s) return null;
  if (/^data:image\//i.test(s)) return s;
  return 'data:image/jpeg;base64,' + s.replace(/^data:[^;]+;base64,/i, '');
}

// Prefer project dir; fall back when sandboxed (EPERM) to ~/.handviz then tmp.
const SESSION_CANDIDATES = [
  process.env.LIVE_SESSION_PATH,
  path.join(__dirname, 'live-session.jsonl'),
  path.join(os.homedir(), '.handviz', 'live-session.jsonl'),
  path.join(os.tmpdir(), 'handviz-live-session.jsonl'),
].filter(Boolean);

let sessionPath = SESSION_CANDIDATES[0];
let persistOk = true;
let persistWarned = false;
const memory = []; // source of truth for this process

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
}

function tryWrite(filePath, line) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, line, 'utf8');
}

function pickWritablePath() {
  for (const p of SESSION_CANDIDATES) {
    try {
      ensureDir(p);
      fs.appendFileSync(p, '', 'utf8');
      return p;
    } catch { /* try next */ }
  }
  return null;
}

function loadFromDisk() {
  for (const p of SESSION_CANDIDATES) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      sessionPath = p;
      const rows = text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      if (rows.length) {
        memory.length = 0;
        memory.push(...rows);
      }
      return;
    } catch { /* try next */ }
  }
}

loadFromDisk();
if (!sessionPath || !fs.existsSync(sessionPath)) {
  const picked = pickWritablePath();
  if (picked) sessionPath = picked;
  else { persistOk = false; sessionPath = SESSION_CANDIDATES[0]; }
}

function appendLine(entry) {
  memory.push(entry);
  if (memory.length > HISTORY_FOR_CLIENT * 4) {
    memory.splice(0, memory.length - HISTORY_FOR_CLIENT * 2);
  }
  if (!persistOk) return;
  const line = JSON.stringify(entry) + '\n';
  try {
    tryWrite(sessionPath, line);
  } catch (e) {
    const picked = pickWritablePath();
    if (picked && picked !== sessionPath) {
      sessionPath = picked;
      try {
        // rewrite recent history to the new location
        fs.writeFileSync(sessionPath, memory.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
        return;
      } catch { /* fall through */ }
    }
    persistOk = false;
    if (!persistWarned) {
      persistWarned = true;
      console.warn('[live] session persist disabled:', String(e.message || e), '— keeping in-memory only');
    }
  }
}

function getHistory() {
  return memory.slice(-HISTORY_FOR_CLIENT);
}

function clearSession() {
  memory.length = 0;
  for (const p of SESSION_CANDIDATES) {
    try { fs.unlinkSync(p); } catch { /* none */ }
  }
  persistOk = true;
  persistWarned = false;
  const picked = pickWritablePath();
  if (picked) sessionPath = picked;
  else persistOk = false;
}

function sse(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
}

function quickNoteCount() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'notes.json'), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.length : null;
  } catch {
    return null;
  }
}

function noteSnippet(n) {
  const title = String(n.title || '').trim();
  const text = String(n.text || n.body || '').trim().replace(/\s+/g, ' ');
  if (title && text) return (title + ' — ' + text).slice(0, 90);
  return (title || text || n.kind || 'note').slice(0, 90);
}

/** Compact hub digest (~400–800 chars). Fail soft on missing files. */
function buildHubDigest({ activeTab } = {}) {
  const parts = [];
  const tab = String(activeTab || '').replace(/^#/, '').trim();
  if (tab) parts.push('Tab: ' + tab);

  try {
    const raw = fs.readFileSync(path.join(__dirname, 'notes.json'), 'utf8');
    const notes = JSON.parse(raw);
    if (Array.isArray(notes)) {
      parts.push('Board: ' + notes.length + ' notes');
      const lines = notes.slice(0, 8).map((n, i) => '  ' + (i + 1) + '. ' + noteSnippet(n));
      if (lines.length) parts.push(lines.join('\n'));
    }
  } catch { /* omit */ }

  try {
    const dir = path.join(__dirname, 'letters');
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && /\.(md|txt|html)$/i.test(f));
    parts.push('Letters: ' + files.length);
    const names = files.slice(0, 5).map((f) => f.replace(/\.[^.]+$/, ''));
    if (names.length) parts.push('  ' + names.join(', '));
  } catch { /* omit */ }

  try {
    const { getRecentTraceSummary } = require('./agent-server');
    const traces = getRecentTraceSummary(5);
    if (traces && traces.length) {
      parts.push('Agent:');
      for (const t of traces) parts.push('  ' + t);
    }
  } catch { /* omit */ }

  let out = parts.join('\n').trim();
  if (!out) out = 'Tab: ' + (tab || 'unknown');
  if (out.length > DIGEST_MAX) out = out.slice(0, DIGEST_MAX - 1) + '…';
  return out;
}

/** @deprecated alias — tick path used the short name */
function hubDigest(activeTab) {
  return buildHubDigest({ activeTab });
}

function openRouterHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:4777',
    'X-Title': 'handviz-live',
  };
}

async function parseUpstreamError(upstream) {
  const errText = await upstream.text().catch(() => '');
  let msg = errText.slice(0, 400);
  try {
    const j = JSON.parse(errText);
    msg = j.error?.message || j.error || msg;
  } catch { /* keep */ }
  if (upstream.status === 401) {
    msg = 'OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in .env.';
  }
  return String(msg);
}

/** Fast non-streaming tick router: SKIP or one spoken sentence. */
async function runTickRouter(res, { image, activeTab }, apiKey) {
  const imageUrl = toImageDataUrl(image);
  // No frame → nothing to react to; skip without a model call.
  if (!imageUrl) {
    sse(res, { type: 'skip' });
    sse(res, { type: 'done', text: '', skipped: true });
    return;
  }
  const digest = buildHubDigest({ activeTab });
  const userContent = [
    { type: 'text', text: 'Hub context (may be stale by seconds):\n' + digest },
    { type: 'image_url', image_url: { url: imageUrl } },
  ];

  let upstream;
  const t0 = Date.now();
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify({
        model: ROUTER_MODEL,
        messages: [
          { role: 'system', content: ROUTER_SYSTEM },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 60,
        stream: false,
      }),
    });
  } catch (e) {
    agentUsage.record({ surface: 'live', model: ROUTER_MODEL, latencyMs: Date.now() - t0, ok: false, label: 'router' });
    sse(res, { type: 'error', message: String(e.message || e) });
    return;
  }

  if (!upstream.ok) {
    agentUsage.record({ surface: 'live', model: ROUTER_MODEL, latencyMs: Date.now() - t0, ok: false, label: 'router' });
    sse(res, { type: 'error', message: await parseUpstreamError(upstream) });
    return;
  }

  let json;
  try {
    json = await upstream.json();
  } catch (e) {
    agentUsage.record({ surface: 'live', model: ROUTER_MODEL, latencyMs: Date.now() - t0, ok: false, label: 'router' });
    sse(res, { type: 'error', message: 'router parse failed: ' + String(e.message || e) });
    return;
  }

  const usage = json.usage || {};
  agentUsage.record({
    surface: 'live',
    model: json.model || ROUTER_MODEL,
    latencyMs: Date.now() - t0,
    usage,
    cost: usage.cost ?? null,
    ok: true,
    label: 'router',
  });

  const raw = String(json.choices?.[0]?.message?.content || '').trim();
  const upper = raw.toUpperCase();
  const isSkip = !raw || upper === 'SKIP' || /^SKIP[.!]?\s*$/i.test(raw);

  if (isSkip) {
    sse(res, { type: 'skip' });
    sse(res, { type: 'done', text: '', skipped: true });
    return;
  }

  // Speak path: single-shot reply (already have the sentence from the router).
  const reply = raw.replace(/^["']|["']$/g, '').trim();
  if (!reply || /^SKIP\b/i.test(reply)) {
    sse(res, { type: 'skip' });
    sse(res, { type: 'done', text: '', skipped: true });
    return;
  }

  appendLine({ t: Date.now(), role: 'assistant', text: reply });
  sse(res, { type: 'token', text: reply });
  sse(res, { type: 'done', text: reply, persist: persistOk ? sessionPath : null });
}

async function runSpokenTurn(res, { text, image, activeTab }, apiKey) {
  const userText = String(text || '').trim();
  const imageUrl = toImageDataUrl(image);
  const userMsg = { t: Date.now(), role: 'user', text: userText };
  appendLine(userMsg);

  // History is text-only; current turn may be multimodal when a frame is attached.
  const prior = memory.slice(0, -1).slice(-HISTORY_FOR_MODEL);
  const digest = buildHubDigest({ activeTab });
  const userContent = imageUrl
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: imageUrl } },
      ]
    : userText;
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: 'Hub context (may be stale by seconds):\n' + digest },
    ...prior.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: userContent },
  ];
  const model = imageUrl ? VISION_MODEL : DEFAULT_MODEL;

  let upstream;
  const t0 = Date.now();
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.8,
        max_tokens: 180,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (e) {
    agentUsage.record({ surface: 'live', model, latencyMs: Date.now() - t0, ok: false, label: 'speak' });
    sse(res, { type: 'error', message: String(e.message || e) });
    return;
  }

  if (!upstream.ok) {
    agentUsage.record({ surface: 'live', model, latencyMs: Date.now() - t0, ok: false, label: 'speak' });
    sse(res, { type: 'error', message: await parseUpstreamError(upstream) });
    return;
  }

  let full = '';
  let lastUsage = null;
  let streamModel = model;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.model) streamModel = chunk.model;
      if (chunk.usage) lastUsage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        sse(res, { type: 'token', text: delta });
      }
    }
  }

  agentUsage.record({
    surface: 'live',
    model: streamModel,
    latencyMs: Date.now() - t0,
    usage: lastUsage || {},
    cost: lastUsage?.cost ?? null,
    ok: true,
    label: 'speak',
  });

  const reply = full.trim() || '…';
  appendLine({ t: Date.now(), role: 'assistant', text: reply });
  sse(res, { type: 'done', text: reply, persist: persistOk ? sessionPath : null });
}

async function runLiveTurn(res, body, apiKey) {
  const { text, image, tick, activeTab } = body || {};
  const userText = String(text || '').trim();
  const isTick = !!tick;

  if (!apiKey) {
    sse(res, {
      type: 'error',
      message: 'OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).',
    });
    return;
  }

  // Spoken finals: always force a real reply (never the SKIP router).
  if (userText) {
    await runSpokenTurn(res, { text: userText, image, activeTab }, apiKey);
    return;
  }

  // Empty text + tick → fast skip/speak router.
  if (isTick) {
    await runTickRouter(res, { image, activeTab }, apiKey);
    return;
  }

  sse(res, { type: 'error', message: 'empty text' });
}

module.exports = { getHistory, clearSession, runLiveTurn };
