// writing-pipeline.js — Idea → Article pipeline behind the WRITING tab.
//
// One JSON file IS the store (writing-projects.json, gitignored like the other
// writing stores). Each project is an Inspiration Idea routed from Ingest that
// moves: inbox -> accepted -> researching -> options -> awaiting-pick ->
// drafting -> in-review (draft lives in letters/*.md).
//
// Research is lookup-plus: multi-query fan-out over Exa (if EXA_API_KEY) with
// DuckDuckGo fallback — the same backend order as the Valinor live `lookup`
// tool — no new crawler infra. Options + draft are conditioned on the distilled
// voice profile from writing-voice.js so drafts land in the writer's voice.
// Zero npm deps — Node 22 global fetch. Required by server.js.
'use strict';

const fs = require('fs');
const path = require('path');
const agentUsage = require('./agent-usage');
const dataHome = require('./data-home');

const ROOT = __dirname;
function storePath() { return dataHome.resolveStore({ env: 'WRITING_PROJECTS_PATH', name: 'writing-projects.json', legacy: ['writing-projects.json'] }); }
const LETTERS = path.join(ROOT, 'letters');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const WRITING_MODEL =
  process.env.WRITING_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
const QUICK_MODEL =
  process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

function safeReadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.projects)) return raw;
  } catch { /* missing or corrupt — start fresh */ }
  return { projects: [] };
}
function writeStore(data) {
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
}
function newId(prefix) {
  return (prefix || 'w') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function nowIso() { return new Date().toISOString(); }
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').slice(0, 48) || 'draft';
}
function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '\n…[trimmed]' : s;
}

function listProjects() {
  return safeReadStore().projects
    .slice()
    .sort((a, b) => (b.updated || b.created || '') < (a.updated || a.created || '') ? -1 : 1);
}
function getProject(id) {
  const p = safeReadStore().projects.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error('writing project not found'), { status: 404 });
  return p;
}
function saveProject(p) {
  const data = safeReadStore();
  p.updated = nowIso();
  const i = data.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) data.projects[i] = p; else data.projects.push(p);
  writeStore(data);
  return p;
}
function pushMsg(p, role, kind, text) {
  p.thread = Array.isArray(p.thread) ? p.thread : [];
  p.thread.push({ role, kind, text: String(text || ''), ts: nowIso() });
}

// ---------------- route from ingest ----------------

function routeFromIngest(ingestId) {
  const ingest = require('./ingest-server');
  const rec = ingest.readCapture(ingestId);
  if (!rec) throw Object.assign(new Error('ingest note not found'), { status: 404 });
  const data = safeReadStore();
  const existing = data.projects.find((x) => x.ingestId === rec.id && x.status !== 'dismissed');
  if (existing) return existing;
  const meta = rec.meta || {};
  const body = String(rec.markdown || '').replace(/^---[\s\S]*?---\n/, '').trim();
  const refined = body.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 4).join('\n');
  const braindump = [meta.title ? `# ${meta.title}` : '', refined, '', meta.raw ? `Raw: ${meta.raw}` : '']
    .filter(Boolean).join('\n').trim() || body.slice(0, 2000);
  const p = {
    id: newId('w'),
    ingestId: rec.id,
    title: meta.title || rec.id,
    preview: clip(refined || body, 220),
    braindump: clip(braindump, 6000),
    status: 'inbox',
    thread: [],
    research: null,
    options: [],
    picked: null,
    draftFile: null,
    created: nowIso(),
    updated: nowIso(),
  };
  pushMsg(p, 'user', 'braindump', p.braindump);
  data.projects.push(p);
  writeStore(data);
  return p;
}

function acceptProject(id) {
  const p = getProject(id);
  if (p.status === 'inbox') p.status = 'accepted';
  return saveProject(p);
}
function dismissProject(id) {
  const p = getProject(id);
  p.status = 'dismissed';
  return saveProject(p);
}
function appendReply(id, text) {
  const clean = String(text || '').trim();
  if (!clean) throw Object.assign(new Error('empty reply'), { status: 400 });
  const p = getProject(id);
  if (p.status === 'dismissed') throw Object.assign(new Error('project is dismissed'), { status: 400 });
  pushMsg(p, 'user', 'reply', clean.slice(0, 6000));
  // A reply after options doubles as the pick/direction for the draft step.
  if (p.status === 'options' || p.status === 'awaiting-pick') {
    p.picked = clean.slice(0, 2000);
    p.status = 'awaiting-pick';
  }
  return saveProject(p);
}

