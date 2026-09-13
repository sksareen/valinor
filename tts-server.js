// tts-server.js — local Kitten TTS sidecar for the live companion.
// Manages tts/venv + a long-lived Python worker. Local audio only.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const dataHome = require('./data-home');

const ROOT = path.join(__dirname, 'tts');
const VENV_DIR = path.join(ROOT, 'venv');
const VENV_PY = path.join(VENV_DIR, 'bin', 'python');
const WORKER = path.join(ROOT, 'kitten_worker.py');
const REQ = path.join(ROOT, 'requirements.txt');

const VOICES = ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'];
const DEFAULT_VOICE = process.env.KITTEN_TTS_VOICE || 'Jasper';
const DEFAULT_SPEED = Number(process.env.KITTEN_TTS_SPEED || 1.3) || 1.3;
const DISABLED = process.env.KITTEN_TTS === '0';

let child = null;
let rl = null;
let starting = null;
let reqId = 0;
const pending = new Map(); // id -> { resolve, reject, timer }
let lastError = null;
let ready = false;
let modelId = process.env.KITTEN_TTS_MODEL || 'KittenML/kitten-tts-mini-0.8';

function pythonBin() {
  return fs.existsSync(VENV_PY) ? VENV_PY : null;
}

function ensureVenv() {
  return new Promise((resolve, reject) => {
    if (pythonBin()) { resolve(pythonBin()); return; }
    console.log('Kitten TTS: creating venv + installing requirements (one-time, ~80MB model)…');
    const pyCandidates = ['python3.12', 'python3.11', 'python3'];
    const tryNext = (i) => {
      if (i >= pyCandidates.length) {
        reject(new Error('no python3.12/3.11/3 found for Kitten TTS venv'));
        return;
      }
      execFile(pyCandidates[i], ['-m', 'venv', VENV_DIR], { cwd: ROOT }, (err) => {
        if (err) { tryNext(i + 1); return; }
        const pip = path.join(VENV_DIR, 'bin', 'pip');
        execFile(pip, ['install', '-r', REQ], {
          cwd: ROOT,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
        }, (err2, _stdout, stderr) => {
          if (err2) {
            reject(new Error(String(err2.message || err2) + (stderr ? `\n${String(stderr).slice(-600)}` : '')));
            return;
          }
          // misaki[en] (via kittentts) pulls torch; English works without it via espeak.
          execFile(pip, [
            'uninstall', '-y',
            'torch', 'spacy-curated-transformers', 'curated-transformers', 'curated-tokenizers',
          ], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 }, () => resolve(pythonBin()));
        });
      });
    };
    tryNext(0);
  });
}

function settle(id, payload) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  if (payload && payload.ok) p.resolve(payload);
  else p.reject(new Error((payload && payload.error) || 'tts failed'));
}

function onWorkerLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg && msg.event === 'ready') {
    ready = !!msg.ok;
    lastError = msg.ok ? null : String(msg.error || 'not ready');
    if (msg.model) modelId = msg.model;
    if (msg.ok) console.log(`Kitten TTS: ready (${modelId})`);
    else console.warn('Kitten TTS: worker failed to load —', lastError);
    return;
  }
  if (msg && msg.id != null) settle(msg.id, msg);
}

function attachWorker(proc) {
  child = proc;
  rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', onWorkerLine);
  proc.stderr.on('data', (buf) => {
    const t = String(buf).trimEnd();
    if (t) console.log(t.split('\n').map((l) => `[kitten-tts] ${l}`).join('\n'));
  });
  proc.on('exit', (code, signal) => {
    console.warn(`[kitten-tts] exited code=${code} signal=${signal || ''}`);
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('tts worker exited'));
      pending.delete(id);
    }
    child = null;
    rl = null;
    ready = false;
  });
}

