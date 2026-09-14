// rehearse-server.js — Mock Interview Partner engine (SSE turns + TTS proxy).
// PRIVATE (hudhub-only). Companion context stays server-side; the client only
// ever sees streamed Adam/coach text. Zero npm deps — Node 22 global fetch.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const agentUsage = require('./agent-usage');
const rp = require('./rehearse-prompt');
const rehearseTts = require('./rehearse-tts');

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MODEL = process.env.REHEARSE_MODEL || 'meta/muse-spark-1.3';
const FALLBACK_MODEL = process.env.REHEARSE_FALLBACK_MODEL || 'anthropic/claude-opus-4.7';
// TTS chain lives in rehearse-tts.js (standalone TTS workstream module).
const TTS_MODEL = rehearseTts.MODEL;
const TTS_FALLBACK_MODEL = rehearseTts.FALLBACK_MODEL;
const TTS_VOICE = rehearseTts.VOICE;
const TTS_FALLBACK_VOICE = rehearseTts.FALLBACK_VOICE;
const TTS_FORMAT = rehearseTts.FORMAT;

// ---------------------------------------------------------------------------
// Session store (memory + gitignored JSONL)
// ---------------------------------------------------------------------------
const SESSION_CANDIDATES = [
  process.env.REHEARSE_SESSION_PATH,
  path.join(__dirname, 'rehearse-sessions.jsonl'),
  path.join(os.homedir(), '.handviz', 'rehearse-sessions.jsonl'),
  path.join(os.tmpdir(), 'handviz-rehearse-sessions.jsonl'),
].filter(Boolean);

let sessionPath = SESSION_CANDIDATES[0];
let persistOk = true;
const sessions = new Map(); // id -> session

function ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ok */ }
}
function pickWritablePath() {
  for (const p of SESSION_CANDIDATES) {
    try { ensureDir(p); fs.appendFileSync(p, '', 'utf8'); return p; }
    catch { /* try next */ }
  }
  return null;
}
(function initSessionPath() {
  for (const p of SESSION_CANDIDATES) {
    try {
      if (fs.existsSync(p)) { sessionPath = p; return; }
    } catch { /* try next */ }
  }
  const picked = pickWritablePath();
  if (picked) sessionPath = picked;
  else persistOk = false;
})();

function persistLine(obj) {
  if (!persistOk) return;
  try {
    ensureDir(sessionPath);
    fs.appendFileSync(sessionPath, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) {
    const picked = pickWritablePath();
    if (picked && picked !== sessionPath) {
      sessionPath = picked;
      try { fs.appendFileSync(sessionPath, JSON.stringify(obj) + '\n', 'utf8'); return; }
      catch { /* fall through */ }
    }
    persistOk = false;
    console.warn('[rehearse] session persist disabled:', String(e.message || e));
  }
}

/** Distinct session count on disk → difficulty progression (session 1 standard). */
function persistedSessionCount() {
  try {
    const text = fs.readFileSync(sessionPath, 'utf8');
    const ids = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.session) ids.add(row.session);
      } catch { /* skip */ }
    }
    return ids.size;
  } catch {
    return 0;
  }
}

function getSessionPath() {
  return sessionPath;
}

// ---------------------------------------------------------------------------
// Companion context (server-side only — never ships to the client)
// ---------------------------------------------------------------------------
function loadCompanion() {
  return rp.loadCompanionContext();
}

// ---------------------------------------------------------------------------
// OpenRouter streaming chat with fallback
// ---------------------------------------------------------------------------
function sse(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
}

async function parseUpstreamError(upstream) {
  const text = await upstream.text().catch(() => '');
  let msg = text.slice(0, 400);
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.error || msg;
  } catch { /* keep */ }
  if (upstream.status === 401) msg = 'OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in .env.';
  return String(msg);
}