// ---------------- OpenRouter ----------------

async function callOpenRouter(messages, apiKey, { model, temperature = 0.5, json = false, label = 'pipeline', timeoutMs = 90000 } = {}) {
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).'), { status: 401 });
  const useModel = model || WRITING_MODEL;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res, jsonBody;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'HudHub Writing Pipeline',
      },
      body: JSON.stringify({
        model: useModel, temperature,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        usage: { include: true }, messages,
      }),
    });
    jsonBody = await res.json();
  } catch (e) {
    agentUsage.record({ surface: 'writing-pipeline', model: useModel, latencyMs: Date.now() - t0, ok: false, label });
    if (e.name === 'AbortError') throw Object.assign(new Error('Writing pipeline timed out.'), { status: 504 });
    throw e;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    agentUsage.record({ surface: 'writing-pipeline', model: useModel, latencyMs: Date.now() - t0, ok: false, label });
    const msg = jsonBody?.error?.message || jsonBody?.error || `OpenRouter HTTP ${res.status}`;
    throw Object.assign(new Error(String(msg)), { status: res.status });
  }
  const content = (jsonBody?.choices?.[0]?.message?.content || '').trim();
  agentUsage.record({
    surface: 'writing-pipeline', model: jsonBody?.model || useModel,
    latencyMs: Date.now() - t0, ok: true, label,
    usage: jsonBody?.usage || {}, cost: jsonBody?.usage?.cost ?? null, output: content,
  });
  return content;
}

function voiceProfileText() {
  try {
    const wv = require('./writing-voice');
    return String(wv.getProfile().profile || '').slice(0, 4000);
  } catch { return ''; }
}

// ---------------- lookup-plus search (Exa → DuckDuckGo, mirrors valinor.ts) ----------------

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function decodeDdgHref(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch { /* keep */ }
  return href;
}
async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.json();
}
async function searchExa(query) {
  const key = String(process.env.EXA_API_KEY || '').trim();
  if (!key) throw new Error('no EXA_API_KEY');
  const json = await fetchJson('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, numResults: 5, contents: { highlights: { maxCharacters: 280 } } }),
  }, 8000);
  return (json.results || []).slice(0, 5).map((r) => ({
    title: String(r.title || '').slice(0, 160),
    snippet: String((r.highlights && r.highlights[0]) || r.text || '').slice(0, 280),
    url: String(r.url || ''),
  }));
}
async function searchDdg(query) {
  const out = [];
  try {
    const instant = await fetchJson(
      'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&no_redirect=1&skip_disambig=1',
      { headers: { Accept: 'application/json', 'User-Agent': 'hudhub-writing/1.0' } }, 5000);
    if (instant.AbstractText) out.push({ title: String(instant.Heading || 'DuckDuckGo').slice(0, 160), snippet: String(instant.AbstractText).slice(0, 280), url: String(instant.AbstractURL || '') });
    for (const row of [...(instant.Results || []), ...(instant.RelatedTopics || [])].slice(0, 4)) {
      if (!row || !row.Text) continue;
      out.push({ title: String(row.Text).split(' - ')[0].slice(0, 160), snippet: String(row.Text).slice(0, 280), url: String(row.FirstURL || '') });
    }
  } catch { /* fall through to HTML */ }
  if (out.length >= 3) return out.slice(0, 5);
  const htmlRes = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { Accept: 'text/html', 'User-Agent': 'hudhub-writing/1.0' }, signal: AbortSignal.timeout(7000),
  });
  if (!htmlRes.ok) throw new Error('ddg HTML HTTP ' + htmlRes.status);
  const html = await htmlRes.text();
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/)/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    const title = stripTags(m[2]).slice(0, 160);
    if (!title) continue;
    out.push({ title, snippet: stripTags(m[3] || '').slice(0, 280), url: decodeDdgHref(m[1]) });
  }
  return out.slice(0, 5);
}
async function webSearch(query) {
  if (String(process.env.EXA_API_KEY || '').trim()) {
    try {
      const hits = await searchExa(query);
      if (hits.length) return { backend: 'exa', results: hits };
    } catch (e) {
      console.warn('[writing-pipeline] Exa failed, falling back:', String((e && e.message) || e).slice(0, 160));
    }
  }
  return { backend: 'duckduckgo', results: await searchDdg(query) };
}

