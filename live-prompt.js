// Live system-prompt lab: view / edit / test / refine Val's voice prompt.
// The prompt of record lives in the user data home (override with
// LIVE_PROMPT_SYSTEM_PATH). Saving deploys immediately for the direct-turn
// voice path. Version history sits alongside it.
'use strict';

const fs = require('fs');
const path = require('path');
const agentUsage = require('./agent-usage');
const dataHome = require('./data-home');

// Primary: explicit override, else the data-home prompt store.
function primarySystemPath() {
  const env = String(process.env.LIVE_PROMPT_SYSTEM_PATH || '').trim();
  if (env) return { path: env, explicit: true };
  return { path: fallbackSystemPath(), explicit: true };
}
// Fallback when the agent workspace is absent (public builds): a data-home
// store seeded with a generic prompt. Same API, no Pi required.
function fallbackSystemPath() {
  return path.join(dataHome.dataDir(), 'live-prompt-system.md');
}
function fallbackVersionsPath() {
  return path.join(dataHome.dataDir(), 'live-prompt-versions.json');
}
function useFallback() {
  const { path: p, explicit } = primarySystemPath();
  if (explicit) return false;
  try { return !fs.existsSync(p); } catch { return true; }
}
function systemPath() {
  const { path: p, explicit } = primarySystemPath();
  if (explicit) return p;
  return useFallback() ? fallbackSystemPath() : p;
}
function versionsPath() {
  const env = String(process.env.LIVE_PROMPT_VERSIONS_PATH || '').trim();
  if (env) return env;
  return fallbackVersionsPath();
}
// Legacy exports — resolve dynamically now (data-home prompt store).
const SYSTEM_PATH = primarySystemPath().path;
const VERSIONS_PATH = fallbackVersionsPath();

const GENERIC_DEFAULT_PROMPT = `You are Val, a live voice companion talking with the user over speech.

Keep every reply short (1-3 sentences), warm, and concrete — no lists, no markdown, no stage directions. This is spoken aloud: plain sentences only.

Answer from the conversation and the hub context you are given. If something needs doing, say what you will do in one line, then do it silently through your tools.`;
const VERSION_CAP = 30;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Lab dry-runs use the same brain family as the deployed voice,
// otherwise the test misrepresents what the user will hear.
const LAB_MODEL = process.env.LIVE_MODEL || process.env.OPENROUTER_MODEL || 'meta/muse-spark-1.3';

function labReasoning(model) {
  if (/muse/i.test(String(model || ''))) return { effort: 'minimal' };
  return null;
}

const REFINE_SYSTEM = `You edit system prompts for Val, a live voice companion that talks to the user over speech and acts through tools (memory, ingest search, tasks, web, board display).

Rules for the rewrite:
- Make the SMALLEST targeted edit that addresses the feedback. Preserve everything that already works.
- Keep the voice contract intact unless the feedback asks to change it: 1–3 short spoken sentences, no markdown/lists/preamble, tool calls silent.
- Keep tool-routing guidance (which tool for which ask) unless the feedback says it is wrong.
- Do not add greetings, examples of full conversations, or meta-commentary about prompts.
- Return ONLY the full revised system prompt. No quotes, no preamble, no explanation.`;

function readSystem() {
  const p = systemPath();
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (useFallback()) return GENERIC_DEFAULT_PROMPT;
    throw Object.assign(new Error('cannot read SYSTEM.md: ' + String(e.message || e)), { status: 500 });
  }
}

