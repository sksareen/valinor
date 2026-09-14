// Voice-driven agent: OpenRouter tool loop + retrieval/render tools + trace bus.
// Zero npm deps — Node 22 global fetch. Required by server.js.
'use strict';

const crypto = require('crypto');
const agentUsage = require('./agent-usage');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
// Chrome's webkitSpeechRecognition needs Google's proprietary cloud STT — unavailable in
// Electron, non-Google-branded Chromium (Arc/Brave/Vivaldi/etc.), and behind some firewalls.
// This fallback transcribes recorded audio through an audio-capable OpenRouter model instead,
// so voice input keeps working regardless of the browser's speech backend.
const TRANSCRIBE_MODEL = process.env.OPENROUTER_TRANSCRIBE_MODEL || 'google/gemini-3.5-flash-lite';
const MAX_ROUNDS = 6;
const YT_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// ---- tiny helpers ----
const uid = (p = 'c') => p + crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const err = new Error((json && (json.error?.message || json.error)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ---- trace bus: ring buffer + SSE fanout ----
const RING_MAX = 50;
const ring = [];          // newest at end
const listeners = new Set(); // res objects subscribed to /api/agent/trace

function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of listeners) {
    try { res.write(line); } catch { listeners.delete(res); }
  }
}

function pushTrace(evt) {
  ring.push(evt);
  if (ring.length > RING_MAX * 8) ring.splice(0, ring.length - RING_MAX * 4); // keep buffer bounded
  // also keep a turn-index for agent.html grouping — raw events are fine
  broadcast(evt);
}

function subscribeTrace(res) {
  listeners.add(res);
  // replay recent events so a late-joining AGENT tab catches up
  for (const evt of ring.slice(-200)) {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* ignore */ }
  }
  res.on('close', () => listeners.delete(res));
}

/** Short one-liners from recent agent trace for LIVE hub digest. */
function getRecentTraceSummary(n = 5) {
  const out = [];
  for (let i = ring.length - 1; i >= 0 && out.length < n; i--) {
    const evt = ring[i];
    if (!evt || typeof evt !== 'object') continue;
    let line = '';
    if (evt.type === 'user' || evt.type === 'transcript') line = 'user: ' + String(evt.transcript || evt.text || evt.message || '').slice(0, 80);
    else if (evt.type === 'assistant' || evt.type === 'reply') line = 'agent: ' + String(evt.text || evt.message || evt.content || '').slice(0, 80);
    else if (evt.type === 'tool') line = 'tool: ' + String(evt.name || evt.tool || 'call');
    else if (evt.type === 'error') line = 'err: ' + String(evt.message || '').slice(0, 80);
    else if (evt.type === 'turn' || evt.type === 'start') line = String(evt.type);
    else continue;
    if (line.trim()) out.push(line.replace(/\s+/g, ' ').trim());
  }
  return out.reverse();
}

// ---- retrieval tools ----
async function searchFilms({ person }) {
  if (!person || !String(person).trim()) throw new Error('person required');
  const q = String(person).trim();
  const searchUrl = 'https://www.wikidata.org/w/api.php?' + new URLSearchParams({
    action: 'wbsearchentities', search: q, language: 'en', type: 'item', limit: '5', format: 'json',
  });
  const search = await fetchJson(searchUrl, {
    headers: { 'User-Agent': 'handviz-agent/1.0 (local; filmography)' },
  });
  const hit = (search.search || [])[0];
  if (!hit) return { person: q, qid: null, films: [] };
  const qid = hit.id;

  const sparql = `
SELECT ?film ?filmLabel (MIN(?d) AS ?date) ?wiki WHERE {
  ?film wdt:P31/wdt:P279* wd:Q11424 .
  ?film wdt:P57 wd:${qid} .
  OPTIONAL { ?film wdt:P577 ?d . }
  OPTIONAL {
    ?wiki schema:about ?film .
    ?wiki schema:isPartOf <https://en.wikipedia.org/> .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?film ?filmLabel ?wiki
ORDER BY ?date
`.trim();

  const sparqlUrl = 'https://query.wikidata.org/sparql?' + new URLSearchParams({
    query: sparql, format: 'json',
  });
  const data = await fetchJson(sparqlUrl, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': 'handviz-agent/1.0 (local; filmography)',
    },
  }, 45000);

  const films = (data.results?.bindings || []).map((b) => {
    const date = b.date?.value ? String(b.date.value).slice(0, 10) : null;
    const year = date ? date.slice(0, 4) : null;
    const title = b.filmLabel?.value || 'Untitled';
    // skip unlabeled QIDs (e.g. "Q124758311") unless that's all we have
    return {
      title,
      year,
      date,
      wikidata: b.film?.value || null,
      wikipedia: b.wiki?.value || null,
    };
  }).filter((f) => f.title && !/^Q\d+$/.test(f.title));
  return { person: hit.label || q, qid, description: hit.description || '', films };
}