function tierSource(url, title) {
  const u = String(url || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  if (/\.gov|\.edu|arxiv\.org|pubmed|doi\.org|\.pdf$|nature\.com|science\.org|jstor|nber|fred\.|worldbank|ourworldindata/.test(u)) return 'primary';
  if (/study|survey|report|census|dataset|data|paper|trial|review|meta-analysis/.test(t)) return 'primary';
  return 'secondary';
}

// ---------------- research ----------------

const QUERY_GEN_SYSTEM = `You turn a rough writing idea into web search queries. Return STRICT JSON only, no prose: { "queries": ["...", ...] }. 4-6 queries: cover definitions/background, real data and statistics, primary sources (papers, reports, datasets), and counterarguments or criticism. Each query <=12 words.`;

async function runResearch(id, apiKey) {
  const p = getProject(id);
  if (p.status === 'dismissed') throw Object.assign(new Error('project is dismissed'), { status: 400 });
  p.status = 'researching';
  saveProject(p);

  const qRaw = await callOpenRouter([
    { role: 'system', content: QUERY_GEN_SYSTEM },
    { role: 'user', content: `IDEA:\n${clip(p.braindump, 3000)}` },
  ], apiKey, { model: QUICK_MODEL, temperature: 0.4, json: true, label: 'research-queries', timeoutMs: 45000 });
  let queries = [];
  try { queries = JSON.parse(qRaw).queries || []; } catch { queries = []; }
  queries = queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 6);
  if (!queries.length) queries = [p.title, p.title + ' data statistics', p.title + ' criticism'];

  const settled = await Promise.allSettled(queries.map((q) => webSearch(q)));
  const seen = new Set();
  const sources = [];
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const h of (r.value.results || [])) {
      const url = String(h.url || '').trim();
      if (!url || seen.has(url.toLowerCase())) continue;
      seen.add(url.toLowerCase());
      sources.push({ title: h.title || url, snippet: h.snippet || '', url, tier: tierSource(url, h.title), query: queries[i] });
      if (sources.length >= 12) break;
    }
  });

  p.research = { queries, sources, backend: String(process.env.EXA_API_KEY || '').trim() ? 'exa' : 'duckduckgo', ranAt: nowIso() };
  p.status = 'options-pending';
  const primary = sources.filter((s) => s.tier === 'primary');
  const secondary = sources.filter((s) => s.tier !== 'primary');
  const fmt = (s) => `- [${s.title}](${s.url}) — ${s.snippet}`;
  pushMsg(p, 'assistant', 'research',
    `## Research brief\n\n**Queries:** ${queries.join(' · ')}\n\n### Primary sources\n${primary.length ? primary.map(fmt).join('\n') : '_none found — ask me to dig on a specific angle_'}\n\n### Secondary sources\n${secondary.length ? secondary.map(fmt).join('\n') : '_none_'}\n\nReply with what resonates, or hit **Plan options** next.`);
  return saveProject(p);
}

function researchBriefText(p) {
  if (!p.research || !Array.isArray(p.research.sources)) return '(no research yet)';
  return p.research.sources.map((s) => `- [${s.tier}] ${s.title} (${s.url}): ${s.snippet}`).join('\n');
}

// ---------------- options (theses + structures) ----------------

const OPTIONS_SYSTEM = `You plan an article for a specific writer. Given his raw idea, a research brief, and his voice profile, propose 2-3 distinct theses with structures. Concrete and opinionated — no both-sides mush. Return STRICT JSON only, no prose: { "options": [ { "thesis": "one sharp sentence", "structure": ["section 1 — what it does", ...4-6 sections], "why": "one sentence on why this angle fits him" } ] }.`;