function readVersions() {
  try {
    const raw = JSON.parse(fs.readFileSync(versionsPath(), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeVersions(list) {
  try {
    const p = versionsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(list.slice(0, VERSION_CAP), null, 2), 'utf8');
  } catch { /* keep in-memory only */ }
}

function getLab() {
  const versions = readVersions();
  const p = systemPath();
  const display = p.startsWith(__dirname + path.sep) ? p.slice(__dirname.length + 1) : p;
  return {
    path: p,
    displayPath: display,
    prompt: readSystem(),
    versions: versions.map((v) => ({
      id: v.id,
      ts: v.ts,
      note: v.note || '',
      chars: (v.prompt || '').length,
    })),
    hasKey: Boolean(process.env.OPENROUTER_API_KEY),
  };
}

function getVersion(id) {
  const v = readVersions().find((x) => x.id === String(id));
  if (!v) throw Object.assign(new Error('version not found'), { status: 404 });
  return v;
}

/** Deploy a prompt: version it, write SYSTEM.md. Caller resets the Pi session. */
function deployPrompt(prompt, note) {
  const text = String(prompt || '').trim();
  if (!text) throw Object.assign(new Error('empty prompt'), { status: 400 });
  if (text.length > 20000) throw Object.assign(new Error('prompt too long (20k max)'), { status: 400 });
  const versions = readVersions();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    note: String(note || '').slice(0, 200),
    prompt: text,
  };
  versions.unshift(entry);
  writeVersions(versions);
  const dest = systemPath();
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ok */ }
  fs.writeFileSync(dest, text, 'utf8');
  return { id: entry.id, ts: entry.ts, chars: text.length };
}

function revertVersion(id) {
  const v = getVersion(id);
  return deployPrompt(v.prompt, 'revert to ' + new Date(v.ts).toLocaleString());
}

async function chatOnce({ system, user, maxTokens }, apiKey, label) {
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is missing'), { status: 400 });
  const t0 = Date.now();
  const reasoning = labReasoning(LAB_MODEL);
  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'valinor-prompt-lab',
      },
      body: JSON.stringify({
        model: LAB_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
        max_tokens: maxTokens,
        ...(reasoning ? { reasoning } : {}),
        stream: false,
        usage: { include: true },
      }),
    });
  } catch (e) {
    agentUsage.record({ surface: 'live-prompt', model: LAB_MODEL, latencyMs: Date.now() - t0, ok: false, label });
    throw e;
  }
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    let msg = errText.slice(0, 300);
    try { msg = JSON.parse(errText).error?.message || msg; } catch { /* keep */ }
    agentUsage.record({ surface: 'live-prompt', model: LAB_MODEL, latencyMs: Date.now() - t0, ok: false, label });
    throw Object.assign(new Error(String(msg)), { status: upstream.status });
  }
  const json = await upstream.json();
  const usage = json.usage || {};
  const text = String(json.choices?.[0]?.message?.content || '').trim();
  agentUsage.record({
    surface: 'live-prompt',
    model: json.model || LAB_MODEL,
    latencyMs: Date.now() - t0,
    usage,
    cost: usage.cost ?? null,
    ok: true,
    label,
    input: String(user || '').slice(0, 500),
    output: text.slice(0, 500),
  });
  return text;
}

/** Dry run: what would Val say to this input under the candidate prompt? No tools. */
async function testPrompt(prompt, input, apiKey) {
  const text = String(prompt || '').trim();
  const userText = String(input || '').trim();
  if (!text) throw Object.assign(new Error('empty prompt'), { status: 400 });
  if (!userText) throw Object.assign(new Error('empty test input'), { status: 400 });
  const out = await chatOnce({
    system: text + '\n\n[Dry run: no tools, memory, or camera available. Answer from the prompt alone.]',
    user: userText,
    maxTokens: 300,
  }, apiKey, 'test');
  return { response: out, model: LAB_MODEL, dryRun: true };
}

/** One eval-loop step: prompt + test transcript + feedback → revised candidate. */
async function refinePrompt({ prompt, testInput, testResponse, feedback }, apiKey) {
  const text = String(prompt || '').trim();
  const fb = String(feedback || '').trim();
  if (!text) throw Object.assign(new Error('empty prompt'), { status: 400 });
  if (!fb) throw Object.assign(new Error('empty feedback'), { status: 400 });
  const user = [
    'CURRENT SYSTEM PROMPT:',
    text,
    '',
    testInput ? 'TEST INPUT:\n' + String(testInput).slice(0, 1500) : null,
    testResponse ? 'RESPONSE IT PRODUCED:\n' + String(testResponse).slice(0, 1500) : null,
    '',
    'USER\u2019S FEEDBACK:',
    fb,
  ].filter((x) => x != null).join('\n');
  const out = await chatOnce({ system: REFINE_SYSTEM, user, maxTokens: 4000 }, apiKey, 'refine');
  if (!out) throw Object.assign(new Error('refine returned empty'), { status: 502 });
  return { prompt: out, model: LAB_MODEL };
}

module.exports = {
  SYSTEM_PATH,
  getLab,
  getVersion,
  deployPrompt,
  revertVersion,
  testPrompt,
  refinePrompt,
  LAB_MODEL,
};
