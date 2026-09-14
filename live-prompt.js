// Live system-prompt lab: view / edit / test / refine Val's voice prompt.
// The prompt of record is valinor-agent/.pi/SYSTEM.md (the Pi SDK reads it as
// the project system prompt). Saving deploys immediately: the file is written
// and the live Pi session is reset so the next turn picks it up.
// Version history lives in valinor-agent/.runtime/ (gitignored).
'use strict';

const fs = require('fs');
const path = require('path');
const agentUsage = require('./agent-usage');

const SYSTEM_PATH = path.join(__dirname, 'valinor-agent', '.pi', 'SYSTEM.md');
const VERSIONS_PATH = path.join(__dirname, 'valinor-agent', '.runtime', 'live-prompt-versions.json');
const VERSION_CAP = 30;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Lab dry-runs use the same brain as the deployed voice (live-pi.mjs DEFAULT_MODEL),
// otherwise the test misrepresents what Savar will hear.
const LAB_MODEL = process.env.LIVE_MODEL || process.env.OPENROUTER_MODEL || 'meta/muse-spark-1.3';

function labReasoning(model) {
  if (/muse/i.test(String(model || ''))) return { effort: 'minimal' };
  return null;
}

const REFINE_SYSTEM = `You edit system prompts for Val, a live voice companion that talks to Savar over speech and acts through tools (memory, ingest search, tasks, web, board display).

Rules for the rewrite:
- Make the SMALLEST targeted edit that addresses the feedback. Preserve everything that already works.
- Keep the voice contract intact unless the feedback asks to change it: 1–3 short spoken sentences, no markdown/lists/preamble, tool calls silent.
- Keep tool-routing guidance (which tool for which ask) unless the feedback says it is wrong.
- Do not add greetings, examples of full conversations, or meta-commentary about prompts.
- Return ONLY the full revised system prompt. No quotes, no preamble, no explanation.`;

function readSystem() {
  try {
    return fs.readFileSync(SYSTEM_PATH, 'utf8');
  } catch (e) {
    throw Object.assign(new Error('cannot read SYSTEM.md: ' + String(e.message || e)), { status: 500 });
  }
}

function readVersions() {
  try {
    const raw = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeVersions(list) {
  try {
    fs.mkdirSync(path.dirname(VERSIONS_PATH), { recursive: true });
    fs.writeFileSync(VERSIONS_PATH, JSON.stringify(list.slice(0, VERSION_CAP), null, 2), 'utf8');
  } catch { /* keep in-memory only */ }
}

function getLab() {
  const versions = readVersions();
  return {
    path: SYSTEM_PATH,
    displayPath: 'valinor-agent/.pi/SYSTEM.md',
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
  fs.writeFileSync(SYSTEM_PATH, text, 'utf8');
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
    'SAVAR\u2019S FEEDBACK:',
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