async function runOptions(id, apiKey) {
  const p = getProject(id);
  if (p.status === 'dismissed') throw Object.assign(new Error('project is dismissed'), { status: 400 });
  const content = await callOpenRouter([
    { role: 'system', content: OPTIONS_SYSTEM },
    { role: 'user', content: `IDEA:\n${clip(p.braindump, 3000)}\n\nRESEARCH:\n${clip(researchBriefText(p), 4000)}\n\nVOICE (match the attitude, stay concrete):\n${clip(voiceProfileText(), 2000)}` },
  ], apiKey, { temperature: 0.7, json: true, label: 'plan-options' });
  let options = [];
  try { options = JSON.parse(content).options || []; } catch { options = []; }
  options = options.filter((o) => o && o.thesis).slice(0, 3).map((o) => ({
    thesis: String(o.thesis).slice(0, 400),
    structure: Array.isArray(o.structure) ? o.structure.map((s) => String(s).slice(0, 200)).slice(0, 7) : [],
    why: String(o.why || '').slice(0, 300),
  }));
  if (!options.length) throw Object.assign(new Error('planner returned nothing usable — try again'), { status: 502 });
  p.options = options;
  p.status = 'awaiting-pick';
  const fmt = (o, i) => `### Option ${i + 1}: ${o.thesis}\n${o.structure.map((s) => `- ${s}`).join('\n')}\n_${o.why}_`;
  pushMsg(p, 'assistant', 'options',
    `## Thesis options\n\nPick one, combine them, or redirect me in your own words — text or voice note. Then hit **Draft**.\n\n${options.map(fmt).join('\n\n')}`);
  return saveProject(p);
}

// ---------------- draft ----------------

function draftSystem() {
  const profile = voiceProfileText();
  return `You ghostwrite a full article in the writer's voice — never like an AI. Follow the picked thesis and structure. Use the research for facts and cite sources inline as [title](url) links where load-bearing. Do not invent statistics, quotes, or studies.

HARD CONSTRAINTS (always):
- No "it's not just X, it's Y" / "not only... but also" cadence.
- No tidy rule-of-three tricolons as filler.
- Em dashes sparingly. Vary sentence length.
- No throat-clearing openers ("In today's world", "When it comes to").
- No summary bow ("In conclusion", "Ultimately").
- Banned words: delve, holistic, robust, leverage, journey, tapestry, testament, realm.
- Concrete nouns and verbs over abstractions. Cut hedges.

WRITER'S VOICE PROFILE:
${profile}

Return ONLY the article as GitHub-flavored markdown starting with an # title. No preamble.`;
}

async function runDraft(id, apiKey) {
  const p = getProject(id);
  if (p.status === 'dismissed') throw Object.assign(new Error('project is dismissed'), { status: 400 });
  const direction = p.picked
    || (p.thread || []).filter((m) => m.role === 'user' && m.kind === 'reply').map((m) => m.text).join('\n')
    || 'Use the first thesis option.';
  const firstOpt = p.options && p.options[0];
  p.status = 'drafting';
  saveProject(p);

  const md = await callOpenRouter([
    { role: 'system', content: draftSystem() },
    { role: 'user', content: `IDEA:\n${clip(p.braindump, 3000)}\n\nRESEARCH:\n${clip(researchBriefText(p), 4000)}\n\nTHESIS OPTIONS:\n${clip(JSON.stringify(p.options || firstOpt || []), 3000)}\n\nWRITER'S DIRECTION (follow this — it overrides the options):\n${clip(direction, 2000)}\n\nWrite the article now.` },
  ], apiKey, { temperature: 0.6, label: 'draft', timeoutMs: 120000 });

  if (!fs.existsSync(LETTERS)) fs.mkdirSync(LETTERS, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const file = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${slugify(p.title)}-${Date.now().toString(36)}.md`;
  fs.writeFileSync(path.join(LETTERS, file), md.trim() + '\n', 'utf8');

  p.draftFile = file;
  p.status = 'in-review';
  pushMsg(p, 'assistant', 'draft',
    `## Draft ready\n\nSaved as **${file}** — hit **Open in editor** to read end-to-end and make line edits. Reply here with per-line fixes and I'll rewrite just those lines in your voice.`);
  return saveProject(p);
}

module.exports = {
  storePath,
  listProjects,
  getProject,
  routeFromIngest,
  acceptProject,
  dismissProject,
  appendReply,
  runResearch,
  runOptions,
  runDraft,
};