async function streamOnce({ model, messages, temperature, maxTokens, reasoning, signal, apiKey, onToken }) {
  const t0 = Date.now();
  const upstream = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4777',
      'X-Title': 'handviz-rehearse',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(reasoning ? { reasoning } : {}),
      stream: true,
      stream_options: { include_usage: true },
      usage: { include: true },
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const err = new Error(await parseUpstreamError(upstream));
    err.status = upstream.status;
    agentUsage.record({ surface: 'rehearse', model, latencyMs: Date.now() - t0, ok: false, label: 'turn' });
    throw err;
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let lastUsage = null;
  let streamModel = model;
  let ttftMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.model) streamModel = json.model;
      if (json.usage) lastUsage = json.usage;
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) { if (ttftMs == null) ttftMs = Date.now() - t0; full += delta; if (onToken) onToken(delta, full); }
    }
  }
  const input = [...messages].reverse().find((m) => m.role === 'user');
  agentUsage.record({
    surface: 'rehearse',
    model: streamModel,
    latencyMs: Date.now() - t0,
    ttftMs,
    usage: lastUsage || {},
    cost: lastUsage?.cost ?? null,
    ok: true,
    label: 'turn',
    input: typeof input?.content === 'string' ? input.content.slice(0, 500) : '[turn]',
    output: full.slice(0, 2000),
  });
  return { text: full, model: streamModel, ttftMs };
}

function retryable(err) {
  const s = err.status || 0;
  const msg = String(err.message || '');
  if (s === 401) return false; // bad key — fallback would fail identically
  if (s === 429 || (s >= 500 && s <= 599)) return true;
  // 400s too: some models sit behind account gates (e.g. age confirmation)
  // that fail the primary permanently — Opus fallback keeps the session alive.
  if (s === 400) return true;
  // 403 model/account gates ("requires 18+ age confirmation", allowlist-only
  // models, etc.) — fall back rather than killing the session. A bad key is
  // 401, so 403 here is a model gate, not auth.
  if (s === 403) return true;
  if (/requires you to complete|age confirmation|not available for your account|allowlist/i.test(msg)) return true;
  return false;
}

