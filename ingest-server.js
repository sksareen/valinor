// ingest-server.js — the capture store + refine-to-plan turn.
//
// One folder of markdown files IS the store. The voice bubble writes here, Apple Notes
// (later) dumps here, Obsidian points a vault here, and the HudHub ingest view reads it.
// Default: the user data home's ingest/ dir (override with INGEST_DIR).
// Personal capture data stays out of git by construction.
const fs = require('fs');
const path = require('path');
const dataHome = require('./data-home');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const agentUsage = require('./agent-usage');
// Refine+plan is a light task — the repo's proven-working model. Override via env.
const CAPTURE_MODEL =
  process.env.OPENROUTER_CAPTURE_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

// Capture store home: INGEST_DIR, then the user data home. Outside the repo.
const INGEST_DIR =
  process.env.INGEST_DIR || path.join(dataHome.dataDir(), 'ingest');

function ensureDir() {
  fs.mkdirSync(INGEST_DIR, { recursive: true });
  return INGEST_DIR;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48) || 'note';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ---- markdown <-> object -------------------------------------------------
function toMarkdown({ id, created, source, title, refined, plan, nextAction, raw, image, tags }) {
  const steps = Array.isArray(plan) ? plan : [];
  const tagList = Array.isArray(tags) && tags.length ? tags : ['ingest'];
  const fm = [
    '---',
    `id: ${id}`,
    `created: ${created}`,
    `source: ${source || 'voice'}`,
    `title: ${JSON.stringify(title || 'Untitled capture')}`,
    image ? `image: ${JSON.stringify(image)}` : null,
    `tags: [${tagList.join(', ')}]`,
    '---',
    '',
  ].filter((l) => l != null).join('\n');
  const body = [
    `# ${title || 'Untitled capture'}`,
    '',
    image ? `![screenshot](${image})` : '',
    image ? '' : '',
    (refined || '').trim(),
    '',
    steps.length ? '## Plan' : '',
    ...steps.map((s) => `- ${String(s).trim()}`),
    steps.length ? '' : '',
    nextAction ? `**Next:** ${String(nextAction).trim()}` : '',
    '',
    raw ? '---' : '',
    raw ? '### Raw capture' : '',
    ...String(raw || '').trim().split('\n').filter(Boolean).map((l) => `> ${l}`),
    '',
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
  return fm + body;
}

// Minimal frontmatter reader — enough for the list/preview view.
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta = {};
  let body = text;
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      let v = kv[2].trim();
      try { if (v.startsWith('"')) v = JSON.parse(v); } catch (e) {}
      meta[kv[1]] = v;
    }
  }
  return { meta, body };
}

