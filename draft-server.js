// draft-server.js — conversational message drafting over OpenRouter, streamed via SSE.
// Zero npm deps — Node 22 global fetch. Required by server.js.
'use strict';

const fs = require('fs');
const path = require('path');
const networkData = require('./network-data');
const agentUsage = require('./agent-usage');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ROOT = __dirname;
const DRAFTS_FILE = path.join(ROOT, 'drafts.json');
const PROFILE_FILE = path.join(ROOT, 'message-profile.json');

function messageModel() {
  return process.env.MESSAGE_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
}
// Ranking 185 people against a fuzzy need is a much harder task than mimicking a text
// message's style — a mini model fabricates jobs and mixes up who's who here, so this step
// gets a stronger default than drafting does.
function suggestModel() {
  return process.env.SUGGEST_MODEL || 'openai/gpt-4o';
}

const PRESETS = {
  'Quick Ping': 'Ultra-concise, casual, zero fluff. Make it trivially easy to ignore or answer in two words.',
  'Warm Catch-up': 'Low pressure, personal, open-ended. No agenda beyond reconnecting.',
  'Direct Request': 'Action-oriented. Lead with the ask, state the value, end with a clear call-to-action.',
  'Polite Follow-up': 'Graceful and warm. Zero passive-aggressiveness about the earlier silence.',
};

const BASE_RULES = `You are a low-friction communication assistant helping the user draft a real text/iMessage.

Rules:
1. Never sound like an AI. No corporate buzzwords, no excessive enthusiasm, no formal salutations ("Dear", "Best regards") unless the user asks for them.
2. Match the length and register of a real text message between people who know each other, not an email.
3. Keep the reply barrier low for the recipient — don't demand a long response.
4. Output ONLY the message text itself. No preamble like "Here's a draft:", no quotation marks around it, no options/alternatives unless asked, no explanation after it.
5. Use the CONTACT CONTEXT below to make the message specific, not generic — but only reference facts that are actually relevant to the raw intent.
6. When the user gives a one-word or short refinement instruction (e.g. "shorter", "warmer"), apply it to your last draft and return the full revised message, still following rule 4.`;

function safeReadJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ---- Phase 2: learning from the drafts.json log ----

// Deterministic, no LLM call: how often does the user ask for each refinement chip.
// Cheap enough to compute on every request; surfaces a standing bias directly in the prompt.
function refinementBiasBlock(drafts) {
  const counts = {};
  let sessionsWithRefinements = 0;
  for (const s of drafts) {
    if (!Array.isArray(s.refinements) || !s.refinements.length) continue;
    sessionsWithRefinements++;
    for (const r of s.refinements) counts[r] = (counts[r] || 0) + 1;
  }
  if (sessionsWithRefinements < 5) return null; // not enough signal yet
  const lines = Object.entries(counts)
    .filter(([, n]) => n / sessionsWithRefinements >= 0.3)
    .sort((a, b) => b[1] - a[1])
    .map(([chip, n]) => `- "${chip}" in ${Math.round((n / sessionsWithRefinements) * 100)}% of sessions`);
  if (!lines.length) return null;
  return [
    'LEARNED BIAS (from past sessions — bake this in on the FIRST draft so the user has to ask less):',
    ...lines,
  ].join('\n');
}

// Accepted drafts (what the user actually copied) are better style exemplars than raw
// texts, because they are already in the distribution of "things the user chose to send".
function acceptedExemplarsBlock(drafts, contactId) {
  const accepted = drafts.filter((s) => s.copiedText);
  const forContact = contactId != null ? accepted.filter((s) => s.contactId === contactId) : [];
  const pool = forContact.length ? forContact : accepted;
  const sample = pool.slice(-5).map((s) => s.copiedText);
  if (!sample.length) return null;
  return [
    contactId != null && forContact.length
      ? 'MESSAGES THE USER HAS PREVIOUSLY SENT TO THIS PERSON (match this voice closely):'
      : 'MESSAGES THE USER HAS ACCEPTED BEFORE (match this general voice):',
    ...sample.map((t) => `- ${t}`),
  ].join('\n');
}

function voiceExemplarsBlock(contactId) {
  if (contactId == null) return null;
  const sent = networkData.getSentMessages(contactId, 12);
  if (!sent.length) return null;
  return [
    'REAL MESSAGES THE USER HAS SENT THIS EXACT PERSON (this is their actual voice — mirror the tone, slang, and punctuation style):',
    ...sent.map((t) => `- ${t}`),
  ].join('\n');
}