/** Enforce one-question-at-a-time: cut after the second question mark. */
function enforceSingleQuestion(text) {
  const t = String(text || '');
  let count = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '?') {
      count++;
      if (count >= 2) return t.slice(0, i + 1).trim();
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function newSessionId() {
  return 'rh' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function pickOpener(type) {
  const b = rp.QUESTION_BANKS;
  if (type === 'full') return { kind: 'intro', text: b.intros[0] };
  if (type === 'behavioral') {
    return { kind: 'behavioral', text: b.behavioral[Math.floor(Math.random() * b.behavioral.length)] };
  }
  // case drill: rotate across banks deterministically-ish
  // Case rotation: Product Vision + Problem Space ONLY (per prep guide).
  const pools = [
    ...b.productVision.map((t) => ({ kind: 'product', text: t })),
    ...b.problemSpace.map((t) => ({ kind: 'problem', text: t })),
  ];
  return pools[Math.floor(Math.random() * pools.length)];
}

function historyForModel(session, cap = 30) {
  return session.history.slice(-cap).map((m) => ({
    role: m.role,
    content: m.text,
  }));
}

function transcriptBlock(session, maxChars = 12000) {
  const lines = session.history.map((m) =>
    (m.role === 'user' ? 'Savar: ' : m.role === 'coach' ? 'COACH: ' : 'Adam: ') + m.text);
  let out = lines.join('\n');
  if (out.length > maxChars) out = '…(earlier truncated)…\n' + out.slice(-maxChars);
  return out;
}

function metricsBlock(metrics) {
  const m = metrics || {};
  const lines = [];
  if (m.answers?.length) {
    lines.push(`Per-answer durations: ${m.answers.map((a, i) => `A${i + 1} ${a.secs}s`).join(', ')}`);
    const ttf = m.answers.map((a) => a.ttfDecisionSecs).filter((x) => x != null);
    if (ttf.length) lines.push(`Time-to-first-decision: ${ttf.map((x) => x + 's').join(', ')}`);
  }
  if (m.fillerTotal != null) lines.push(`Filler rate: ${m.fillerTotal} fillers (${m.fillerPerMin ?? '?'} per min) across ${m.speakingSecs ?? '?'}s speaking`);
  if (m.restarts) lines.push(`Restarts after interrupt: ${m.restarts}`);
  if (m.interrupted) lines.push(`Interrupted mid-answer: yes`);
  if (m.guardFired) lines.push(`Monologue guard fired: yes`);
  return lines.length ? lines.join('\n') : 'No client metrics reported.';
}

// ---------------------------------------------------------------------------
// Main SSE entry: POST /api/rehearse
// ---------------------------------------------------------------------------
function restoreSession(id) {
  id = String(id || '');
  if (!id) return null;
  if (sessions.has(id)) return sessions.get(id);
  // Rebuild in-memory state from the JSONL audit trail so a server restart
  // doesn't strand the client's session (restarts become invisible).
  let s = null;
  let ended = false;
  try {
    const lines = fs.readFileSync(sessionPath, 'utf8').split('\n');
    for (const ln of lines) {
      if (!ln) continue;
      let o;
      try { o = JSON.parse(ln); } catch { continue; }
      if (o.session !== id) continue;
      if (o.event === 'start') {
        s = { id, type: rp.SESSION_TYPES[o.type] ? o.type : 'full', mode: 'interviewing',
          history: [], depth: 0, turns: 0, interruptUsed: false, guardUsed: false,
          startedAt: o.t || Date.now(), sessionNumber: o.sessionNumber || 1, stressor: null,
          opener: null, interruptibleTurn: o.type === 'behavioral' ? -1 : 2, clientMetrics: null, restored: true };
        ended = false;
      } else if (!s) { continue; }
      else if (o.event === 'end') { ended = true; }
      else if (ended) { continue; }
      else if (o.event === 'user') {
        s.history.push({ role: 'user', text: o.text || '', t: o.t || Date.now(), cutin: o.cutin || undefined });
        s.turns++; s.depth = Math.min(s.depth + 1, 6);
        if (o.cutin) s.interruptUsed = true;
      } else if (o.event === 'guard') {
        s.guardUsed = true;
        s.history.push({ role: 'user', text: '[monologue cut at guard] ' + (o.text || ''), t: o.t || Date.now(), guard: true });
        s.turns++;
      } else if (o.event === 'assistant') {
        s.history.push({ role: 'assistant', text: o.text || '', t: o.t || Date.now(), kind: o.kind || 'push' });
        if (o.kind === 'interrupt') s.interruptUsed = true;
      } else if (o.event === 'debrief') {
        s.history.push({ role: 'coach', text: o.text || '', t: o.t || Date.now() });
        s.mode = 'coaching';
      }
    }
  } catch { return null; }
  if (!s || ended) return null;
  s.stressor = rp.stressorForSession(s.sessionNumber);
  sessions.set(id, s);
  console.log(`[rehearse] restored session ${id} (${s.type}, ${s.turns} turns) from disk`);
  return s;
}

async function runRehearseTurn(res, body, apiKey, { signal } = {}) {
  if (!apiKey) {
    sse(res, { type: 'error', message: 'OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).' });
    return;
  }
  const action = String(body.action || 'answer');

  if (action === 'start') {
    const type = rp.SESSION_TYPES[body.sessionType] ? body.sessionType : 'full';
    const st = rp.SESSION_TYPES[type];
    const id = newSessionId();
    const sessionNumber = persistedSessionCount() + 1;
    const stressor = rp.stressorForSession(sessionNumber);
    const opener = pickOpener(type);
    const session = {
      id, type, mode: 'interviewing', history: [],
      depth: 0, turns: 0, interruptUsed: false,
      guardUsed: false, startedAt: Date.now(),
      sessionNumber, stressor, opener,
      interruptibleTurn: type === 'behavioral' ? -1 : 2,
      clientMetrics: null,
    };
    sessions.set(id, session);
    persistLine({ t: Date.now(), session: id, type, event: 'start', sessionNumber });
    if (body.diag && typeof body.diag === 'object') persistLine({ t: Date.now(), session: id, type, event: 'diag', diag: body.diag });

    const system = rp.interviewerSystem({ companion: loadCompanion(), sessionType: type, sessionCount: sessionNumber, stressor });
    const openBrief = type === 'full'
      ? `Begin the interview now. Greet Savar in one short sentence as Adam, then ask exactly: "${opener.text}" Nothing else.`
      : type === 'case'
        ? `Begin the drill now. One short sentence as Adam framing the case (${opener.kind} case), then ask exactly this and nothing else: "${opener.text}"`
        : `Begin the rep now. One short sentence as Adam, then ask exactly this behavioral question and nothing else: "${opener.text}"`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `[SESSION START — ${st.name}. ${openBrief}]` },
    ];
    sse(res, {
      type: 'meta', sessionId: id, sessionType: type, sessionNumber, stressor,
      interruptibleTurn: session.interruptibleTurn, promptVersion: rp.PROMPT_VERSION,
    });
    try {
      const out = await streamWithFallback({ messages, temperature: 0.3, maxTokens: 1500, reasoning: { effort: 'minimal' }, signal, apiKey, res });
      const text = enforceSingleQuestion(out.text.trim());
      session.history.push({ role: 'assistant', text, t: Date.now(), kind: 'open' });
      persistLine({ t: Date.now(), session: id, type, event: 'assistant', text });
      sse(res, { type: 'done', text, depth: 0, turn: 0, sessionId: id });
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') return;
      sse(res, { type: 'error', message: String(e.message || e) });
    }
    return;
  }

  if (action === 'score') {
    // Standalone pasted-answer scoring — no session required.
    const text = String(body.text || '').trim();
    if (!text) { sse(res, { type: 'error', message: 'empty answer' }); return; }
    const question = String(body.question || '').trim();
    const kind = ['vision', 'problem', 'behavioral'].includes(body.kind) ? body.kind : 'auto';
    const kindLine = kind === 'auto'
      ? 'QUESTION TYPE: not specified — infer it (vision / problem-space / behavioral), state your assumption in one line, then score with that lens.'
      : `QUESTION TYPE (explicit): ${{ vision: 'Product Vision — user empathy, purpose/value over time, credible compelling plan', problem: 'Problem Space Understanding — technical+business grasp, credible solutions, name who/what takes the hit', behavioral: 'Behavioral — STAR spine, quantified impact, lesson learned' }[kind]}.`;
    const system = rp.coachSystem({ companion: loadCompanion() });
    const userMsg = [
      'PASTED ANSWER SCORING — a single written answer (not a live voice turn: no voice metrics, no interrupt data). Score it exactly like a live answer.',
      question ? `QUESTION ASKED:\n${question.slice(0, 1000)}` : 'QUESTION: not provided.',
      kindLine,
      '',
      'ANSWER TO SCORE:',
      text.slice(0, 8000),
      '',
      'Score 1-4 on the five dimensions with quoted evidence, lead with L7 headlines, max 2 fixes, end with ONE 90-second re-run offer.',
    ].join('\n');
    sse(res, { type: 'meta', mode: 'coaching', paste: true });
    try {
      const out = await streamWithFallback({
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        temperature: 0.2, maxTokens: 3000, reasoning: { effort: 'low' }, signal, apiKey, res,
      });
      const reply = out.text.trim();
      persistLine({ t: Date.now(), session: 'paste', type: 'paste', event: 'paste-score', kind, question: question.slice(0, 500), text: text.slice(0, 4000), reply: reply.slice(0, 4000) });
      if (body.diag && typeof body.diag === 'object') persistLine({ t: Date.now(), session: 'paste', type: 'paste', event: 'diag', diag: body.diag });
      sse(res, { type: 'done', text: reply, mode: 'coaching', paste: true });
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') return;
      sse(res, { type: 'error', message: String(e.message || e) });
    }
    return;
  }

  const session = restoreSession(body.sessionId);
  if (!session) {
    sse(res, { type: 'error', message: 'Unknown or expired session — pick a session type to start fresh.' });
    return;
  }
  if (body.diag && typeof body.diag === 'object') persistLine({ t: Date.now(), session: session.id, type: session.type, event: 'diag', diag: body.diag });
  if (body.metrics && typeof body.metrics === 'object') session.clientMetrics = body.metrics;

  if (action === 'end' || action === 'break') {
    session.mode = 'coaching';
    await runCoachTurn(res, session, { signal, apiKey });
    return;
  }

  if (action === 'guard') {
    const partial = String(body.text || '').slice(0, 2000);
    session.guardUsed = true;
    session.history.push({ role: 'user', text: `[monologue cut at guard] ${partial}`, t: Date.now(), guard: true });
    persistLine({ t: Date.now(), session: session.id, type: session.type, event: 'guard', text: partial });
    const system = rp.interviewerSystem({ companion: loadCompanion(), sessionType: session.type, sessionCount: session.sessionNumber, stressor: session.stressor });
    const messages = [
      { role: 'system', content: system },
      ...historyForModel(session, 12),
      { role: 'user', content: `[MONOLOGUE GUARD — he has been talking ~2.5 min without a decision, metric, or user-visible description. Start your reply with EXACTLY "${rp.GUARD_LINE}" then ask ONE sharp follow-up on the weakest point of this partial answer: "${partial.slice(-800)}"]` },
    ];
    sse(res, { type: 'meta', sessionId: session.id, guard: true, depth: session.depth });
    try {
      const out = await streamWithFallback({ messages, temperature: 0.3, maxTokens: 1200, reasoning: { effort: 'minimal' }, signal, apiKey, res });
      const text = enforceSingleQuestion(out.text.trim());
      session.history.push({ role: 'assistant', text, t: Date.now(), kind: 'guard' });
      session.turns++;
      persistLine({ t: Date.now(), session: session.id, type: session.type, event: 'assistant', kind: 'guard', text });
      sse(res, { type: 'done', text, depth: session.depth, turn: session.turns, sessionId: session.id, guard: true });
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') return;
      sse(res, { type: 'error', message: String(e.message || e) });
    }
    return;
  }

  // ---- default: answer turn ----
  const text = String(body.text || '').trim();
  if (!text) {
    sse(res, { type: 'error', message: 'empty answer' });
    return;
  }
  // "break" drops the persona and goes to coach.
  if (/^\s*break\b/i.test(text) || /\bbreak character\b/i.test(text)) {
    session.history.push({ role: 'user', text, t: Date.now() });
    persistLine({ t: Date.now(), session: session.id, type: session.type, event: 'user', text });
    session.mode = 'coaching';
    await runCoachTurn(res, session, { signal, apiKey });
    return;
  }
  const isCutin = !!body.cutin;
  if (isCutin) session.interruptUsed = true;
  session.history.push({ role: 'user', text, t: Date.now(), cutin: isCutin || undefined });
  session.turns++;
  session.depth = Math.min(session.depth + 1, 6);
  persistLine({ t: Date.now(), session: session.id, type: session.type, event: 'user', cutin: isCutin || undefined, text });
  if (session.mode !== 'interviewing') session.mode = 'interviewing';

  const system = rp.interviewerSystem({ companion: loadCompanion(), sessionType: session.type, sessionCount: session.sessionNumber, stressor: session.stressor });
  const userMsg = isCutin
    ? `[INTERRUPT — he was STILL TALKING and you cut in mid-sentence. Start with a cut-in phrase ("Let me jump in here — " etc.), then ONE sharp follow-up on the weakest point so far. Do not let him finish the thought; react to this partial answer: "${text.slice(-1200)}"]`
    : text;
  const messages = [
    { role: 'system', content: system },
    ...historyForModel(session, 30).slice(0, -1),
    { role: 'user', content: userMsg },
  ];
  sse(res, { type: 'meta', sessionId: session.id, depth: session.depth, interrupt: isCutin || undefined });
  try {
    const out = await streamWithFallback({ messages, temperature: 0.3, maxTokens: 1500, reasoning: { effort: 'minimal' }, signal, apiKey, res });
    const reply = enforceSingleQuestion(out.text.trim());
    session.history.push({ role: 'assistant', text: reply, t: Date.now(), kind: isCutin ? 'interrupt' : 'push' });
    persistLine({ t: Date.now(), session: session.id, type: session.type, event: 'assistant', kind: isCutin ? 'interrupt' : 'push', text: reply });
    sse(res, { type: 'done', text: reply, depth: session.depth, turn: session.turns, sessionId: session.id, interrupt: isCutin || undefined });
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') return;
    sse(res, { type: 'error', message: String(e.message || e) });
  }
}

