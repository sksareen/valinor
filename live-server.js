// Live companion: webcam tick router (cheap OpenRouter) + spoken turns via Pi (live-pi.mjs).
// Tick path stays zero extra deps (Node 22 fetch). Spoken path lazy-loads the Pi SDK.
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
const HISTORY_FOR_CLIENT = 40;

const ROUTER_SYSTEM = `You watch a live webcam tick of Savar (his name is Savar — never "that person"). You also get a short hub digest.

Default to SKIP. Silence is correct. Only speak when something is clearly worth interrupting him for — a real change, a concrete observation that helps him right now, or something in the hub digest that matters in this moment.

SKIP for: still/unchanged scenes, vague vibes, filler ("looking focused", "still coding"), repeating yourself or paraphrasing recent lines you already said, narrating that he is looking at the camera / still there / unchanged, narrating the obvious, or anything you are not sure about.

If you speak: exactly 1 short spoken sentence — no quotes, no lists, no SKIP elsewhere. Address him as Savar or you.`;

const DIGEST_MAX = 800;

const GEO_TTL_MS = 60 * 60 * 1000;
const CLIENT_GEO_TTL_MS = 24 * 60 * 60 * 1000;
let ipGeoCache = { at: 0, data: null };
let clientGeo = { at: 0, latitude: null, longitude: null };

/** IANA zone → a representative city (last-resort coords when GPS is missing). */
const TZ_ANCHORS = {
  'America/Los_Angeles': { city: 'Los Angeles', region: 'California', region_code: 'CA', country_code: 'US', latitude: 34.0522, longitude: -118.2437 },
  'America/Vancouver': { city: 'Vancouver', region: 'British Columbia', region_code: 'BC', country_code: 'CA', latitude: 49.2827, longitude: -123.1207 },
  'America/Denver': { city: 'Denver', region: 'Colorado', region_code: 'CO', country_code: 'US', latitude: 39.7392, longitude: -104.9903 },
  'America/Phoenix': { city: 'Phoenix', region: 'Arizona', region_code: 'AZ', country_code: 'US', latitude: 33.4484, longitude: -112.074 },
  'America/Chicago': { city: 'Chicago', region: 'Illinois', region_code: 'IL', country_code: 'US', latitude: 41.8781, longitude: -87.6298 },
  'America/New_York': { city: 'New York', region: 'New York', region_code: 'NY', country_code: 'US', latitude: 40.7128, longitude: -74.006 },
  'America/Anchorage': { city: 'Anchorage', region: 'Alaska', region_code: 'AK', country_code: 'US', latitude: 61.2181, longitude: -149.9003 },
  'Pacific/Honolulu': { city: 'Honolulu', region: 'Hawaii', region_code: 'HI', country_code: 'US', latitude: 21.3069, longitude: -157.8583 },
  'America/Toronto': { city: 'Toronto', region: 'Ontario', region_code: 'ON', country_code: 'CA', latitude: 43.6532, longitude: -79.3832 },
  'Europe/London': { city: 'London', region: 'England', region_code: null, country_code: 'GB', latitude: 51.5074, longitude: -0.1278 },
  'UTC': { city: null, region: null, region_code: null, country_code: null, latitude: null, longitude: null },
};