function distilledProfileBlock() {
  const profile = safeReadJson(PROFILE_FILE, null);
  if (!profile || !profile.summary) return null;
  return `HOW THE USER WRITES (distilled from past sessions):\n${profile.summary}`;
}

function contextBlock(context, omit) {
  if (!context) return 'CONTACT CONTEXT: none — this is not a saved contact, use only the raw intent below.';
  const skip = new Set(omit || []);
  const lines = ['CONTACT CONTEXT:', `- Name: ${context.name}`];
  if (!skip.has('company') && context.company) lines.push(`- Company/role: ${[context.company, context.role].filter(Boolean).join(' — ')}`);
  if (!skip.has('school') && context.school) lines.push(`- School: ${context.school}`);
  if (!skip.has('tags') && context.tags?.length) lines.push(`- Tags: ${context.tags.join(', ')}`);
  if (!skip.has('oneLiner') && context.oneLiner) lines.push(`- Note: ${context.oneLiner}`);
  if (!skip.has('notes') && context.notes) lines.push(`- Notes: ${context.notes}`);
  if (!skip.has('recency') && context.daysSince != null) {
    lines.push(`- Last exchanged a message ${context.daysSince} day(s) ago (${context.msgCount} messages total).`);
  }
  if (!skip.has('thread') && context.thread?.length) {
    lines.push('- Recent messages (oldest first):');
    for (const m of context.thread) lines.push(`  ${m.fromMe ? 'user' : context.name}: ${m.text}`);
  }
  return lines.join('\n');
}

function systemPrompt({ context, omit, extraContext, preset, drafts }) {
  const parts = [BASE_RULES];
  if (preset && PRESETS[preset]) parts.push(`TONE PRESET — ${preset}: ${PRESETS[preset]}`);
  parts.push(contextBlock(context, omit));
  if (extraContext && extraContext.trim()) parts.push(`ADDITIONAL CONTEXT FROM USER:\n${extraContext.trim()}`);
  const contactId = context?.id ?? null;
  const bias = refinementBiasBlock(drafts);
  if (bias) parts.push(bias);
  const voice = voiceExemplarsBlock(contactId);
  if (voice) parts.push(voice);
  const accepted = acceptedExemplarsBlock(drafts, contactId);
  if (accepted) parts.push(accepted);
  const profile = distilledProfileBlock();
  if (profile) parts.push(profile);
  return parts.join('\n\n');
}

function sseWrite(res, evt) {
  try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* closed */ }
}

// Streams real token deltas from OpenRouter (OpenAI-compatible SSE) straight through to
// the client — the whole point of streaming here is watching the draft form and being
// able to bail with Copy before it even finishes.
async function streamOpenRouter(apiKey, messages, onDelta) {
  const t0 = Date.now();
  const model = messageModel();
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4777',
      'X-Title': 'handviz-messages',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let json; try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 400) } }; }
    agentUsage.record({ surface: 'draft', model, latencyMs: Date.now() - t0, ok: false, label: 'stream' });
    const msg = json.error?.message || json.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let lastUsage = null;
  let streamModel = model;
  while (true) {
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
      if (delta) { full += delta; onDelta(delta); }
    }
  }
  agentUsage.record({
    surface: 'draft',
    model: streamModel,
    latencyMs: Date.now() - t0,
    usage: lastUsage || {},
    cost: lastUsage?.cost ?? null,
    ok: true,
    label: 'stream',
  });
  return full;
}

/**
 * Run one drafting turn. Streams SSE `delta`/`done`/`error` events to `res`.
 * body: { contactId, contactName, omit, extraContext, preset, turns }
 *   turns: [{ role: 'user'|'assistant', content }] — full running conversation,
 *   owned by the client; the first turn's content is the raw intent, later turns are
 *   refinement chips/free text.
 */