async function streamWithFallback({ messages, temperature, maxTokens, reasoning, signal, apiKey, res }) {
  const t0 = Date.now();
  try {
    const out = await streamOnce({
      model: MODEL, messages, temperature, maxTokens, reasoning, signal, apiKey,
      onToken: (delta) => sse(res, { type: 'token', text: delta }),
    });
    if (!out.text.trim()) {
      try { agentUsage.record({ surface: 'rehearse', model: MODEL, latencyMs: Date.now() - t0, ok: false, label: 'turn', input: 'empty stream (HTTP ok, no content — starved by max_tokens?)' }); } catch { /* telemetry only */ }
      throw Object.assign(new Error('empty stream from ' + MODEL), { status: 502 });
    }
    console.log(`[rehearse] turn model=${out.model} ttft=${out.ttftMs}ms total=${Date.now() - t0}ms`);
    return out;
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') throw e;
    if (!retryable(e) && !/empty stream/.test(String(e.message || ''))) throw e;
    const reason = String(e.message || e).slice(0, 160);
    sse(res, { type: 'fallback', model: FALLBACK_MODEL, from: MODEL, reason });
    console.log(`[rehearse] fallback ${MODEL} -> ${FALLBACK_MODEL}: ${reason}`);
    const out = await streamOnce({
      model: FALLBACK_MODEL, messages, temperature, maxTokens, reasoning, signal, apiKey,
      onToken: (delta) => sse(res, { type: 'token', text: delta }),
    });
    if (!out.text.trim()) {
      try { agentUsage.record({ surface: 'rehearse', model: FALLBACK_MODEL, latencyMs: Date.now() - t0, ok: false, label: 'turn', input: 'empty stream from fallback' }); } catch { /* telemetry only */ }
      throw new Error('empty stream from fallback ' + FALLBACK_MODEL);
    }
    console.log(`[rehearse] turn model=${out.model} ttft=${out.ttftMs}ms total=${Date.now() - t0}ms (via fallback)`);
    return out;
  }
}

