// rehearse-tts.js — TTS provider chain for the Rehearse interview partner.
// New file only; owned by the TTS workstream. Contract:
//   synthesize(text, apiKey, { voice, format }) -> { buffer, contentType, model, ms, cached? }
//   status() -> { model, fallbackModel, voice, fallbackVoice, format, cacheSize }
// Chain: OpenRouter Gemini 3.1 Flash TTS (primary) → Grok Voice (fallback) →
// local Kitten (tts-server.js) → throw (client falls back to speechSynthesis).
// Voice IDs verified 2026-09-12 via GET /api/v1/models?output_modalities=speech:
//   Gemini exposes 30 voices; Charon = mature masculine pick for Adam.
//   Grok exposes eve/ara/rex/sal/leo; Rex = masculine fallback.
'use strict';

const crypto = require('crypto');
const agentUsage = require('./agent-usage');
const ttsLocal = require('./tts-server');

const OPENROUTER_TTS_URL = 'https://openrouter.ai/api/v1/audio/speech';

const MODEL = process.env.REHEARSE_TTS_MODEL || 'google/gemini-3.1-flash-tts-preview';
const FALLBACK_MODEL = process.env.REHEARSE_TTS_FALLBACK_MODEL || 'x-ai/grok-voice-tts-1.0';
const VOICE = process.env.REHEARSE_TTS_VOICE || 'Charon';
const FALLBACK_VOICE = process.env.REHEARSE_TTS_FALLBACK_VOICE || 'Rex';
const FORMAT = (process.env.REHEARSE_TTS_FORMAT || 'mp3').toLowerCase();
const TIMEOUT_MS = 9000;

// Sentence-hash cache: repeated lines (e.g. the guard line) never re-synthesize.
const cache = new Map(); // sha1(model|voice|format|text) -> {buffer, contentType, model}
const CACHE_MAX = 200;

function cacheKey(model, voice, format, text) {
  return crypto.createHash('sha1').update([model, voice, format, text].join('|')).digest('hex');
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit); // LRU refresh
  return hit;
}
function cacheSet(key, val) {
  cache.set(key, val);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function parsePcmRate(contentType) {
  const m = String(contentType || '').match(/rate\s*=\s*(\d+)/i);
  const rate = m ? Number(m[1]) : 24000;
  return Number.isFinite(rate) && rate > 0 ? rate : 24000;
}

/** Wrap raw 16-bit mono PCM bytes in a WAV header (rate from Content-Type). */
function pcmToWav(pcmBuf, sampleRate, channels = 1, bits = 16) {
  const dataLen = pcmBuf.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuf]);
}

/**
 * One OpenRouter audio/speech call. Response is RAW AUDIO BYTES (not JSON) —
 * check Content-Type before playback. Returns { buffer, contentType, model, ms }.
 */
async function openRouterTts({ model, voice, text, format, apiKey }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const upstream = await fetch(OPENROUTER_TTS_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4777',
        'X-Title': 'handviz-rehearse-tts',
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: format,
        speed: 1.0,
      }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      let msg = errText.slice(0, 300);
      try { msg = JSON.parse(errText).error?.message || msg; } catch { /* keep */ }
      const err = new Error(`${model}: ${msg || ('HTTP ' + upstream.status)}`);
      err.status = upstream.status;
      throw err;
    }
    const contentType = String(upstream.headers.get('content-type') || '');
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!buf.length) throw new Error(`${model}: empty audio`);
    // Guard: some failures come back as JSON with 200.
    if (/application\/json/i.test(contentType)) {
      let msg = buf.toString('utf8').slice(0, 300);
      try { msg = JSON.parse(msg).error?.message || msg; } catch { /* keep */ }
      throw new Error(`${model}: ${msg}`);
    }
    const ms = Date.now() - t0;
    agentUsage.record({ surface: 'rehearse-tts', model, latencyMs: ms, ok: true, label: 'tts', input: String(text).slice(0, 200) });
    if (/pcm|l16/i.test(contentType)) {
      return { buffer: pcmToWav(buf, parsePcmRate(contentType)), contentType: 'audio/wav', model, ms };
    }
    if (/wav/i.test(contentType)) return { buffer: buf, contentType: 'audio/wav', model, ms };
    return { buffer: buf, contentType: 'audio/mpeg', model, ms };
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`${model}: TTS timeout after ${TIMEOUT_MS}ms`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function synthesize(text, apiKey, { voice, format } = {}) {
  const clean = String(text || '').trim();
  if (!clean) {
    const e = new Error('empty text');
    e.status = 400;
    throw e;
  }
  const fmt = String(format || FORMAT).toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const v = voice || VOICE;
  const key = cacheKey(MODEL, v, fmt, clean);
  const hit = cacheGet(key);
  if (hit) {
    agentUsage.record({ surface: 'rehearse-tts', model: hit.model || MODEL, latencyMs: 0, ok: true, label: 'tts-cache' });
    return { ...hit, cached: true, ms: 0 };
  }

  const errors = [];
  // 1. Primary: Gemini. mp3 first; wrap PCM if that is what comes back.
  if (apiKey) {
    try {
      const out = await openRouterTts({ model: MODEL, voice: v, text: clean, format: fmt, apiKey });
      cacheSet(key, out);
      return out;
    } catch (e) {
      errors.push(String(e.message || e));
      // Gemini documents PCM-only output — if mp3 was refused, retry as pcm once.
      if (/format|response_format|pcm/i.test(String(e.message || ''))) {
        try {
          const out = await openRouterTts({ model: MODEL, voice: v, text: clean, format: 'pcm', apiKey });
          cacheSet(key, out);
          return out;
        } catch (e2) {
          errors.push(String(e2.message || e2));
        }
      }
    }
    // 2. Fallback: Grok voice (mp3 native).
    try {
      const out = await openRouterTts({ model: FALLBACK_MODEL, voice: FALLBACK_VOICE, text: clean, format: 'mp3', apiKey });
      return out;
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  } else {
    errors.push('no OPENROUTER_API_KEY — skipping cloud TTS');
  }
  // 3. Kitten local. (Client does browser speechSynthesis after this.)
  try {
    const out = await ttsLocal.synthesize(clean, undefined, undefined);
    agentUsage.record({ surface: 'rehearse-tts', model: 'kitten-local', latencyMs: out.ms, ok: true, label: 'tts', input: clean.slice(0, 200) });
    return { buffer: out.buffer, contentType: 'audio/wav', model: 'kitten-local:' + (out.voice || ''), ms: out.ms };
  } catch (e) {
    errors.push('kitten: ' + String(e.message || e));
  }
  agentUsage.record({ surface: 'rehearse-tts', model: MODEL, ok: false, label: 'tts', input: errors.join(' | ').slice(0, 400) });
  const err = new Error('all TTS providers failed: ' + errors.join(' | ').slice(0, 600));
  err.status = 502;
  err.ttsErrors = errors;
  throw err;
}

function status() {
  return {
    model: MODEL,
    fallbackModel: FALLBACK_MODEL,
    voice: VOICE,
    fallbackVoice: FALLBACK_VOICE,
    format: FORMAT,
    timeoutMs: TIMEOUT_MS,
    cacheSize: cache.size,
  };
}

module.exports = {
  MODEL,
  FALLBACK_MODEL,
  VOICE,
  FALLBACK_VOICE,
  FORMAT,
  TIMEOUT_MS,
  synthesize,
  status,
  pcmToWav, // exported for unit checks
};