async function wikipediaSearch({ query }) {
  if (!query) throw new Error('query required');
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', list: 'search', srsearch: String(query), srlimit: '8', format: 'json', origin: '*',
  });
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'handviz-agent/1.0 (local; wikipedia)' },
  });
  return (data.query?.search || []).map((s) => ({
    title: s.title,
    snippet: (s.snippet || '').replace(/<[^>]+>/g, ''),
    pageid: s.pageid,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
  }));
}

async function wikipediaPage({ title }) {
  if (!title) throw new Error('title required');
  const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(String(title).replace(/ /g, '_'));
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'handviz-agent/1.0 (local; wikipedia)', Accept: 'application/json' },
  });
  return {
    title: data.title,
    description: data.description || '',
    extract: data.extract || '',
    url: data.content_urls?.desktop?.page || data.content_urls?.mobile?.page || null,
    thumbnail: data.thumbnail?.source || null,
  };
}

async function youtubeSearch({ query }) {
  if (!query) throw new Error('query required');
  const data = await fetchJson(
    `https://www.youtube.com/youtubei/v1/search?key=${YT_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
            hl: 'en',
            gl: 'US',
          },
        },
        query: String(query),
      }),
    },
  );

  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer) {
      const v = node.videoRenderer;
      const videoId = v.videoId;
      if (videoId && !out.find((x) => x.videoId === videoId)) {
        const title = v.title?.runs?.map((r) => r.text).join('') || v.title?.simpleText || 'Untitled';
        const channel = v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || '';
        const duration = v.lengthText?.simpleText || null;
        out.push({ videoId, title, channel, duration });
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(data);
  return out.slice(0, 8);
}

// ---- audio transcription fallback (used when the browser's own speech recognizer
// can't reach Google's cloud STT — Electron, non-Chrome Chromium, blocked networks) ----
async function transcribeAudio({ audioBase64, format }, apiKey) {
  if (!apiKey) {
    const err = new Error('OPENROUTER_API_KEY is missing — add it to .env (get a key at https://openrouter.ai/keys).');
    err.status = 401;
    throw err;
  }
  if (!audioBase64) throw new Error('audioBase64 required');
  const fmt = format || 'webm';
  const t0 = Date.now();
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4777',
      'X-Title': 'handviz-agent-transcribe',
    },
    body: JSON.stringify({
      model: TRANSCRIBE_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this audio verbatim, in English. Return ONLY the transcribed words — no quotes, no commentary, no punctuation-only guesses if silent (return an empty string if there is no speech).' },
          { type: 'input_audio', input_audio: { data: audioBase64, format: fmt } },
        ],
      }],
      temperature: 0,
      usage: { include: true },
    }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 400) } }; }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    agentUsage.record({
      surface: 'transcribe', model: TRANSCRIBE_MODEL, latencyMs, ok: false, label: 'stt',
    });
    const msg = json.error?.message || json.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  const usage = json.usage || {};
  const out = (json.choices?.[0]?.message?.content || '').trim();
  agentUsage.record({
    surface: 'transcribe',
    model: json.model || TRANSCRIBE_MODEL,
    latencyMs,
    usage,
    cost: usage.cost ?? null,
    ok: true,
    label: 'stt',
    input: '[audio]',
    output: out,
  });
  return { text: out };
}

async function captureMemoryFromBoard({ text, kind, title }, apiKey) {
  const ingest = require('./ingest-server');
  const key = apiKey || process.env.OPENROUTER_API_KEY || '';
  const rec = await ingest.capture({
    text: String(text || ''),
    source: 'conversation',
    kind: kind || 'thought',
    title: (title || '').trim() || undefined,
    threadTitle: 'Board session',
    origin: 'agent',
  }, key);
  return { ok: true, id: rec.id, title: rec.title, kind: kind || 'thought' };
}

// ---- OpenAI-style tool schemas ----
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'search_films',
      description: 'Look up a person\'s filmography via Wikidata (director/writer credits as films). Returns titles, years, Wikipedia URLs.',
      parameters: {
        type: 'object',
        properties: { person: { type: 'string', description: 'Person name, e.g. Christopher Nolan' } },
        required: ['person'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wikipedia_search',
      description: 'Search English Wikipedia. Use to disambiguate articles (e.g. film vs epic poem).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wikipedia_page',
      description: 'Fetch a Wikipedia page summary (extract + canonical URL) by exact title.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'youtube_search',
      description: 'Search YouTube (keyless). Returns videoId, title, channel, duration. Prefer official trailers when asked for a trailer.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_list',
      description: 'Render a titled list card on the board (e.g. filmography).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          items: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    year: { type: ['string', 'number', 'null'] },
                    url: { type: 'string' },
                  },
                },
              ],
            },
          },
        },
        required: ['title', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_video',
      description: 'Embed a YouTube video card on the board by videoId.',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['videoId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_web',
      description: 'Open a mini-browser card on the board (Wikipedia and most sites iframe fine; client may proxy if needed).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_text',
      description: 'Show a short text/answer card on the board.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' }, title: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_cards',
      description: 'Remove cards from the board by id list, or all agent cards if all=true.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          all: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'capture_memory',
      description: 'Save a thought, idea, recommendation, or next step from this conversation into ingest as a memory artifact. It appears in capture and can be promoted to tasks. Use when you produce recommendations or the user shares something worth keeping.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Full text of the thought (1-6 sentences)' },
          kind: { type: 'string', description: 'idea | recommendation | decision | thought', enum: ['idea', 'recommendation', 'decision', 'thought'] },
          title: { type: 'string', description: 'Short title (omit to auto-generate)' },
        },
        required: ['text'],
      },
    },
  },
];

const RETRIEVAL = { search_films: searchFilms, wikipedia_search: wikipediaSearch, wikipedia_page: wikipediaPage, youtube_search: youtubeSearch };
const ACTIONS = { capture_memory: captureMemoryFromBoard };
const RENDER = new Set(['show_list', 'show_video', 'show_web', 'show_text', 'remove_cards']);

function normalizeListItems(items) {
  return (items || []).map((it) => {
    if (typeof it === 'string') return { label: it };
    if (it && typeof it === 'object') {
      return {
        label: it.label || it.title || String(it),
        year: it.year != null ? String(it.year) : null,
        url: it.url || it.wikipedia || null,
      };
    }
    return { label: String(it) };
  });
}

function buildCard(name, args, layout) {
  const id = uid('c');
  const x = layout.x, y = layout.y;
  layout.x += 0.18;
  if (layout.x > 0.85) { layout.x = 0.22; layout.y += 0.22; }
  if (name === 'show_list') {
    return {
      id, kind: 'list', x, y, color: 'sky',
      text: args.title || 'List',
      data: { title: args.title || 'List', items: normalizeListItems(args.items) },
    };
  }
  if (name === 'show_video') {
    return {
      id, kind: 'video', x, y, color: 'pink',
      text: args.title || 'Video',
      data: { videoId: args.videoId, title: args.title || 'Video' },
    };
  }
  if (name === 'show_web') {
    return {
      id, kind: 'web', x, y, color: 'green',
      text: args.title || args.url || 'Web',
      data: { url: args.url, title: args.title || args.url || 'Web' },
    };
  }
  if (name === 'show_text') {
    return {
      id, kind: 'text', x, y, color: 'amber',
      text: args.text || '',
      data: { text: args.text || '', title: args.title || 'Note' },
    };
  }
  return null;
}

function toolsForKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'video') {
    return TOOL_DEFS.filter((t) => ['youtube_search', 'show_video'].includes(t.function?.name));
  }
  if (k === 'wiki') {
    return TOOL_DEFS.filter((t) => ['wikipedia_search', 'wikipedia_page', 'show_web'].includes(t.function?.name));
  }
  return TOOL_DEFS;
}

function systemPrompt(boardState, history, kind) {
  const cards = (boardState || []).map((c) => ({
    id: c.id, kind: c.kind || 'note', title: c.title || c.text || '',
  }));
  const hist = (history || []).slice(-6).map((h) => ({
    role: h.role, content: String(h.content || '').slice(0, 400),
  }));
  const k = String(kind || '').trim().toLowerCase();
  const lines = [
    'You are a spatial board agent. The user speaks; you gather facts with retrieval tools, then place results on the board with render tools.',
  ];
  if (k === 'video') {
    lines.push(
      'This request is VIDEO ONLY. Call youtube_search, then show_video with a videoId from the results. Do not call Wikipedia tools. Do not use show_web or show_list — Live only plays video cards.',
    );
  } else if (k === 'wiki') {
    lines.push(
      'This request is WIKIPEDIA ONLY. Call wikipedia_search / wikipedia_page, then show_web with the article URL. Do not search YouTube.',
    );
  } else {
    lines.push(
      'Always end by calling one or more show_* tools so the user sees something on the board. Prefer show_list for filmographies, show_video for trailers, show_web for Wikipedia articles.',
      'When the conversation yields an idea, recommendation, or next step worth keeping — or the user asks to save or remember something — call capture_memory (one artifact per thought) alongside the board card.',
      'When the user asks for Wikipedia of "the Odyssey, original translation", prefer Homer\'s epic (or Emily Wilson translation) — NOT the Nolan film — unless board context clearly points at the film.',
    );
  }
  lines.push(
    'After placing the right card(s), stop. Do NOT also call show_text to restate what the card already shows.',
    'Use the CURRENT BOARD STATE to resolve pronouns and short references ("the Odyssey", "that list", "original translation").',
    'Be concise in any show_text. Do not invent videoIds or URLs — search first.',
    '',
    'CURRENT BOARD STATE: ' + JSON.stringify(cards),
    hist.length ? 'RECENT TURNS: ' + JSON.stringify(hist) : '',
  );
  return lines.filter(Boolean).join('\n');
}

function sseWrite(res, evt) {
  try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* closed */ }
}

async function callOpenRouter(apiKey, messages, tools) {
  const t0 = Date.now();
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4777',
      'X-Title': 'handviz-agent',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
      usage: { include: true },
    }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 400) } }; }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const msg = json.error?.message || json.error || `OpenRouter HTTP ${res.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.latencyMs = latencyMs;
    throw err;
  }
  const choice = json.choices?.[0]?.message || {};
  const usage = json.usage || {};
  return {
    message: choice,
    model: json.model || DEFAULT_MODEL,
    latencyMs,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
    cost: json.usage?.cost ?? null,
  };
}

/**
 * Run one agent turn. Streams SSE events to `res` and mirrors them on the trace bus.
 * body: { transcript, boardState, history, kind }
 * kind: 'video' | 'wiki' | omitted (full tool set, used by board.html)
 * apiKey: OPENROUTER_API_KEY (may be missing → clear error)
 */
async function runAgentTurn(res, body, apiKey) {
  const turnId = uid('t');
  const transcript = String(body.transcript || '').trim();
  const boardState = Array.isArray(body.boardState) ? body.boardState : [];
  const history = Array.isArray(body.history) ? body.history : [];
  const kind = String(body.kind || '').trim().toLowerCase();
  const toolDefs = toolsForKind(kind);
  const emit = (evt) => {
    const full = { turnId, t: Date.now(), ...evt };
    sseWrite(res, full);
    pushTrace(full);
  };

  emit({ type: 'turn.start', transcript, kind: kind || null });

  if (!apiKey) {
    emit({
      type: 'error',
      message: 'OPENROUTER_API_KEY is missing. Add it to .env in the project root (get a key at https://openrouter.ai/keys).',
    });
    emit({ type: 'turn.end', ok: false });
    return;
  }
  if (!transcript) {
    emit({ type: 'error', message: 'Empty transcript' });
    emit({ type: 'turn.end', ok: false });
    return;
  }

  const messages = [
    { role: 'system', content: systemPrompt(boardState, history, kind) },
    { role: 'user', content: transcript },
  ];

  const layout = { x: 0.28, y: 0.35 };
  // stagger new cards away from existing ones a bit
  if (boardState.length) {
    layout.x = 0.55;
    layout.y = 0.30 + (boardState.length % 3) * 0.12;
  }

  let ok = true;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      emit({ type: 'model.request', round, model: DEFAULT_MODEL });
      let result;
      try {
        result = await callOpenRouter(apiKey, messages, toolDefs);
      } catch (e) {
        const status = e.status || 0;
        let message = e.message || String(e);
        if (status === 401 || /user not found/i.test(message)) {
          message = 'OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in .env — create a fresh key at https://openrouter.ai/keys.';
        }
        agentUsage.record({
          surface: 'agent', model: DEFAULT_MODEL, latencyMs: e.latencyMs || null,
          ok: false, turnId, label: `round ${round}`,
        });
        emit({ type: 'error', message, status });
        ok = false;
        break;
      }

      emit({
        type: 'model.response',
        round,
        model: result.model,
        latencyMs: result.latencyMs,
        usage: result.usage,
        cost: result.cost,
        content: result.message.content || null,
        toolCalls: (result.message.tool_calls || []).map((tc) => tc.function?.name),
      });
      agentUsage.record({
        surface: 'agent',
        model: result.model,
        latencyMs: result.latencyMs,
        usage: result.usage,
        cost: result.cost,
        ok: true,
        turnId,
        label: `round ${round}`,
        input: (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== 'user') continue;
            if (typeof m.content === 'string') return m.content;
            if (Array.isArray(m.content)) return m.content.map((p) => p.text || '').join(' ');
          }
          return '';
        })(),
        output: result.message.content
          || ((result.message.tool_calls || []).map((tc) => tc.function?.name).filter(Boolean).join(', ')),
      });

      const toolCalls = result.message.tool_calls || [];
      if (!toolCalls.length) {
        // model answered in text only — surface it as a text card
        if (result.message.content) {
          const card = buildCard('show_text', { text: result.message.content }, layout);
          emit({ type: 'card', card });
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: result.message.content || null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name || '';
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
        emit({ type: 'tool.start', name, args, toolCallId: tc.id });
        const t0 = Date.now();
        let toolResult;
        try {
          if (RETRIEVAL[name]) {
            toolResult = await RETRIEVAL[name](args);
          } else if (ACTIONS[name]) {
            toolResult = await ACTIONS[name](args, apiKey);
          } else if (RENDER.has(name)) {
            if (name === 'remove_cards') {
              toolResult = { removed: args.ids || [], all: !!args.all };
              emit({ type: 'card', remove: { ids: args.ids || null, all: !!args.all } });
            } else {
              const card = buildCard(name, args, layout);
              if (card) {
                emit({ type: 'card', card });
                toolResult = { ok: true, cardId: card.id, kind: card.kind };
              } else {
                toolResult = { ok: false, error: 'unknown render' };
              }
            }
          } else {
            toolResult = { error: `unknown tool: ${name}` };
          }
        } catch (e) {
          toolResult = { error: e.message || String(e) };
        }
        const preview = JSON.stringify(toolResult);
        emit({
          type: 'tool.end',
          name,
          toolCallId: tc.id,
          latencyMs: Date.now() - t0,
          resultPreview: preview.slice(0, 1200),
          result: toolResult,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: preview.slice(0, 8000),
        });
      }
    }
  } catch (e) {
    ok = false;
    emit({ type: 'error', message: e.message || String(e) });
  }

  emit({ type: 'turn.end', ok });
}

// Expose retrieval tools for unit-style verification without OpenRouter
const tools = { searchFilms, wikipediaSearch, wikipediaPage, youtubeSearch };

module.exports = {
  runAgentTurn,
  subscribeTrace,
  getRecentTraceSummary,
  transcribeAudio,
  tools,
  TOOL_DEFS,
  DEFAULT_MODEL,
  TRANSCRIBE_MODEL,
};