async function runDraftTurn(res, body, apiKey) {
  const contactId = body.contactId != null ? Number(body.contactId) : null;
  const turns = Array.isArray(body.turns) ? body.turns : [];

  if (!apiKey) {
    sseWrite(res, { type: 'error', message: 'OPENROUTER_API_KEY is missing. Add it to .env in the project root.' });
    return;
  }
  if (!turns.length) {
    sseWrite(res, { type: 'error', message: 'No intent provided.' });
    return;
  }

  let context = null;
  if (contactId != null) {
    try { context = networkData.getContext(contactId); } catch (e) { console.warn('[draft-server] getContext failed:', e.message); }
  }
  const drafts = safeReadJson(DRAFTS_FILE, []);

  const messages = [
    {
      role: 'system',
      content: systemPrompt({ context, omit: body.omit, extraContext: body.extraContext, preset: body.preset, drafts }),
    },
    ...turns.map((t) => ({ role: t.role, content: t.content })),
  ];

  sseWrite(res, { type: 'start' });
  try {
    const full = await streamOpenRouter(apiKey, messages, (delta) => sseWrite(res, { type: 'delta', text: delta }));
    sseWrite(res, { type: 'done', text: full.trim() });
  } catch (e) {
    const status = e.status || 0;
    let message = e.message || String(e);
    if (status === 401 || /user not found/i.test(message)) {
      message = 'OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in .env.';
    }
    sseWrite(res, { type: 'error', message, status });
  }
}

// ---- one-shot (non-streaming) OpenRouter call, for everything that isn't a live draft ----
async function callOpenRouter(apiKey, messages, { temperature = 0.3, title = 'handviz-messages', model, surface = 'draft', label = 'oneshot' } = {}) {
  const t0 = Date.now();
  const useModel = model || messageModel();
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4777',
      'X-Title': title,
    },
    body: JSON.stringify({ model: useModel, messages, temperature }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 400) } }; }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    agentUsage.record({ surface, model: useModel, latencyMs, ok: false, label });
    const msg = json.error?.message || json.error || `OpenRouter HTTP ${res.status}`;
    throw Object.assign(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)), { status: res.status });
  }
  const usage = json.usage || {};
  agentUsage.record({
    surface,
    model: json.model || useModel,
    latencyMs,
    usage,
    cost: usage.cost ?? null,
    ok: true,
    label,
  });
  return (json.choices?.[0]?.message?.content || '').trim();
}

// Models wrap JSON in prose or ```json fences often enough that strict JSON.parse alone
// makes the feature feel flaky — fall back to slicing out the outermost bracketed span.
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* keep digging */ }
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

// ---- "who should I ask?" — the step before drafting ----
// The roster is small enough (185 people) that the whole thing fits in one prompt, so this
// needs no embeddings or index: hand the model every person as one line and have it rank.
const SUGGEST_LIMIT = 8;

const SUGGEST_RULES = `You help someone decide WHO in their personal network to message about a specific need. You are not writing the message — only choosing recipients.

Rules:
1. Relevance to THIS specific need comes first. Do not just pick the most impressive or closest people.
2. Use ONLY facts written on that person's line. Never infer or invent a job, company, or expertise that isn't there. If a line has no company or role, you do not know what they do — either skip them, or say honestly what you are going on.
   BAD: "Karan is a founder with tech experience" — when nothing on his line says either.
   GOOD: "Tagged founder, runs Styl AI, exited 4Q25 — has actually shipped and sold a consumer product."
   ALSO GOOD: "Only signal is tags 'close/childhood' and 653 messages — no product background on file, but he'll be blunt with you."
3. Prefer people who are reachable and warm when relevance is a tie — someone texted recently is a lower-friction ask than someone never texted. But never pick an irrelevant person just because they're warm.
4. Flag risk honestly in the reason when it exists (e.g. "silent 2 years, would need a re-intro first").
5. Return 3-6 people. Fewer is better than padding with weak fits.
6. If the network genuinely lacks good fits for this need, say so in "gap" and still return the closest options.
7. Copy the id AND the name exactly as written on the line you chose. The name is verified against the id, and a pick whose name and id disagree is thrown away.

Respond with ONLY raw JSON, no prose and no code fences:
{"picks":[{"id":<number>,"name":"<exact name from the line>","reason":"<one specific sentence>"}],"gap":"<optional one sentence about who's missing>"}`;

function rosterLine(p) {
  const bits = [`#${p.id} ${p.name}`];
  const work = [p.company, p.role].filter(Boolean).join(' — ');
  if (work) bits.push(work);
  if (p.school) bits.push(p.school);
  if (p.tags.length) bits.push(`tags: ${p.tags.join('/')}`);
  if (p.boardPriority) bits.push('you-flagged-as-priority');
  if (p.oneLiner) bits.push(`note: ${p.oneLiner}`);
  if (p.notesBrief) bits.push(`notes: ${p.notesBrief}`);
  if (!p.hasPhone) bits.push('NO PHONE (cannot text)');
  else if (p.daysSince == null) bits.push('never texted');
  else bits.push(`last texted ${p.daysSince}d ago (${p.msgCount} msgs)`);
  return bits.join(' | ');
}