function startWorker(py) {
  const useArch = process.platform === 'darwin' && process.arch === 'x64';
  // Model cache + synth tmp: explicit env, then repo tts/ dirs when present,
  // then the user data home (fresh installs keep model weight out of the repo).
  const cacheDir = dataHome.resolveDir({ env: 'KITTEN_TTS_CACHE_DIR', name: 'tts/models', legacy: ['tts/models'] });
  const tmpDir = dataHome.resolveDir({ env: 'KITTEN_TTS_TMP_DIR', name: 'tts/tmp', legacy: ['tts/tmp'] });
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    KITTEN_TTS_MODEL: modelId,
    KITTEN_TTS_CACHE: cacheDir,
    KITTEN_TTS_TMP: tmpDir,
  };
  const proc = spawn(
    useArch ? 'arch' : py,
    useArch ? ['-arm64', py, WORKER] : [WORKER],
    { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  attachWorker(proc);
  return proc;
}

function request(cmd, extra = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!child || !child.stdin.writable) {
      reject(new Error('tts worker not running'));
      return;
    }
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`tts ${cmd} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function ensureStarted() {
  if (DISABLED) throw new Error('Kitten TTS disabled (KITTEN_TTS=0)');
  if (child && ready) return;
  if (child && !ready && lastError) throw new Error(lastError);
  if (starting) return starting;
  starting = (async () => {
    try {
      const py = await ensureVenv();
      if (!child) startWorker(py);
      // Wait until ready event or first successful voices call.
      const deadline = Date.now() + 180000; // first run may download the model
      while (Date.now() < deadline) {
        if (ready) return;
        if (lastError && !child) throw new Error(lastError);
        if (child) {
          try {
            const v = await request('voices', {}, 120000);
            if (v.ok) { ready = true; lastError = null; return; }
          } catch (e) {
            if (!child) throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(lastError || 'tts worker did not become ready');
    } finally {
      starting = null;
    }
  })();
  return starting;
}

function stop() {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  child = null;
  ready = false;
}

async function status() {
  if (DISABLED) {
    return { ok: false, disabled: true, engine: 'kitten', voices: VOICES, voice: DEFAULT_VOICE, ready: false };
  }
  return {
    ok: ready,
    ready,
    engine: 'kitten',
    model: modelId,
    voices: VOICES,
    voice: DEFAULT_VOICE,
    error: lastError,
    starting: !!starting,
  };
}

async function synthesize(text, voice, speed) {
  const clean = String(text || '').trim();
  if (!clean) {
    const e = new Error('empty text');
    e.status = 400;
    throw e;
  }
  await ensureStarted();
  const v = VOICES.includes(voice) ? voice : DEFAULT_VOICE;
  const sp = Number(speed);
  const useSpeed = Number.isFinite(sp) ? sp : DEFAULT_SPEED;
  const out = await request('speak', { text: clean, voice: v, speed: useSpeed }, 90000);
  if (out.wav_b64) {
    return {
      buffer: Buffer.from(out.wav_b64, 'base64'),
      voice: out.voice || v,
      ms: out.ms || null,
      sampleRate: out.sample_rate || 24000,
    };
  }
  // Back-compat if an older worker still returns a path.
  const file = out.path;
  if (!file || !fs.existsSync(file)) {
    const e = new Error('tts produced no audio');
    e.status = 500;
    throw e;
  }
  try {
    const buf = fs.readFileSync(file);
    return { buffer: buf, voice: out.voice || v, ms: out.ms || null, sampleRate: out.sample_rate || 24000 };
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

async function startManaged() {
  if (DISABLED) {
    console.log('Kitten TTS: disabled (KITTEN_TTS=0)');
    return;
  }
  if (!fs.existsSync(WORKER)) {
    console.warn('Kitten TTS: worker missing — live will fall back to browser speech');
    return;
  }
  try {
    await ensureStarted();
  } catch (e) {
    lastError = String(e.message || e);
    console.warn('Kitten TTS failed to start:', lastError);
    console.warn('Live companion will fall back to browser speechSynthesis.');
  }
}

module.exports = {
  VOICES,
  DEFAULT_VOICE,
  DEFAULT_SPEED,
  status,
  synthesize,
  startManaged,
  stop,
  ensureStarted,
};
