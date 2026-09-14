// writing-voice.js — the voice model behind the WRITING tab.
// Learns Savar's voice from in-app exemplars (starred letters + samples he adds),
// distills a hand-editable writing-voice.md, and rewrites text in that voice.
// Zero npm deps — Node 22 global fetch. Required by server.js. Mirrors the proven
// draft-server.js pattern (callOpenRouter + refreshStyleProfile).
'use strict';

const fs = require('fs');
const path = require('path');
const agentUsage = require('./agent-usage');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ROOT = __dirname;
const LETTERS = path.join(ROOT, 'letters');

// Personal — all gitignored; never promote to valinor.
const PROFILE_FILE = path.join(ROOT, 'writing-voice.md');
const STARS_FILE = path.join(ROOT, 'writing-stars.json');
const SAMPLES_FILE = path.join(ROOT, 'writing-samples.json');
const RUNS_FILE = path.join(ROOT, 'writing-voice-runs.json'); // eval trajectory log

// Voice work rewards a capable model. Claude is the strongest at nuanced style-matching;
// default to it (override with WRITING_MODEL). Cheap/blunt models flatten voice into
// generic "good writing" — the exact failure this system exists to avoid.
const WRITING_MODEL =
  process.env.WRITING_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.7';
// The profile build is a heavier one-shot analysis pass; allow a stronger model there.
const WRITING_BUILD_MODEL = process.env.WRITING_BUILD_MODEL || WRITING_MODEL;
// Applying test feedback back into the profile is a careful surgical edit — use a top model.
const WRITING_REFINE_MODEL = process.env.WRITING_REFINE_MODEL || 'anthropic/claude-opus-4.8';
const TIMEOUT_MS = 120000;
const SAMPLE_CAP = 16000;   // per exemplar, chars (builder) — don't gut long pieces
const CORPUS_CAP = 120000;  // total exemplar chars fed to the builder (modern context is large)
const REWRITE_EXEMPLAR_CAP = 12000; // total verbatim "mine" chars injected into each rewrite
const REWRITE_PER_EXEMPLAR = 3500;  // per exemplar in a rewrite — keep several, varied

// Baseline tells every rewrite must avoid, on top of whatever the profile says.
// Seeds the anti-tell section and is always injected as a hard constraint.
const ANTI_TELLS = [
  'No "it\'s not just X, it\'s Y" / "not only… but also" cadence.',
  'No tidy rule-of-three tricolons used as filler.',
  'No em-dash pile-ups; use them sparingly.',
  'Vary sentence length — never a uniform march of medium sentences.',
  'No throat-clearing openers ("In today\'s world", "When it comes to").',
  'No summary bow at the end ("In conclusion", "Ultimately").',
  'Banned words: delve, holistic, robust, leverage, journey, tapestry, testament, realm.',
  'Concrete nouns and verbs over abstractions and nominalizations. Cut hedges.',
];

function safeReadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '\n…[trimmed]' : s;
}

// ---------------- stores: stars + samples ----------------

function getStars() {
  const raw = safeReadJson(STARS_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}
function setStar(file, on) {
  if (!file) throw Object.assign(new Error('missing file'), { status: 400 });
  const stars = getStars();
  if (on) stars[file] = true; else delete stars[file];
  fs.writeFileSync(STARS_FILE, JSON.stringify(stars, null, 2));
  return stars;
}

function getSamples() {
  const raw = safeReadJson(SAMPLES_FILE, []);
  return Array.isArray(raw) ? raw : [];
}
function addSample({ kind, label, text }) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('empty sample'), { status: 400 });
  const k = kind === 'inspiration' ? 'inspiration' : 'mine';
  const samples = getSamples();
  const sample = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: k,
    label: String(label || '').trim().slice(0, 120) || (k === 'mine' ? 'My writing' : 'Inspiration'),
    text: body.slice(0, 20000),
    addedAt: Date.now(),
  };
  samples.push(sample);
  fs.writeFileSync(SAMPLES_FILE, JSON.stringify(samples, null, 2));
  return sample;
}
function removeSample(id) {
  const samples = getSamples().filter((s) => s.id !== id);
  fs.writeFileSync(SAMPLES_FILE, JSON.stringify(samples, null, 2));
  return samples;
}