function osTimeZone() {
  try {
    const envTz = String(process.env.TZ || '').trim();
    if (envTz.includes('/')) return envTz;
  } catch { /* ignore */ }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function reportClientGeo(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  clientGeo = { at: Date.now(), latitude, longitude };
  return true;
}

async function fetchIpGeo() {
  if (ipGeoCache.data && Date.now() - ipGeoCache.at < GEO_TTL_MS) {
    return ipGeoCache.data;
  }
  const upstream = await fetch('https://ipapi.co/json/', {
    headers: { 'User-Agent': 'valinor-hub/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!upstream.ok) throw new Error('geo HTTP ' + upstream.status);
  const json = await upstream.json();
  if (json.error) throw new Error(json.reason || json.error);
  const lat = Number(json.latitude);
  const lng = Number(json.longitude);
  const data = {
    ip: json.ip || null,
    city: json.city || null,
    region: json.region || null,
    region_code: json.region_code || null,
    country: json.country_code || json.country || null,
    country_code: json.country_code || json.country || null,
    timezone: json.timezone || null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
  };
  ipGeoCache = { at: Date.now(), data };
  return data;
}

/**
 * Place for Val / hub clock. Timezone is always this machine's OS zone.
 * Coords: browser GPS > IP (only if IP timezone matches OS) > timezone city.
 */
async function getHubGeo() {
  const timezone = osTimeZone();
  let ip = null;
  let ipError = null;
  try {
    ip = await fetchIpGeo();
  } catch (e) {
    ip = ipGeoCache.data;
    ipError = String(e.message || e);
  }
  const ipTz = ip && String(ip.timezone || '').trim();
  const ipAgrees = !!(ipTz && ipTz === timezone);
  const clientFresh =
    clientGeo.at &&
    Date.now() - clientGeo.at < CLIENT_GEO_TTL_MS &&
    Number.isFinite(clientGeo.latitude) &&
    Number.isFinite(clientGeo.longitude);

  let latitude = null;
  let longitude = null;
  let source = 'os';
  let approximate = true;
  const anchor = TZ_ANCHORS[timezone] || null;

  if (clientFresh) {
    latitude = clientGeo.latitude;
    longitude = clientGeo.longitude;
    source = 'browser';
    approximate = false;
  } else if (ipAgrees && ip && Number.isFinite(ip.latitude) && Number.isFinite(ip.longitude)) {
    latitude = ip.latitude;
    longitude = ip.longitude;
    source = 'ip';
    approximate = true;
  } else if (anchor && Number.isFinite(anchor.latitude) && Number.isFinite(anchor.longitude)) {
    latitude = anchor.latitude;
    longitude = anchor.longitude;
    source = 'timezone';
    approximate = true;
  }

  let city = null;
  let region = null;
  let region_code = null;
  let country = null;
  let country_code = null;
  if (ipAgrees && ip) {
    city = ip.city;
    region = ip.region;
    region_code = ip.region_code;
    country = ip.country || ip.country_code;
    country_code = ip.country_code || ip.country;
  } else if (anchor) {
    city = anchor.city;
    region = anchor.region;
    region_code = anchor.region_code;
    country = anchor.country_code;
    country_code = anchor.country_code;
  }

  const notes = [];
  if (ipTz && ipTz !== timezone) {
    notes.push('Clock uses this Mac timezone; IP geo timezone (' + ipTz + ') was ignored.');
  }
  if (source === 'timezone') {
    notes.push('Location is approximate (major city for OS timezone). Browser GPS not available.');
  } else if (source === 'ip') {
    notes.push('Coordinates from IP geolocation (same timezone as this Mac).');
  } else if (source === 'browser') {
    notes.push('Coordinates from browser geolocation.');
  }
  if (ipError && !ip) notes.push('IP geo: ' + ipError);

  return {
    ip: (ip && ip.ip) || null,
    city,
    region,
    region_code,
    country,
    country_code,
    timezone,
    os_timezone: timezone,
    ip_timezone: ipTz || null,
    latitude,
    longitude,
    source,
    approximate,
    note: notes.join(' ') || null,
    local: true,
    error: ipError && !ip ? ipError : undefined,
  };
}

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

// ---- conversations: thread the flat session log into topics + imports ----
const CONVOS_CANDIDATES = [
  process.env.LIVE_CONVOS_PATH,
  path.join(__dirname, 'live-conversations.json'),
  path.join(os.homedir(), '.handviz', 'live-conversations.json'),
  path.join(os.tmpdir(), 'handviz-live-conversations.json'),
].filter(Boolean);
let convosPath = CONVOS_CANDIDATES[0];
let convos = []; // [{id,title,source,sourceDetail,createdAt,updatedAt,count}]
let activeConversationId = null;
let pendingSeed = null; // {title, transcript} — consumed once by the next spoken turn

function newConvoId() {
  return 'lc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function convoTitleFor(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Live session';
  return s.length > 64 ? s.slice(0, 64).trimEnd() + '…' : s;
}

function saveConvos() {
  if (!persistOk) return;
  try {
    ensureDir(convosPath);
    fs.writeFileSync(convosPath, JSON.stringify(convos, null, 2), 'utf8');
  } catch { /* keep in-memory */ }
}

function loadConvos() {
  for (const p of CONVOS_CANDIDATES) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(raw)) {
        convosPath = p;
        convos = raw.filter((c) => c && c.id);
        return;
      }
    } catch { /* try next */ }
  }
}

function ensureActiveConvo() {
  if (activeConversationId && convos.some((c) => c.id === activeConversationId)) {
    return activeConversationId;
  }
  if (!convos.length) {
    const now = Date.now();
    const seedCount = memory.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).length;
    const firstUser = memory.find((m) => m && m.role === 'user');
    convos.push({
      id: newConvoId(),
      title: firstUser ? convoTitleFor(firstUser.text) : 'Live session',
      source: 'live',
      sourceDetail: null,
      createdAt: now,
      updatedAt: now,
      count: seedCount,
    });
    saveConvos();
  }
  // Adopt legacy entries (no `c`) into the oldest conversation so history survives.
  const oldest = convos.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  activeConversationId = (convos.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || oldest).id;
  return activeConversationId;
}