function writeCapture(obj) {
  ensureDir();
  const created = obj.created || new Date().toISOString();
  const id = obj.id || `${stamp(new Date(created))}-${slugify(obj.title || obj.raw)}`;
  const rec = { source: 'voice', ...obj, id, created };
  const file = path.join(INGEST_DIR, `${id}.md`);
  fs.writeFileSync(file, toMarkdown(rec), 'utf8');
  return { id, path: file, created };
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

function imagePathFor(id, ext) {
  const safe = path.basename(String(id || '')).replace(/\.(md|png|jpe?g|webp)$/i, '');
  const e = ext && IMAGE_EXTS.includes(ext.toLowerCase()) ? ext.toLowerCase() : '.jpg';
  return path.join(INGEST_DIR, `${safe}${e === '.jpeg' ? '.jpg' : e}`);
}

function findImageFor(id) {
  const safe = path.basename(String(id || '')).replace(/\.(md|png|jpe?g|webp)$/i, '');
  if (!safe) return null;
  for (const ext of ['.jpg', '.png', '.webp', '.jpeg']) {
    const p = path.join(INGEST_DIR, `${safe}${ext === '.jpeg' ? '.jpg' : ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Persist a cursor-tool screenshot + summary into the ingest vault. */
function writeCursorCapture({ imageBuf, mime, summary, context } = {}) {
  ensureDir();
  if (!imageBuf || !imageBuf.length) {
    const e = new Error('empty screenshot');
    e.status = 400;
    throw e;
  }
  const created = new Date().toISOString();
  const ctx = context || {};
  const tab = String(ctx.activeTab || ctx.activeKey || ctx.panel || '').trim();
  const tool = String(ctx.tool || 'pen').trim();
  const sum = String(summary || '').replace(/\s+/g, ' ').trim();
  const titleBits = ['Cursor'];
  if (tab) titleBits.push(tab);
  else if (tool && tool !== 'pen') titleBits.push(tool);
  const title = titleBits.join(' · ');
  const id = `${stamp(new Date(created))}-${slugify(title)}`;
  const ext = /png/i.test(mime || '') ? '.png' : /webp/i.test(mime || '') ? '.webp' : '.jpg';
  const imgName = `${id}${ext}`;
  const imgPath = path.join(INGEST_DIR, imgName);
  fs.writeFileSync(imgPath, imageBuf);
  const rawBits = [
    tab ? `tab: ${tab}` : null,
    tool ? `tool: ${tool}` : null,
    ctx.pointLabel ? `point: ${ctx.pointLabel}` : null,
    ctx.trailLine || null,
    ctx.rectLine || null,
  ].filter(Boolean);
  const saved = writeCapture({
    id,
    created,
    source: 'cursor',
    title,
    refined: sum || title,
    plan: [],
    nextAction: '',
    raw: rawBits.join('\n'),
    image: imgName,
    tags: ['ingest', 'cursor'],
  });
  return { ...saved, image: imgName, imagePath: imgPath };
}

function listCaptures(limit = 100) {
  ensureDir();
  // Filenames don't sort chronologically (apple-<hash> is random order), so parse each
  // file's `created` and sort by that, newest first — THEN cap to the limit.
  const items = fs
    .readdirSync(INGEST_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = fs.readFileSync(path.join(INGEST_DIR, f), 'utf8');
      const { meta, body } = parseFrontmatter(text);
      const preview = body
        .replace(/^#.*$/m, '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/[#>*`-]/g, '')
        .trim()
        .slice(0, 180);
      const created = meta.created || null;
      const ts = created ? Date.parse(created) : NaN;
      const id = meta.id || f.replace(/\.md$/, '');
      const imgPath = findImageFor(id);
      const image = meta.image || (imgPath ? path.basename(imgPath) : null);
      return {
        id,
        title: meta.title || f,
        created,
        source: meta.source || 'voice',
        preview,
        image: image || null,
        _ts: Number.isNaN(ts) ? -Infinity : ts, // undated sinks to the bottom
      };
    });
  items.sort((a, b) => b._ts - a._ts);
  return items.slice(0, limit).map(({ _ts, ...rest }) => rest);
}

function readCapture(id) {
  ensureDir();
  const safe = path.basename(String(id || '')).replace(/\.md$/, '');
  const file = path.join(INGEST_DIR, `${safe}.md`);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const { meta } = parseFrontmatter(text);
  const imageFile = meta.image || null;
  const found = imageFile ? null : findImageFor(safe);
  const image = imageFile || (found ? path.basename(found) : null);
  return {
    id: safe,
    meta: { ...meta, image },
    markdown: text,
    imageUrl: image ? `/api/ingest/media?id=${encodeURIComponent(safe)}` : null,
  };
}

function readMedia(id) {
  ensureDir();
  const file = findImageFor(id);
  if (!file) return null;
  return serveFile(file);
}