// Starred letters, read straight off disk — these are "mine" exemplars.
function starredLetterTexts() {
  const stars = getStars();
  const out = [];
  for (const file of Object.keys(stars)) {
    if (!stars[file]) continue;
    try {
      const md = fs.readFileSync(path.join(LETTERS, file), 'utf8');
      if (md.trim()) out.push({ label: file, text: md });
    } catch { /* letter was deleted; skip */ }
  }
  return out;
}

// ---------------- eval trajectories: one record per rewrite→feedback→update loop ----------------
// Each run captures the full trajectory: the voice + corpus that produced a rewrite, the test
// phrase and output, then (once feedback is applied) the critique and the resulting voice. This
// is the eval log — every loop is a labeled iteration you can review, diff, or revert.

function getRuns() {
  const raw = safeReadJson(RUNS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}
function writeRuns(runs) {
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
  return runs;
}
function startRun({ profileBefore, corpus, input, instruction, output, model } = {}) {
  const runs = getRuns();
  const run = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    input: String(input || ''),
    instruction: String(instruction || ''),
    output: String(output || ''),
    profileBefore: String(profileBefore || ''),
    corpus: corpus || null,
    model: model || WRITING_MODEL,
    feedback: null,
    profileAfter: null,
    refinedAt: null,
    refineModel: null,
  };
  runs.push(run);
  writeRuns(runs);
  return run;
}
function completeRun(id, { feedback, profileAfter, model } = {}) {
  if (!id) return null;
  const runs = getRuns();
  const run = runs.find((r) => r.id === id);
  if (!run) return null;
  run.feedback = String(feedback || '');
  run.profileAfter = String(profileAfter || '');
  run.refinedAt = Date.now();
  run.refineModel = model || WRITING_REFINE_MODEL;
  writeRuns(runs);
  return run;
}
// Lightweight projection for the list — full profile snapshots stay on disk (revert reads them).
function listRuns(limit = 80) {
  return getRuns().slice(-limit).reverse().map((r) => ({
    id: r.id, ts: r.ts, input: r.input, instruction: r.instruction, output: r.output,
    feedback: r.feedback, refinedAt: r.refinedAt, model: r.model, refineModel: r.refineModel,
    corpus: r.corpus,
    profileBeforeLen: (r.profileBefore || '').length,
    profileAfterLen: (r.profileAfter || '').length,
    hasBefore: !!r.profileBefore, hasAfter: !!r.profileAfter,
  }));
}
function getRun(id) { return getRuns().find((r) => r.id === id) || null; }
function revertToRun(id, which = 'before') {
  const run = getRun(id);
  if (!run) throw Object.assign(new Error('run not found'), { status: 404 });
  const target = which === 'after' ? run.profileAfter : run.profileBefore;
  if (!target) throw Object.assign(new Error('no profile snapshot on that run'), { status: 400 });
  return saveProfile(target);
}

// ---------------- profile file ----------------

const SCAFFOLD = `# My writing voice

_Not built yet. Star a few letters you're proud of, or add a sample in the Voice drawer, then hit "Learn my voice." Everything below is editable — argue with it._

## Voice fingerprint
- (my actual rhythm, diction, punctuation, how I open and land — with quoted phrases)

## Signature moves & phrases
- (the constructions and phrases a reader would recognize as me)

## Good-writing rubric
- (distinctive principles I want every draft to hold — not generic writing advice)

## Anti-AI-tells (never do)
${ANTI_TELLS.map((t) => `- ${t}`).join('\n')}
`;

function getProfile() {
  try {
    const text = fs.readFileSync(PROFILE_FILE, 'utf8');
    const st = fs.statSync(PROFILE_FILE);
    return { profile: text, updatedAt: st.mtimeMs, exists: true };
  } catch {
    return { profile: SCAFFOLD, updatedAt: null, exists: false };
  }
}
function saveProfile(text) {
  fs.writeFileSync(PROFILE_FILE, String(text || ''));
  return getProfile();
}

// ---------------- OpenRouter ----------------