function touchConvo(id, title) {
  const c = convos.find((x) => x.id === id);
  if (!c) return;
  c.updatedAt = Date.now();
  c.count = memory.filter((m) => m && (m.c === id || (!m.c && id === legacyConvoId())) &&
    (m.role === 'user' || m.role === 'assistant')).length;
  if (title && (c.title === 'Live session' || c.title === 'New conversation')) c.title = title;
  saveConvos();
}

function legacyConvoId() {
  const oldest = convos.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  return oldest ? oldest.id : null;
}

function messagesFor(id) {
  const legacy = legacyConvoId();
  return memory.filter((m) => m && (m.c === id || (!m.c && id === legacy)));
}

function setPendingSeed(seed) {
  pendingSeed = seed && seed.transcript ? seed : null;
}

function consumeSeed() {
  const s = pendingSeed;
  pendingSeed = null;
  return s;
}

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
  const e = entry && typeof entry === 'object' ? entry : { t: Date.now(), text: String(entry || '') };
  if (!e.c) {
    try { e.c = ensureActiveConvo(); } catch { /* ok */ }
  }
  memory.push(e);
  if (memory.length > HISTORY_FOR_CLIENT * 4) {
    memory.splice(0, memory.length - HISTORY_FOR_CLIENT * 2);
  }
  try {
    const owner = convos.find((x) => x.id === e.c);
    if (owner) {
      owner.updatedAt = Date.now();
      if (e.role === 'user' || e.role === 'assistant') {
        owner.count = (owner.count || 0) + 1;
        if ((owner.title === 'Live session' || owner.title === 'New conversation') && e.role === 'user' && e.text) {
          owner.title = convoTitleFor(e.text);
        }
      }
      saveConvos();
    }
  } catch { /* ok */ }
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
  try {
    const id = ensureActiveConvo();
    const rows = messagesFor(id).slice(-HISTORY_FOR_CLIENT);
    if (rows.length) return rows;
  } catch { /* fall through */ }
  return memory.slice(-HISTORY_FOR_CLIENT);
}

function listLiveConversations() {
  try { ensureActiveConvo(); } catch { /* ok */ }
  return convos
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((c) => ({
      id: c.id,
      title: c.title || 'Live session',
      source: c.source || 'live',
      sourceDetail: c.sourceDetail || null,
      updatedAt: c.updatedAt || c.createdAt || Date.now(),
      createdAt: c.createdAt || c.updatedAt || Date.now(),
      count: c.count != null ? c.count : messagesFor(c.id).filter((m) => m.role === 'user' || m.role === 'assistant').length,
      active: c.id === activeConversationId,
    }));
}

function getLiveConversation(id) {
  const c = convos.find((x) => x.id === id);
  if (!c) return null;
  return { ...c, messages: messagesFor(id) };
}