async function runCoachTurn(res, session, { signal, apiKey }) {
  const system = rp.coachSystem({ companion: loadCompanion() });
  const userMsg = [
    `SEGMENT OVER — ${rp.SESSION_TYPES[session.type].name}, ${session.turns} exchanges. Debrief Savar now.`,
    session.opener && (session.opener.kind === 'product' || session.opener.kind === 'problem')
      ? `OPENING CASE CATEGORY (from bank — trust unless the transcript clearly moved): ${session.opener.kind === 'product' ? 'Product Vision' : 'Problem Space Understanding'}.`
      : ``,
    ``,
    `TRANSCRIPT:`,
    transcriptBlock(session),
    ``,
    `VOICE METRICS:`,
    metricsBlock(session.clientMetrics),
    session.interruptUsed ? `Interrupt fired mid-answer: yes.` : `Interrupt fired mid-answer: no.`,
    ``,
    `Score every answer 1-4 with quoted evidence, lead with L7 headlines, max 2 fixes, end with ONE 90-second re-run offer.`,
  ].join('\n');
  sse(res, { type: 'meta', sessionId: session.id, mode: 'coaching' });
  try {
    const out = await streamWithFallback({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.2, maxTokens: 5000, reasoning: { effort: 'low' }, signal, apiKey, res,
    });
    const text = out.text.trim();
    session.history.push({ role: 'coach', text, t: Date.now() });
    persistLine({ t: Date.now(), session: session.id, type: session.type, event: 'debrief', text });
    sse(res, { type: 'done', text, mode: 'coaching', sessionId: session.id, debrief: true });
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') return;
    sse(res, { type: 'error', message: String(e.message || e) });
  }
}

function getSession(id) {
  return restoreSession(id);
}

function endSession(id) {
  const s = restoreSession(id);
  if (!s) return false;
  persistLine({ t: Date.now(), session: s.id, type: s.type, event: 'end', turns: s.turns });
  sessions.delete(s.id);
  return true;
}

// ---------------------------------------------------------------------------
// TTS: thin re-export of the standalone rehearse-tts.js chain
// (Gemini → Grok → Kitten local → throw for client speechSynthesis fallback)
// ---------------------------------------------------------------------------
async function synthesizeRehearseTts(text, apiKey, opts) {
  return rehearseTts.synthesize(text, apiKey, opts);
}

module.exports = {
  MODEL,
  FALLBACK_MODEL,
  TTS_MODEL,
  TTS_FALLBACK_MODEL,
  TTS_VOICE,
  TTS_FALLBACK_VOICE,
  TTS_FORMAT,
  PROMPT_VERSION: rp.PROMPT_VERSION,
  SESSION_TYPES: rp.SESSION_TYPES,
  runRehearseTurn,
  getSession,
  endSession,
  synthesizeRehearseTts,
  getSessionPath,
  persistedSessionCount,
};