async function callOpenRouter(messages, apiKey, { temperature = 0.4, label = 'oneshot', model = WRITING_MODEL } = {}) {
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).'), { status: 401 });
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res, json;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'HudHub Writing',
      },
      body: JSON.stringify({ model, temperature, usage: { include: true }, messages }),
    });
    json = await res.json();
  } catch (e) {
    agentUsage.record({ surface: 'writing', model, latencyMs: Date.now() - t0, ok: false, label });
    if (e.name === 'AbortError') throw Object.assign(new Error('Writing model timed out.'), { status: 504 });
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    agentUsage.record({ surface: 'writing', model, latencyMs: Date.now() - t0, ok: false, label });
    const msg = json?.error?.message || json?.error || `OpenRouter HTTP ${res.status}`;
    throw Object.assign(new Error(String(msg)), { status: res.status });
  }
  const content = (json?.choices?.[0]?.message?.content || '').trim();
  agentUsage.record({
    surface: 'writing',
    model: json?.model || WRITING_MODEL,
    latencyMs: Date.now() - t0,
    ok: true,
    label,
    usage: json?.usage || {},
    cost: json?.usage?.cost ?? null,
    output: content,
  });
  return content;
}

// ---------------- build the profile ----------------

const BUILD_SYSTEM = `You are a forensic prose analyst building a WRITING VOICE PROFILE for a specific writer named Savar. The profile is read by an AI ghostwriter before it rewrites his drafts, and by Savar himself, who hand-edits it. It must capture what makes HIS writing recognizably his — a fingerprint, not a book report.

You are given two kinds of material:
- MINE — writing Savar actually wrote. This is the TARGET VOICE. The ghostwriter must sound like THIS.
- INSPIRATION — writers he admires. QUALITIES to aspire to, never a voice to copy. Pull only DISTINCTIVE, non-obvious principles; the output must be Savar at his best, never a pastiche of these authors.

If an EXISTING PROFILE is provided, PRESERVE any hand-written rules Savar clearly added; refine, don't discard.

METHOD — be forensic and specific. For MINE, actually measure and observe:
- Rhythm: typical sentence-length pattern and how he varies it (e.g. "runs 2-3 long clauses then snaps to a 3-word line"). Name the pattern, don't just say "varied."
- Diction & register: his actual word choices, level of formality, where he goes blunt vs. tender, technical vs. plain.
- Punctuation habits: how he really uses dashes, parentheticals, colons, fragments, line breaks — with his tendencies, not generic advice.
- Openings & closings: how he actually starts and lands a piece. Quote real examples.
- Structure: paragraph length, use of headers/lists, how he builds an argument or a reflection.
- Tics & signatures: recurring words, constructions, rhetorical moves, the way he addresses a reader.

HARD RULES:
- QUOTE verbatim from MINE constantly — every fingerprint observation should cite an actual phrase in "quotes". A profile with no quotes has failed.
- BAN generic writing-teacher advice. Never write bullets like "show don't tell", "use active voice", "vary sentence length", "be concise", "engage the reader", "concrete before abstract" as if they were HIS voice — those are universal and belong (if anywhere) only as anti-tells. If a bullet would be true of any competent writer, delete it.
- Prefer 1 sharp, specific, quoted observation over 3 vague ones. Distinctiveness over coverage.
- Describe the voice as it IS, including its rough edges — do not sand it into something smoother or more "professional."

Return GitHub-flavored markdown with EXACTLY these sections and nothing else:

# My writing voice

## Voice fingerprint
- 6-10 specific, QUOTED observations from MINE covering rhythm, diction, punctuation, openings/closings, structure, and tics. Each must be something you could only say about Savar.

## Signature moves & phrases
- 4-8 verbatim phrases, constructions, or rhetorical moves he reuses — the things a reader would recognize as "that's him." Quote them.

## Good-writing rubric
- 3-6 DISTINCTIVE principles distilled from INSPIRATION (and his own best work). Actionable and non-obvious. No platitudes.

## Anti-AI-tells (never do)
- Keep the baseline list you are given verbatim, then add any Savar-specific tells you infer (words he'd never use, moves that would ring false in his voice).

No preamble, no closing commentary. Just the markdown.`;