async function resetPiSession() {
  if (!livePiPromise) return;
  try {
    const pi = await livePiPromise;
    if (pi && typeof pi.resetSession === 'function') pi.resetSession();
  } catch { /* ok */ }
}

/** Start a fresh live thread (history preserved, Pi context reset). */
async function newLiveConversation(title) {
  const now = Date.now();
  const c = {
    id: newConvoId(),
    title: String(title || '').trim() || 'New conversation',
    source: 'live',
    sourceDetail: null,
    createdAt: now,
    updatedAt: now,
    count: 0,
  };
  convos.push(c);
  activeConversationId = c.id;
  pendingSeed = null;
  saveConvos();
  await resetPiSession();
  return { ...c, messages: [] };
}

/** Switch the active thread; seeds the Pi with that thread's transcript. */
async function switchLiveConversation(id) {
  const c = convos.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error('conversation not found'), { status: 404 });
  activeConversationId = id;
  const msgs = messagesFor(id)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .slice(-30);
  const transcript = msgs
    .map((m) => (m.role === 'user' ? 'Savar: ' : 'Val: ') + String(m.text || '').trim())
    .join('\n').slice(-6000);
  pendingSeed = transcript ? { title: c.title, transcript } : null;
  await resetPiSession();
  return { ...c, messages: messagesFor(id) };
}

/**
 * Pick up a thread from another harness (Sauron session): creates a live
 * conversation prefilled with that transcript so Val can continue it here.
 */
async function continueImportedConversation({ title, source, transcript, messages }) {
  const now = Date.now();
  const c = {
    id: newConvoId(),
    title: convoTitleFor(title) || 'Imported conversation',
    source: 'live',
    sourceDetail: source ? ('imported:' + String(source).slice(0, 40)) : 'imported',
    createdAt: now,
    updatedAt: now,
    count: 0,
  };
  convos.push(c);
  activeConversationId = c.id;

  const seedMessages = Array.isArray(messages)
    ? messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim()).slice(-30)
    : [];
  const seedTranscript = (String(transcript || '').trim() || seedMessages
    .map((m) => (m.role === 'user' ? 'Savar: ' : 'Val: ') + String(m.text || '').trim())
    .join('\n')).slice(-6000);

  for (const m of seedMessages) {
    appendLine({ t: m.t || Date.now(), role: m.role, text: String(m.text || ''), c: c.id });
  }
  if (!seedMessages.length && seedTranscript) {
    appendLine({ t: now, role: 'user', text: '[imported context — continue this thread]\n' + seedTranscript.slice(0, 2000), c: c.id });
  }
  const stored = convos.find((x) => x.id === c.id);
  if (stored) {
    stored.count = messagesFor(c.id).filter((m) => m.role === 'user' || m.role === 'assistant').length;
    saveConvos();
  }
  pendingSeed = seedTranscript ? { title: stored ? stored.title : c.title, transcript: seedTranscript } : null;
  await resetPiSession();
  return { ...c, messages: messagesFor(c.id) };
}

let spokenTurnMeta = {};
function setSpokenTurnMeta(meta) {
  spokenTurnMeta = meta && typeof meta === 'object' ? meta : {};
}
function getSpokenTurnMeta() {
  return spokenTurnMeta;
}

let livePiPromise = null;
function loadLivePi() {
  if (!livePiPromise) livePiPromise = import('./live-pi.mjs');
  return livePiPromise;
}