// Serve a per-digest staged file (e.g. iMessage attachments <id>-<rowid>-<i>.<ext>).
// The name must carry the digest id as prefix so one capture can never read another's files.
function readMediaFile(id, file) {
  ensureDir();
  const safe = path.basename(String(id || '')).replace(/\.md$/, '');
  const base = path.basename(String(file || ''));
  if (!safe || !base || !base.startsWith(safe + '-')) return null;
  const full = path.join(INGEST_DIR, base);
  if (!full.startsWith(INGEST_DIR + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return serveFile(full);
}

function serveFile(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : ext === '.mov' ? 'video/quicktime'
    : ext === '.mp4' || ext === '.m4v' ? 'video/mp4'
    : ext === '.m4a' ? 'audio/mp4'
    : ext === '.mp3' ? 'audio/mpeg'
    : 'image/jpeg';
  return { path: file, mime, buffer: fs.readFileSync(file) };
}

function deleteCapture(id) {
  ensureDir();
  const safe = path.basename(String(id || '')).replace(/\.md$/, '');
  if (!safe) return false;
  const file = path.join(INGEST_DIR, `${safe}.md`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  const img = findImageFor(safe);
  if (img) {
    try { fs.unlinkSync(img); } catch { /* ignore */ }
  }
  // staged per-digest files (e.g. iMessage attachments <id>-<rowid>-<i>.<ext>)
  try {
    for (const f of fs.readdirSync(INGEST_DIR)) {
      if (f.startsWith(safe + '-')) { try { fs.unlinkSync(path.join(INGEST_DIR, f)); } catch {} }
    }
  } catch { /* ignore */ }
  return true;
}

// ---- OpenRouter JSON call (shared by refine + enhance) -------------------
async function callOpenRouter(messages, apiKey, { temperature = 0.3, label = 'refine' } = {}) {
  if (!apiKey) {
    const err = new Error('OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).');
    err.status = 500;
    throw err;
  }
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
        'X-Title': 'HudHub Ingest',
      },
      body: JSON.stringify({
        model: CAPTURE_MODEL,
        temperature,
        response_format: { type: 'json_object' },
        usage: { include: true },
        messages,
      }),
    });
    json = await res.json();
  } finally {
    clearTimeout(t);
  }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    agentUsage.record({ surface: 'ingest', model: CAPTURE_MODEL, latencyMs, ok: false, label });
    const msg = json?.error?.message || json?.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  const content = json?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); } catch (e) { parsed = {}; }
  const usage = json?.usage || {};
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const inText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.map((p) => p.text || (p.image_url ? '[image]' : '')).join(' ')
      : '';
  agentUsage.record({
    surface: 'ingest', model: json?.model || CAPTURE_MODEL, latencyMs, usage,
    cost: usage.cost ?? null, ok: true, label,
    input: inText,
    output: content,
  });
  return { parsed, model: json?.model || CAPTURE_MODEL };
}

// ---- refine: raw transcript -> {title, refined} (a clean NOTE, no plan) ---
// The tangible-outcome ("plan") step is deliberately NOT done here — it's on demand
// via enhance() from the ingest detail view. Capture stays a clean note.
const REFINE_PROMPT = `You clean up a raw voice transcript into a usable note.
The transcript comes from speech-to-text, so fix obvious mis-hearings, punctuation, and run-ons —
but keep the speaker's voice, intent, and specifics. Do not invent facts, tasks, or next steps.

Return STRICT JSON only, no prose, with this shape:
{
  "title": "<=8 words capturing the core idea",
  "refined": "the cleaned-up thought, 1-4 tight sentences"
}`;

async function refine(text, history, apiKey) {
  const messages = [{ role: 'system', content: REFINE_PROMPT }];
  for (const h of (history || []).slice(-6)) {
    if (h && h.role && h.content) messages.push({ role: h.role, content: String(h.content) });
  }
  messages.push({ role: 'user', content: String(text || '').trim() });
  const { parsed, model } = await callOpenRouter(messages, apiKey);
  return {
    title: parsed.title || (String(text).trim().split(/\s+/).slice(0, 8).join(' ') || 'Capture'),
    refined: parsed.refined || String(text).trim(),
    model,
  };
}

// ---- caption an image so the agent can find it later by content ----------
const CAPTION_SYSTEM = `You caption an image so it can be found later by search.
Read any visible text in the image. Be concrete and specific; do not speculate wildly.
Return STRICT JSON only, no prose, with this shape:
{
  "title": "<=8 words naming what this is",
  "description": "2-4 sentences: what's shown, key visible text, and why it might matter",
  "tags": ["3-6", "lowercase", "keywords"]
}`;