async function buildProfile({ apiKey } = {}) {
  const mineSamples = getSamples().filter((s) => s.kind === 'mine');
  const inspiration = getSamples().filter((s) => s.kind === 'inspiration');
  const starred = starredLetterTexts();

  const mine = [...starred, ...mineSamples.map((s) => ({ label: s.label, text: s.text }))];
  if (!mine.length && !inspiration.length) {
    throw Object.assign(new Error('Nothing to learn from yet. Star a letter or add a sample first.'), { status: 400 });
  }

  let budget = CORPUS_CAP;
  const block = (arr, header) => {
    if (!arr.length) return '';
    const parts = [header];
    for (const s of arr) {
      if (budget <= 0) break;
      const t = clip(s.text, Math.min(SAMPLE_CAP, budget));
      budget -= t.length;
      parts.push(`--- ${s.label} ---\n${t}`);
    }
    return parts.join('\n\n');
  };

  const existing = getProfile();
  const userParts = [
    block(mine, `MINE — Savar's own writing (the target voice, weight heavily):`),
    block(inspiration, `INSPIRATION — writing Savar admires (aspire to the qualities, do NOT copy the voice):`),
    `BASELINE ANTI-TELLS to keep in the third section:\n${ANTI_TELLS.map((t) => `- ${t}`).join('\n')}`,
  ];
  if (existing.exists) {
    userParts.push(`EXISTING PROFILE (preserve Savar's hand-edits):\n${clip(existing.profile, 4000)}`);
  }

  const content = await callOpenRouter([
    { role: 'system', content: BUILD_SYSTEM },
    { role: 'user', content: userParts.filter(Boolean).join('\n\n') },
  ], apiKey, { temperature: 0.3, label: 'build-profile', model: WRITING_BUILD_MODEL });

  const profile = content || SCAFFOLD;
  return saveProfile(profile);
}

// ---------------- rewrite engine (shared: Test box now; steps 2 & 3 later) ----------------

// The single biggest lever on voice fidelity is few-shot: the model must SEE Savar's actual
// prose, not just a description of it. Pick a varied, representative set of "mine" excerpts
// (research is clear that a few characteristic samples beat an exhaustive dump), newest first,
// deduped by label so we don't feed three of the same kind.
function selectRewriteExemplars() {
  const pool = [
    ...getSamples().filter((s) => s.kind === 'mine').map((s) => ({ label: s.label, text: s.text, addedAt: s.addedAt || 0 })),
    ...starredLetterTexts().map((s) => ({ label: s.label, text: s.text, addedAt: 0 })),
  ].filter((s) => String(s.text || '').trim().length > 120);
  pool.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  const out = [];
  const seenLabels = new Set();
  let budget = REWRITE_EXEMPLAR_CAP;
  for (const s of pool) {
    if (budget <= 0) break;
    const key = String(s.label || '').toLowerCase();
    if (seenLabels.has(key)) continue; // favor variety across the profile
    seenLabels.add(key);
    const t = clip(s.text, Math.min(REWRITE_PER_EXEMPLAR, budget));
    budget -= t.length;
    out.push({ label: s.label, text: t });
  }
  return out;
}

function rewriteSystem(profileText, exemplars) {
  const profile = String(profileText || '').trim() || getProfile().profile;
  const ex = Array.isArray(exemplars) ? exemplars : [];
  const exemplarBlock = ex.length
    ? `\nVERBATIM EXCERPTS OF SAVAR'S OWN WRITING — this is the texture you must match. Study the sentence rhythm, diction, punctuation, and how he lands a point. Imitate the FEEL, never lift the content:\n\n${ex.map((e) => `--- ${e.label} ---\n${e.text}`).join('\n\n')}\n`
    : '';
  return `You are Savar's ghostwriter. You rewrite prose so it reads as if HE wrote it on a good day — never like an AI, never like generic "good writing." Two references follow: a distilled voice profile, and verbatim excerpts of his actual writing. When they seem to conflict, trust the EXCERPTS — they are the ground truth; the profile is only a summary.

Do not invent facts or add ideas he didn't put there. Preserve his meaning and the structure of the input unless the instruction says otherwise. Keep it recognizably human and specific — match his real register, including where he is blunt, informal, or rough. Do not smooth him into something more polished or corporate than the excerpts show.

HARD CONSTRAINTS (always):
${ANTI_TELLS.map((t) => `- ${t}`).join('\n')}

SAVAR'S VOICE PROFILE:
${profile}
${exemplarBlock}
Return ONLY the rewritten text. No preamble, no quotes around it, no explanation.`;
}