function clearSession() {
  memory.length = 0;
  spokenTurnMeta = {};
  convos.length = 0;
  activeConversationId = null;
  pendingSeed = null;
  for (const p of SESSION_CANDIDATES) {
    try { fs.unlinkSync(p); } catch { /* none */ }
  }
  for (const p of CONVOS_CANDIDATES) {
    try { fs.unlinkSync(p); } catch { /* none */ }
  }
  persistOk = true;
  persistWarned = false;
  const picked = pickWritablePath();
  if (picked) sessionPath = picked;
  else persistOk = false;
  if (livePiPromise) {
    livePiPromise.then((pi) => { try { pi.resetSession(); } catch { /* ok */ } }).catch(() => {});
  }
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

/** Compact hub digest (~400–800 chars). Board notes + letter names + agent traces only.
 *  Ingest, execute tasks, CRM, and machine activity are tools — never dump them here. */
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
async function runTickRouter(res, { image, activeTab, recentTicks }, apiKey) {
  const imageUrl = toImageDataUrl(image);
  // No frame → nothing to react to; skip without a model call.
  if (!imageUrl) {
    sse(res, { type: 'skip' });
    sse(res, { type: 'done', text: '', skipped: true });
    return;
  }
  const digest = buildHubDigest({ activeTab });
  const recent = Array.isArray(recentTicks)
    ? recentTicks.map((t) => String(t || '').trim()).filter(Boolean).slice(-3)
    : [];
  let tickPrompt = 'Hub context (may be stale by seconds):\n' + digest;
  if (recent.length) {
    tickPrompt += '\n\nYou already said recently (SKIP if similar):\n'
      + recent.map((t) => '- ' + t).join('\n');
  }
  const userContent = [
    { type: 'text', text: tickPrompt },
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
        usage: { include: true },
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
    input: '[frame]',
    output: String(json.choices?.[0]?.message?.content || '').trim(),
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

  sse(res, { type: 'token', text: reply });
  sse(res, { type: 'done', text: reply, persist: persistOk ? sessionPath : null });
  appendLine({ t: Date.now(), role: 'assistant', text: reply });
}

async function runSpokenTurn(res, { text, image, activeTab }, apiKey) {
  const userText = String(text || '').trim();
  appendLine({ t: Date.now(), role: 'user', text: userText });
  setSpokenTurnMeta({ activeTab });
  const pi = await loadLivePi();
  await pi.runSpokenTurn(res, { text: userText, image, activeTab }, apiKey, {
    sse,
    persistPath: persistOk ? sessionPath : null,
    appendAssistant: (reply) => appendLine({ t: Date.now(), role: 'assistant', text: reply }),
    appendSession: (entry) => appendLine(entry && typeof entry === 'object' ? entry : { t: Date.now(), text: String(entry || '') }),
  });
}

async function runLiveTurn(res, body, apiKey) {
  const { text, image, tick, activeTab, recentTicks, latitude, longitude } = body || {};
  if (latitude != null && longitude != null) reportClientGeo(latitude, longitude);
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
    await runTickRouter(res, { image, activeTab, recentTicks }, apiKey);
    return;
  }

  sse(res, { type: 'error', message: 'empty text' });
}

function getSessionPath() {
  return sessionPath;
}

function valinorMemoryPath() {
  const env = String(process.env.VALINOR_MEMORY_PATH || '').trim();
  return env || path.join(os.homedir(), 'Savar', 'memory', 'valinor.md');
}

/** Read-only. Does not create or write the memory file. */
function getValinorMemory() {
  const file = valinorMemoryPath();
  const display = file.startsWith(os.homedir())
    ? '~' + file.slice(os.homedir().length)
    : file;
  try {
    if (!fs.existsSync(file)) {
      return { path: file, displayPath: display, exists: false, text: '' };
    }
    const text = String(fs.readFileSync(file, 'utf8') || '');
    return { path: file, displayPath: display, exists: true, text, bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { path: file, displayPath: display, exists: false, error: String(e.message || e), text: '' };
  }
}

module.exports = {
  getHistory,
  clearSession,
  runLiveTurn,
  getSessionPath,
  valinorMemoryPath,
  getValinorMemory,
  buildHubDigest,
  getHubGeo,
  reportClientGeo,
  setSpokenTurnMeta,
  getSpokenTurnMeta,
  listLiveConversations,
  getLiveConversation,
  newLiveConversation,
  switchLiveConversation,
  continueImportedConversation,
  consumeSeed,
  resetLivePi: resetPiSession,
  getActiveConversationId: () => activeConversationId,
  DEFAULT_MODEL,
  VISION_MODEL,
  ROUTER_MODEL,
};

// Boot: index file first, then adopt the flat session log into threads.
loadConvos();
try { ensureActiveConvo(); } catch { /* ok */ }