async function suggestRecipients(intent, apiKey, limit = SUGGEST_LIMIT) {
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is missing. Add it to .env in the project root.'), { status: 401 });
  if (!intent || !intent.trim()) throw Object.assign(new Error('Say what you need first.'), { status: 400 });

  const roster = networkData.getRosterForMatching();
  if (!roster.length) throw Object.assign(new Error('No people in network.db yet.'), { status: 400 });

  const content = await callOpenRouter(apiKey, [
    { role: 'system', content: SUGGEST_RULES },
    { role: 'user', content: `WHAT I NEED:\n${intent.trim()}\n\nMY NETWORK (${roster.length} people, one per line):\n${roster.map(rosterLine).join('\n')}` },
  ], { temperature: 0.2, title: 'handviz-messages-suggest', model: suggestModel() });

  const parsed = parseJsonLoose(content);
  const rawPicks = Array.isArray(parsed) ? parsed : (parsed?.picks || []);
  if (!Array.isArray(rawPicks) || !rawPicks.length) {
    throw Object.assign(new Error('Could not read a shortlist out of the model response. Try rephrasing what you need.'), { status: 502 });
  }

  const byId = new Map(roster.map((p) => [String(p.id), p]));
  const byName = new Map(roster.map((p) => [p.name.trim().toLowerCase(), p]));
  const seen = new Set();
  const picks = [];
  for (const raw of rawPicks) {
    const idHit = byId.get(String(raw?.id ?? ''));
    const nameKey = String(raw?.name || '').trim().toLowerCase();
    const nameHit = nameKey ? byName.get(nameKey) : null;
    // Models reliably write a reason about one person while returning a neighbouring row's
    // id. The name is what the reason is actually about, so it wins any disagreement —
    // otherwise the card shows someone whose blurb describes a different human entirely.
    let person = idHit;
    if (nameHit && (!idHit || nameHit.id !== idHit.id)) person = nameHit;
    if (!person || seen.has(person.id)) continue; // hallucinated id and name, or a repeat
    seen.add(person.id);
    picks.push({ ...person, reason: String(raw.reason || '').trim() || null });
    if (picks.length >= limit) break;
  }
  if (!picks.length) {
    throw Object.assign(new Error('The model picked people who are not in your network. Try again.'), { status: 502 });
  }
  return { picks, gap: parsed?.gap ? String(parsed.gap).trim() : null };
}

// ---- Phase 2: distill the accumulated log into a compact, inspectable style profile.
// Explicit/on-demand (not automatic per draft) to keep cost predictable and the result
// correctable — this is the "periodically distill" half of the learning loop; the other
// half (few-shot retrieval) runs on every draft via acceptedExemplarsBlock/voiceExemplarsBlock.
async function refreshStyleProfile(apiKey) {
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is missing.'), { status: 401 });
  const drafts = safeReadJson(DRAFTS_FILE, []);
  const accepted = drafts.filter((s) => s.copiedText).slice(-60).map((s) => s.copiedText);
  const sentSamples = [];
  const seenContacts = new Set();
  for (const s of drafts) {
    if (s.contactId == null || seenContacts.has(s.contactId)) continue;
    seenContacts.add(s.contactId);
    sentSamples.push(...networkData.getSentMessages(s.contactId, 15));
    if (sentSamples.length > 150) break;
  }
  const corpus = [...accepted, ...sentSamples].filter(Boolean);
  if (corpus.length < 8) {
    throw Object.assign(new Error('Not enough drafting history yet — need at least a handful of copied/sent messages.'), { status: 400 });
  }
  const messages = [
    {
      role: 'system',
      content: 'You analyze a corpus of real text messages someone sent and write a SHORT, concrete style profile for an AI ghostwriter to follow. Be specific and actionable (e.g. "opens with the ask, not a greeting", "never uses exclamation marks with work contacts", "signs off with just a first initial"). 4-8 bullet points max. No fluff, no generic advice.',
    },
    { role: 'user', content: `Messages:\n${corpus.slice(0, 120).map((t) => `- ${t}`).join('\n')}` },
  ];
  const summary = await callOpenRouter(apiKey, messages, { temperature: 0.3, title: 'handviz-messages-profile' });
  const profile = { summary, updatedAt: Date.now(), corpusSize: corpus.length };
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
  return profile;
}

module.exports = { runDraftTurn, refreshStyleProfile, suggestRecipients, PRESETS };