async function rewriteSample({ text, instruction, profileOverride, apiKey } = {}) {
  const src = String(text || '').trim();
  if (!src) throw Object.assign(new Error('Nothing to rewrite.'), { status: 400 });
  const ask = String(instruction || '').trim();
  const userContent = ask
    ? `INSTRUCTION: ${ask}\n\nTEXT:\n${src}`
    : `Rewrite this in my voice:\n\n${src}`;
  // Resolve exactly what goes into this rewrite so the logged trajectory is faithful.
  const exemplars = selectRewriteExemplars();
  const profileUsed = String(profileOverride || '').trim() || getProfile().profile;
  const output = await callOpenRouter([
    { role: 'system', content: rewriteSystem(profileUsed, exemplars) },
    { role: 'user', content: userContent },
  ], apiKey, { temperature: 0.7, label: 'rewrite' });
  const stars = getStars();
  const corpus = {
    exemplars: exemplars.map((e) => ({ label: e.label, chars: e.text.length })),
    mineSamples: getSamples().filter((s) => s.kind === 'mine').length,
    inspiration: getSamples().filter((s) => s.kind === 'inspiration').length,
    starred: Object.keys(stars).filter((f) => stars[f]).length,
  };
  const run = startRun({ profileBefore: profileUsed, corpus, input: src, instruction: ask, output, model: WRITING_MODEL });
  return { output, runId: run.id };
}

// ---------------- feedback loop: fold a test critique back into the profile ----------------

const REFINE_SYSTEM = `You maintain a WRITING VOICE PROFILE for a writer named Savar. He just tested the voice — rewrote a piece of text using the current profile, read the output, and left feedback on what was off or what he wants more of. Update the profile so the NEXT rewrite reflects his feedback.

You are given: the CURRENT PROFILE, the test INPUT, the OUTPUT the ghostwriter produced, and Savar's FEEDBACK.

Rules:
- Make the SMALLEST change that captures the lesson. Edit or add a bullet or two; do not rewrite sections that the feedback doesn't touch.
- Preserve every existing section, all of Savar's hand-written rules, and the exact section structure (the "#" title and "##" headers). Keep the quoted, specific style — never introduce generic writing-teacher advice.
- Turn the feedback into a DURABLE, GENERAL rule about his voice, not a one-off note about this sentence. (e.g. "too stiff, I'd never say 'utilize'" → add "utilize" to banned words and note he favors plain verbs; NOT "avoid utilize in this paragraph".)
- If the feedback names a tell to avoid, add it under Anti-AI-tells. If it's a move he likes, sharpen Voice fingerprint or Signature moves & phrases. Quote his own words from the feedback where it helps.
- Return the FULL updated profile as GitHub-flavored markdown. No preamble, no commentary — just the profile.`;

async function refineProfileFromFeedback({ text, output, feedback, profileOverride, runId, apiKey } = {}) {
  const fb = String(feedback || '').trim();
  if (!fb) throw Object.assign(new Error('Add a comment on what to change, then apply.'), { status: 400 });
  const current = String(profileOverride || '').trim() || getProfile().profile;
  const user = [
    `CURRENT PROFILE:\n${current}`,
    text ? `TEST INPUT:\n${clip(String(text), 4000)}` : '',
    output ? `OUTPUT PRODUCED (what he's reacting to):\n${clip(String(output), 4000)}` : '',
    `SAVAR'S FEEDBACK:\n${fb}`,
  ].filter(Boolean).join('\n\n');
  const content = await callOpenRouter([
    { role: 'system', content: REFINE_SYSTEM },
    { role: 'user', content: user },
  ], apiKey, { temperature: 0.3, label: 'refine-profile', model: WRITING_REFINE_MODEL });
  const profile = content || current;
  const saved = saveProfile(profile);
  // Close the trajectory: attach the critique + resulting voice to this loop's run.
  completeRun(runId, { feedback: fb, profileAfter: saved.profile, model: WRITING_REFINE_MODEL });
  return { ...saved, runId: runId || null };
}

module.exports = {
  WRITING_MODEL,
  getProfile,
  saveProfile,
  getStars,
  setStar,
  getSamples,
  addSample,
  removeSample,
  buildProfile,
  rewriteSample,
  refineProfileFromFeedback,
  listRuns,
  getRun,
  revertToRun,
};