// buffer = raw image bytes; mime like 'image/png'. hint is optional context (filename, date).
async function captionImage({ buffer, mime, hint }, apiKey) {
  if (!apiKey) {
    const err = new Error('OPENROUTER_API_KEY is missing — add it to .env (https://openrouter.ai/keys).');
    err.status = 500;
    throw err;
  }
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const userText = hint ? `Context: ${hint}. Caption the image.` : 'Caption the image.';
  const t0 = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45000);
  let res, json;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'HudHub Ingest',
      },
      body: JSON.stringify({
        model: CAPTURE_MODEL,
        temperature: 0.2,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        usage: { include: true },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `${CAPTION_SYSTEM}\n\n${userText}` },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    });
    json = await res.json();
  } finally {
    clearTimeout(t);
  }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    agentUsage.record({ surface: 'ingest', model: CAPTURE_MODEL, latencyMs, ok: false, label: 'caption' });
    const msg = json?.error?.message || json?.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  const usage = json?.usage || {};
  let parsed;
  try { parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}'); } catch (e) { parsed = {}; }
  agentUsage.record({
    surface: 'ingest', model: json?.model || CAPTURE_MODEL, latencyMs, usage,
    cost: usage.cost ?? null, ok: true, label: 'caption',
    input: hint || '[image]',
    output: parsed.description || parsed.title || '',
  });
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean).slice(0, 6)
    : [];
  return {
    title: (parsed.title || '').trim(),
    description: (parsed.description || '').trim(),
    tags,
    model: json?.model || CAPTURE_MODEL,
  };
}

// One shot: refine the raw text into a clean note, persist it, return the record.
async function capture({ text, history, source }, apiKey) {
  const raw = String(text || '').trim();
  if (!raw) { const e = new Error('empty capture'); e.status = 400; throw e; }
  const r = await refine(raw, history, apiKey);
  const created = new Date().toISOString();
  const saved = writeCapture({
    created,
    source: source || 'voice',
    title: r.title,
    refined: r.refined,
    plan: [],
    nextAction: '',
    raw,
  });
  return { ...saved, ...r, raw };
}

// ---- enhance: a saved note -> one tangible outcome (the PLAN step, on demand) ----
const ENHANCE_PROMPT = `You read a captured note and propose ONE tangible outcome the person
can complete in a single sitting — either a planning step or an execution step. It must be
concrete and provable (a message sent, a doc written, a tweet posted, a decision recorded).
Do not invent facts beyond the note. Prefer the smallest real move that creates momentum.

Return STRICT JSON only, no prose, with this shape:
{
  "outcome": "the one tangible outcome, phrased as a doable action (<=20 words)",
  "why": "one short sentence on why this is the right next move"
}`;

async function enhance(id, apiKey) {
  const rec = readCapture(id);
  if (!rec) { const e = new Error('note not found'); e.status = 404; throw e; }
  const { meta, markdown } = rec;
  const body = parseFrontmatter(markdown).body.replace(/\s+/g, ' ').trim().slice(0, 2000);
  const noteText = `Title: ${meta.title || id}\n\n${body}`;
  const messages = [
    { role: 'system', content: ENHANCE_PROMPT },
    { role: 'user', content: noteText },
  ];
  const { parsed, model } = await callOpenRouter(messages, apiKey, { temperature: 0.4, label: 'enhance' });
  return {
    id: rec.id,
    title: meta.title || rec.id,
    outcome: parsed.outcome || '',
    why: parsed.why || '',
    model,
  };
}

module.exports = {
  INGEST_DIR,
  CAPTURE_MODEL,
  ensureDir,
  capture,
  enhance,
  captionImage,
  writeCapture,
  writeCursorCapture,
  listCaptures,
  readCapture,
  readMedia,
  readMediaFile,
  deleteCapture,
};
