// Tiny zero-dependency bridge: serves the hub and JSON stores (notes.json, …).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const os = require('os');
const {
  runAgentTurn,
  subscribeTrace,
  transcribeAudio,
  DEFAULT_MODEL: AGENT_MODEL,
  TRANSCRIBE_MODEL,
} = require('./agent-server');
const {
  getHistory,
  clearSession,
  runLiveTurn,
  getSessionPath,
  getValinorMemory,
  valinorMemoryPath,
  getHubGeo,
  reportClientGeo,
  listLiveConversations,
  getLiveConversation,
  newLiveConversation,
  switchLiveConversation,
  continueImportedConversation,
  resetLivePi,
  DEFAULT_MODEL: LIVE_MODEL,
  VISION_MODEL,
  ROUTER_MODEL,
} = require('./live-server');
const ingest = require('./ingest-server');
const execute = require('./execute-server');
const executePlan = require('./execute-plan');
const appleNotes = require('./apple-notes');
const applePhotos = require('./apple-photos');
const screenshots = require('./screenshots');
const emailIngest = require('./email-ingest');
const imessageIngest = require('./imessage-ingest');
const integrations = require('./integrations');
const networkData = require('./network-data');
const {
  runDraftTurn,
  refreshStyleProfile,
  suggestRecipients,
  messageModel,
  suggestModel,
} = require('./draft-server');
const hwSampler = require('./hw-sampler');
const agentUsage = require('./agent-usage');
const letterSession = require('./letter-session');
const writingVoice = require('./writing-voice');
const writingPipeline = require('./writing-pipeline');
const livePrompt = require('./live-prompt');
const rehearse = require('./rehearse-server');
const tts = require('./tts-server');
hwSampler.start();

const ROOT = __dirname;
const LETTERS = path.join(ROOT, 'letters');
const LETTER_HIST = path.join(LETTERS, '.history');
const LETTER_HIST_CAP = 50;
function letterHistPath(file) {
  const base = path.basename(String(file || ''));
  if (!/^[\w][\w.()\- ]*\.md$/.test(base)) return null;
  return path.join(LETTER_HIST, base + '.json');
}
function readLetterHist(file) {
  try {
    const p = letterHistPath(file);
    if (!p) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
const PORT = 4777;
const BIND = process.env.VALINOR_BIND || process.env.HUDHUB_BIND || '127.0.0.1';
const SAURON_BIN = process.env.SAURON_BIN || path.join(os.homedir(), 'go', 'bin', 'sauron');

async function buildServerInfo() {
  const usage = agentUsage.getSnapshot(0.01);
  let ttsModel = process.env.KITTEN_TTS_MODEL || 'KittenML/kitten-tts-mini-0.8';
  try {
    const ttsStatus = await tts.status();
    if (ttsStatus && ttsStatus.model) ttsModel = ttsStatus.model;
  } catch { /* ignore */ }
  return {
    storage: [
      { key: 'Capture', value: ingest.INGEST_DIR, note: 'Voice + Apple Notes + screenshots → .md files' },
      { key: 'Execute', value: execute.EXECUTE_DIR, note: 'Tasks + proof files' },
      { key: 'Screenshots source', value: screenshots.SCREENSHOTS_DIR, note: 'Mac folder watched for auto-ingest' },
      { key: 'Board notes', value: path.join(ROOT, 'notes.json'), note: '/api/notes' },
      { key: 'Drafts / CRM', value: path.join(ROOT, '{drafts,crm,message-profile}.json'), note: 'Gitignored; messages tab' },
      { key: 'Letters', value: LETTERS, note: 'Markdown letters (gitignored)' },
      { key: 'Plan session', value: getSessionPath(), note: 'live-session.jsonl' },
      { key: 'Valinor memory', value: valinorMemoryPath(), note: 'valinor.md — VALINOR_MEMORY_PATH or ~/Savar/memory' },
      { key: 'Agent usage', value: usage.logPath || path.join(ROOT, 'agent-usage.jsonl'), note: 'OpenRouter call log' },
      { key: 'Loopkeeper', value: path.join(ROOT, 'loopkeeper/*.db'), note: 'LOOPS tab databases' },
      { key: 'Browser prefs', value: 'localStorage', note: 'Hub look, INGRAIN SRS, rehearse scripts' },
      { key: 'CRM DB', value: process.env.NETWORK_DB_PATH || '(NETWORK_DB_PATH unset)', note: 'Read-only' },
      { key: 'iMessage DB', value: process.env.CHAT_DB_PATH || path.join(os.homedir(), 'Library', 'Messages', 'chat.db'), note: 'Read-only' },
    ],
    models: [
      { key: 'Speech → text', value: TRANSCRIBE_MODEL, env: 'OPENROUTER_TRANSCRIBE_MODEL' },
      { key: 'Capture refine', value: ingest.CAPTURE_MODEL, env: 'OPENROUTER_CAPTURE_MODEL' },
      { key: 'Agent / board', value: AGENT_MODEL, env: 'OPENROUTER_MODEL' },
      { key: 'Plan (text)', value: LIVE_MODEL, env: 'OPENROUTER_MODEL' },
      { key: 'Plan (vision)', value: VISION_MODEL, env: 'OPENROUTER_VISION_MODEL' },
      { key: 'Plan (tick router)', value: ROUTER_MODEL, env: 'OPENROUTER_VISION_MODEL' },
      { key: 'Activity cursor', value: process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite', env: 'OPENROUTER_VISION_MODEL' },
      { key: 'Messages draft', value: messageModel(), env: 'MESSAGE_MODEL' },
      { key: 'Messages suggest', value: suggestModel(), env: 'SUGGEST_MODEL' },
      { key: 'Execute review', value: execute.REVIEW_MODEL, env: 'OPENROUTER_CAPTURE_MODEL' },
      { key: 'Letters from session', value: letterSession.LETTER_MODEL, env: 'OPENROUTER_CAPTURE_MODEL' },
      { key: 'Plan TTS', value: ttsModel, env: 'KITTEN_TTS_MODEL', note: 'Local Kitten TTS' },
      { key: 'Rehearse interviewer', value: rehearse.MODEL, env: 'REHEARSE_MODEL', note: 'Fallback: ' + rehearse.FALLBACK_MODEL },
      { key: 'Rehearse TTS', value: rehearse.TTS_MODEL, env: 'REHEARSE_TTS_MODEL', note: 'Voice ' + rehearse.TTS_VOICE + '; fallback ' + rehearse.TTS_FALLBACK_MODEL },
    ],
    openRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
  };
}

function sauronExec(args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(SAURON_BIN, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: String(err.message || err), stderr: String(stderr || '').slice(0, 400) });
        return;
      }
      const text = String(stdout || '').trim();
      if (!text) { resolve({ ok: true, data: null }); return; }
      try { resolve({ ok: true, data: JSON.parse(text) }); }
      catch { resolve({ ok: true, data: text, raw: true }); }
    });
  });
}

function parseSauronStatus(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { running: false, pid: null, clipboard: null, activity: null, sessions: null, live: null, raw: text };
  for (const line of lines) {
    const run = line.match(/^sauron:\s*(running|stopped|not running)\s*(?:\(pid\s+(\d+)\))?/i);
    if (run) { out.running = /running/i.test(run[1]) && !/not/i.test(run[1]); out.pid = run[2] ? Number(run[2]) : null; continue; }
    const clip = line.match(/^clipboard captures:\s*(\d+)/i);
    if (clip) { out.clipboard = Number(clip[1]); continue; }
    const act = line.match(/^activity entries:\s*(\d+)/i);
    if (act) { out.activity = Number(act[1]); continue; }
    const sess = line.match(/^sessions:\s*(\d+)/i);
    if (sess) { out.sessions = Number(sess[1]); continue; }
    if (/^live:/i.test(line)) out.live = line.replace(/^live:\s*/i, '');
  }
  return out;
}

async function buildMachineSnapshot(hours) {
  const [statusR, contextR, activityR, timelineR, clipboardR, hintsR, reentryR, memory, wispr] = await Promise.all([
    sauronExec(['status']),
    sauronExec(['context', '--json']),
    sauronExec(['activity', String(hours), '--json']),
    sauronExec(['timeline', '--hours', String(hours), '--json']),
    sauronExec(['clipboard', '20', '--json']),
    sauronExec(['hints', '--json']),
    sauronExec(['reentry', '--json']),
    collectMemory(),
    readWisprFlow(hours),
  ]);
  // `sauron status` is plain text; everything else is --json
  const status = statusR.ok
    ? parseSauronStatus(typeof statusR.data === 'string' ? statusR.data : '')
    : { running: false, error: statusR.error || 'sauron unavailable' };

  return {
    at: Date.now(),
    hours,
    status,
    context: contextR.ok ? contextR.data : null,
    activity: activityR.ok ? activityR.data : null,
    timeline: Array.isArray(timelineR.data) ? timelineR.data : [],
    clipboard: Array.isArray(clipboardR.data) ? clipboardR.data : [],
    wispr: wispr || { dictations: [] },
    hints: Array.isArray(hintsR.data) ? hintsR.data : [],
    reentry: reentryR.ok ? reentryR.data : null,
    memory,
    errors: {
      status: statusR.ok ? null : statusR.error,
      context: contextR.ok ? null : contextR.error,
      activity: activityR.ok ? null : activityR.error,
      timeline: timelineR.ok ? null : timelineR.error,
    },
  };
}

// Share one Sauron+ps sample across GET + every SSE client for a few seconds —
// otherwise each ACTIVITY tab fans out into 7 CLI calls + a full process scan.
const MACHINE_CACHE_TTL_MS = 8000;
const _machineCache = new Map(); // hours -> { at, promise }
function getMachineSnapshot(hours) {
  const key = String(hours);
  const hit = _machineCache.get(key);
  if (hit && Date.now() - hit.at < MACHINE_CACHE_TTL_MS) return hit.promise;
  const promise = buildMachineSnapshot(hours).then((snap) => {
    _machineCache.set(key, { at: Date.now(), promise: Promise.resolve(snap) });
    return snap;
  }, (err) => {
    _machineCache.delete(key);
    throw err;
  });
  _machineCache.set(key, { at: Date.now(), promise });
  return promise;
}
function bustMachineCache() {
  _machineCache.clear();
}
function sauronToken(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{4,96}$/.test(id);
}

const WISPR_DB = process.env.WISPR_DB_PATH
  || path.join(os.homedir(), 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite');
const WISPR_APPS = {
  'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.anthropic.claudefordesktop': 'Claude',
  'com.google.Chrome': 'Chrome',
  'com.brave.Browser': 'Brave',
  'company.thebrowser.Browser': 'Arc',
  'com.apple.Safari': 'Safari',
  'com.apple.MobileSMS': 'Messages',
  'com.apple.mail': 'Mail',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.linear': 'Linear',
  'com.figma.Desktop': 'Figma',
  'com.microsoft.VSCode': 'VS Code',
  'net.whatsapp.WhatsApp': 'WhatsApp',
  'com.hnc.Discord': 'Discord',
  'com.apple.dt.Xcode': 'Xcode',
};
function wisprAppName(bundle) {
  const s = String(bundle || '');
  if (WISPR_APPS[s]) return WISPR_APPS[s];
  const last = s.split('.').pop();
  return last || 'Wispr';
}
function sqliteJson(db, sql) {
  return new Promise((resolve) => {
    execFile('sqlite3', ['-json', db, sql], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const t = String(stdout || '').trim();
      if (!t) return resolve([]);
      try { resolve(JSON.parse(t)); } catch { resolve([]); }
    });
  });
}
async function readWisprFlow(hours) {
  const empty = { dictations: [] };
  try {
    if (!fs.existsSync(WISPR_DB)) return empty;
    const h = Math.max(0.25, Math.min(48, Number(hours) || 2));
    const rawDict = await sqliteJson(WISPR_DB, `
        SELECT timestamp AS t, app, status, numWords AS words, duration,
          substr(COALESCE(NULLIF(editedText,''), NULLIF(formattedText,''), NULLIF(asrText,''), pastedText), 1, 400) AS text
        FROM History
        WHERE IFNULL(isArchived,0)=0
          AND status IN ('formatted','raw_transcript')
          AND IFNULL(numWords,0) > 0
          AND timestamp >= datetime('now', '-${h} hours')
        ORDER BY timestamp DESC
        LIMIT 12;
      `);
    return {
      dictations: (Array.isArray(rawDict) ? rawDict : []).map((r) => ({
        t: r.t,
        app: wisprAppName(r.app),
        words: r.words,
        duration: r.duration,
        text: String(r.text || '').trim(),
      })).filter((r) => r.text),
    };
  } catch {
    return empty;
  }
}

function appFamily(comm) {
  const s = String(comm || '');
  if (/Cursor/i.test(s)) return 'Cursor';
  if (/Google Chrome/i.test(s)) return 'Chrome';
  if (/Brave Browser/i.test(s)) return 'Brave';
  if (/Spotify/i.test(s)) return 'Spotify';
  if (/Claude\.app|Claude Helper/i.test(s)) return 'Claude';
  if (/Wispr/i.test(s)) return 'Wispr Flow';
  if (/Virtualization|VirtualMachine/i.test(s)) return 'Apple VM';
  if (/iTerm/i.test(s)) return 'iTerm';
  if (/WindowServer/i.test(s)) return 'WindowServer';
  if (/corespotlight|mdworker|mds_stores/i.test(s)) return 'Spotlight';
  const base = s.split('/').pop() || s;
  return base.slice(0, 40);
}

function collectMemory() {
  return new Promise((resolve) => {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    exec('ps -axo rss=,pid=,%cpu=,pmem=,comm=', { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({
          totalMB,
          freeMB: Math.round(os.freemem() / (1024 * 1024)),
          top: [],
          apps: [],
          cpuTop: [],
          error: String(err.message || err),
        });
        return;
      }
      const rows = [];
      for (const line of String(stdout || '').split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
        if (!m) continue;
        const rssKB = Number(m[1]);
        const pid = Number(m[2]);
        const cpu = Number(m[3]);
        const pmem = Number(m[4]);
        const comm = m[5].trim();
        if (!rssKB || !comm) continue;
        rows.push({
          pid,
          rssMB: Math.round(rssKB / 1024),
          cpu,
          pmem,
          name: comm.split('/').pop() || comm,
          raw: comm,
          family: appFamily(comm),
        });
      }
      rows.sort((a, b) => b.rssMB - a.rssMB);
      const byApp = new Map();
      for (const r of rows) {
        const cur = byApp.get(r.family) || { name: r.family, rssMB: 0, count: 0 };
        cur.rssMB += r.rssMB;
        cur.count += 1;
        byApp.set(r.family, cur);
      }
      const apps = [...byApp.values()].sort((a, b) => b.rssMB - a.rssMB).slice(0, 12);
      const usedMB = rows.reduce((s, r) => s + r.rssMB, 0);

      const cpuTop = [...rows]
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 12)
        .map(({ pid, cpu, rssMB, name, family }) => ({ pid, cpu, rssMB, name, family }));

      // Cursor-specific breakdown — the usual memory hog on this machine.
      const cursorRows = rows.filter((r) => /Cursor/i.test(r.raw));
      const workspaces = new Set();
      let renderers = 0, extensionHosts = 0;
      for (const r of cursorRows) {
        if (/Renderer/i.test(r.raw)) renderers++;
        if (/extension-host/i.test(r.raw)) {
          extensionHosts++;
          // Prefer human workspace names over slot ids like [1-29]
          const named = r.raw.match(/extension-host(?:\s+\([^)]+\))?\s+([A-Za-z][A-Za-z0-9._-]*)/i);
          if (named && !/^(user|retrieval|always-local|agent-exec)$/i.test(named[1])) {
            workspaces.add(named[1]);
          }
        }
      }
      const cursor = {
        totalMB: cursorRows.reduce((s, r) => s + r.rssMB, 0),
        processes: cursorRows.length,
        renderers,
        extensionHosts,
        workspaces: [...workspaces].filter(Boolean).sort(),
      };

      resolve({
        totalMB,
        freeMB: Math.max(0, Math.round(os.freemem() / (1024 * 1024))),
        processMB: usedMB,
        top: rows.slice(0, 20).map(({ pid, rssMB, pmem, name, family }) => ({ pid, rssMB, pmem, name, family })),
        apps,
        cpuTop,
        cursor,
      });
    });
  });
}

// ---- Loopkeeper (bundled FastAPI) + optional other proxied apps ----
// Loopkeeper lives in ./loopkeeper and is spawned by this process on loopback.
// Same-origin paths below are reverse-proxied so the hub LOOPS iframe stays on :4777.
// Override with LOOPKEEPER_URL to point at an external instance (skips spawn).
const LOOPKEEPER_DIR = path.join(ROOT, 'loopkeeper');
const LOOPKEEPER_PORT = Number(process.env.LOOPKEEPER_PORT) || 18003;
let loopkeeperChild = null;

const PROXIED_APPS = [
  {
    name: 'loopkeeper',
    base: process.env.LOOPKEEPER_URL || `http://127.0.0.1:${LOOPKEEPER_PORT}`,
    paths: ['/loops', '/static/', '/guided-runs/', '/runs', '/events'],
    startHint: 'bundled under ./loopkeeper — restart npm run server (or LOOPKEEPER_URL=…)',
    managed: !process.env.LOOPKEEPER_URL,
  },
  // FACTORY embeds the Next.js UI cross-origin at http://localhost:3000 (hub.html).
  // That app talks to the Ashram backend on :3777 itself — no reverse-proxy needed here.
];

function matchProxiedApp(pathname) {
  return PROXIED_APPS.find(app => app.paths.some(p =>
    p.endsWith('/') ? pathname.startsWith(p) : (pathname === p || pathname.startsWith(p + '/'))
  ));
}

function proxyTo(app, req, res) {
  const base = new URL(app.base);
  const target = new URL(req.url, app.base);
  const preq = http.request({
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...req.headers, host: base.host },
  }, (pres) => {
    const hdrs = { ...pres.headers };
    delete hdrs['transfer-encoding'];
    res.writeHead(pres.statusCode || 502, hdrs);
    pres.pipe(res);
  });
  preq.on('error', (e) => {
    send(res, 502, JSON.stringify({
      error: `${app.name} backend unreachable`,
      hint: `Start it: ${app.startHint}`,
      detail: String(e.message || e),
    }));
  });
  req.pipe(preq);
}

function loopkeeperPythonBin() {
  const venvPy = path.join(LOOPKEEPER_DIR, 'venv', 'bin', 'python');
  if (fs.existsSync(venvPy)) return venvPy;
  return null;
}

function ensureLoopkeeperVenv() {
  return new Promise((resolve, reject) => {
    if (loopkeeperPythonBin()) { resolve(loopkeeperPythonBin()); return; }
    console.log('Loopkeeper: creating venv + installing requirements (one-time)…');
    const venvDir = path.join(LOOPKEEPER_DIR, 'venv');
    // Prefer 3.12 — pinned FastAPI/pydantic wheels fail on newer system Python (e.g. 3.14).
    const pyCandidates = ['python3.12', 'python3.11', 'python3'];
    const tryNext = (i) => {
      if (i >= pyCandidates.length) {
        reject(new Error('no python3.12/3.11/3 found for Loopkeeper venv'));
        return;
      }
      execFile(pyCandidates[i], ['-m', 'venv', venvDir], { cwd: LOOPKEEPER_DIR }, (err) => {
        if (err) { tryNext(i + 1); return; }
        const pip = path.join(venvDir, 'bin', 'pip');
        execFile(pip, ['install', '-r', 'requirements.txt'], {
          cwd: LOOPKEEPER_DIR,
          maxBuffer: 20 * 1024 * 1024,
        }, (err2) => {
          if (err2) { reject(err2); return; }
          resolve(loopkeeperPythonBin());
        });
      });
    };
    tryNext(0);
  });
}

function loopkeeperHealthy() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: Number(process.env.LOOPKEEPER_PORT) || LOOPKEEPER_PORT, path: '/health', timeout: 1500 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function waitForLoopkeeper(tries = 40) {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < tries; i++) {
      if (await loopkeeperHealthy()) { resolve(); return; }
      await new Promise((r) => setTimeout(r, 250));
    }
    reject(new Error(`Loopkeeper did not become healthy on :${LOOPKEEPER_PORT}`));
  });
}

function stopLoopkeeper() {
  if (!loopkeeperChild || loopkeeperChild.killed) return;
  try { loopkeeperChild.kill('SIGTERM'); } catch { /* ignore */ }
  loopkeeperChild = null;
}

async function startManagedLoopkeeper() {
  const app = PROXIED_APPS.find((a) => a.name === 'loopkeeper');
  if (!app || !app.managed) {
    console.log(`Loopkeeper: using external ${app ? app.base : '(none)'}`);
    return;
  }
  if (!fs.existsSync(path.join(LOOPKEEPER_DIR, 'start_embedded.py'))) {
    console.warn('Loopkeeper: ./loopkeeper missing — LOOPS tab will 502');
    return;
  }
  if (await loopkeeperHealthy()) {
    console.log(`Loopkeeper: already up on :${LOOPKEEPER_PORT}`);
    return;
  }
  const py = await ensureLoopkeeperVenv();
  const env = {
    ...process.env,
    PORT: String(Number(process.env.LOOPKEEPER_PORT) || LOOPKEEPER_PORT),
    HOST: '127.0.0.1',
  };
  // Rosetta (x64) Node inherits x86_64 into children; force arm64 so native wheels load.
  const useArch = process.platform === 'darwin' && process.arch === 'x64';
  loopkeeperChild = spawn(
    useArch ? 'arch' : py,
    useArch ? ['-arm64', py, 'start_embedded.py'] : ['start_embedded.py'],
    {
      cwd: LOOPKEEPER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const tag = (buf) => {
    const t = String(buf).trimEnd();
    if (t) console.log(t.split('\n').map((l) => `[loopkeeper] ${l}`).join('\n'));
  };
  loopkeeperChild.stdout.on('data', tag);
  loopkeeperChild.stderr.on('data', tag);
  loopkeeperChild.on('exit', (code, signal) => {
    console.warn(`[loopkeeper] exited code=${code} signal=${signal || ''}`);
    loopkeeperChild = null;
  });
  await waitForLoopkeeper();
  console.log(`Loopkeeper: managed child pid=${loopkeeperChild.pid} → ${app.base}`);
}

process.on('exit', () => { stopLoopkeeper(); tts.stop(); });
process.on('SIGINT', () => { stopLoopkeeper(); tts.stop(); process.exit(0); });
process.on('SIGTERM', () => { stopLoopkeeper(); tts.stop(); process.exit(0); });

// ---- zero-dep .env reader (.env wins over inherited shell env) ----
function loadEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Prefer project .env over a stale exported shell key (common OpenRouter footgun).
      process.env[key] = val;
    }
  } catch { /* no .env is fine */ }
}

loadEnvFile(path.join(ROOT, '.env'));
{
  const app = PROXIED_APPS.find((a) => a.name === 'loopkeeper');
  if (app && !process.env.LOOPKEEPER_URL) {
    const p = Number(process.env.LOOPKEEPER_PORT) || 18003;
    app.base = `http://127.0.0.1:${p}`;
  } else if (app && process.env.LOOPKEEPER_URL) {
    app.base = process.env.LOOPKEEPER_URL;
    app.managed = false;
  }
}

// Keystroke that triggers Wispr Flow. Default = F13 (key code 105) — a dead key
// that does nothing else, so set Wispr Flow's activation shortcut to F13.
// Override with:  WISPR_CMD="osascript -e '...'" npm run server
const WISPR_CMD = process.env.WISPR_CMD || `osascript -e 'tell application "System Events" to key code 105'`;

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const CURSOR_SHOT_NAME = '.tmp-activity-cursor';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CURSOR_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';

function clampWords(text, max = 50) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= max) return { summary: words.join(' '), words: words.length };
  const clipped = words.slice(0, max).join(' ');
  return { summary: clipped, words: max };
}

function decodeImagePayload(image) {
  if (!image || typeof image !== 'string') return null;
  const s = image.trim();
  if (!s) return null;
  const m = s.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (m) return { mime: m[1].toLowerCase(), buf: Buffer.from(m[2], 'base64'), dataUrl: s };
  // raw base64 — assume jpeg
  try {
    const buf = Buffer.from(s.replace(/\s+/g, ''), 'base64');
    if (!buf.length) return null;
    return { mime: 'image/jpeg', buf, dataUrl: 'data:image/jpeg;base64,' + s.replace(/\s+/g, '') };
  } catch {
    return null;
  }
}

function decodeFilePayload(data, fallbackMime) {
  if (!data || typeof data !== 'string') return null;
  const s = data.trim();
  if (!s) return null;
  const m = s.match(/^data:([^;,]+);base64,(.+)$/i);
  if (m) return { mime: m[1].toLowerCase(), buf: Buffer.from(m[2], 'base64') };
  const img = decodeImagePayload(s);
  if (img) return { mime: img.mime, buf: img.buf };
  if (fallbackMime) {
    try {
      const buf = Buffer.from(s.replace(/\s+/g, ''), 'base64');
      if (buf.length) return { mime: fallbackMime, buf };
    } catch { /* ignore */ }
  }
  return null;
}

function fallbackCursorSummary(ctx = {}) {
  const bits = [];
  bits.push(ctx.surface === 'hub' ? 'Valinor hub' : 'Valinor ACTIVITY');
  if (ctx.activeTab) bits.push(`tab ${String(ctx.activeTab).slice(0, 40)}`);
  if (ctx.parked?.length) bits.push(`parked ${ctx.parked.slice(0, 6).join(', ')}`);
  if (ctx.hours != null) bits.push(`${ctx.hours}h window`);
  if (ctx.filter && ctx.filter !== 'all') bits.push(`filter ${ctx.filter}`);
  if (ctx.statusLine) bits.push(String(ctx.statusLine).replace(/<[^>]+>/g, '').slice(0, 80));
  if (ctx.pointLabel) bits.push(`cursor on: ${String(ctx.pointLabel).slice(0, 60)}`);
  else if (ctx.panel) bits.push(`panel ${ctx.panel}`);
  if (ctx.trailLine) bits.push(`trail ${String(ctx.trailLine).slice(0, 90)}`);
  else if (ctx.trail?.path) bits.push(`trail ${String(ctx.trail.path).slice(0, 90)}`);
  if (ctx.rectLine) bits.push(String(ctx.rectLine).slice(0, 60));
  else if (ctx.rect) bits.push(`rect ${ctx.rect.x},${ctx.rect.y} ${ctx.rect.w}×${ctx.rect.h}`);
  if (ctx.tool && ctx.tool !== 'pen') bits.push(`tool ${ctx.tool}`);
  if (ctx.hwLine) bits.push(String(ctx.hwLine).slice(0, 50));
  if (ctx.nowLine) bits.push(String(ctx.nowLine).slice(0, 50));
  return clampWords(bits.filter(Boolean).join('. ') + '.', 50);
}

async function summarizeCursorContext({ imageUrl, context }, apiKey) {
  if (!apiKey) return { ...fallbackCursorSummary(context), source: 'fallback-no-key' };
  const ctx = context || {};
  const trail = ctx.trail || null;
  const trailHint = ctx.trailLine
    || (trail?.path
      ? `last ${(trail.spanMs / 1000).toFixed(1)}s · ${trail.distancePx || 0}px · ${trail.path}`
      : null);
  const isHub = ctx.surface === 'hub' || ctx.activeTab;
  const hintLines = [
    isHub
      ? `Hub tab: ${ctx.activeTab || ctx.activeKey || '?'} · loaded [${(ctx.loaded || []).join(', ') || '—'}] · parked [${(ctx.parked || []).join(', ') || 'none'}]`
      : `Window: ${ctx.hours != null ? ctx.hours + 'h' : '?'} · filter ${ctx.filter || 'all'}`,
    ctx.statusLine ? `Status: ${String(ctx.statusLine).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}` : null,
    ctx.panel ? `Active panel/tab: ${ctx.panel}` : null,
    ctx.pointLabel ? `Cursor pointing at: ${ctx.pointLabel}` : null,
    ctx.pointFrame ? `Under frame: ${String(ctx.pointFrame).slice(0, 120)}` : null,
    ctx.pointText ? `Nearby text: ${String(ctx.pointText).slice(0, 200)}` : null,
    trailHint ? `Mouse path (previous ~5s): ${String(trailHint).slice(0, 240)}` : null,
    trail?.samples?.length
      ? `Trail samples (agoMs,x,y): ${trail.samples.map((s) => `${s.agoMs}:${s.x},${s.y}`).join(' · ').slice(0, 220)}`
      : null,
    ctx.tool ? `Cursor tool: ${ctx.tool}` : null,
    ctx.rectLine
      ? `Selection rect: ${String(ctx.rectLine).slice(0, 80)}`
      : (ctx.rect ? `Selection rect: ${ctx.rect.x},${ctx.rect.y} ${ctx.rect.w}×${ctx.rect.h}` : null),
    ctx.hwLine ? `HW: ${ctx.hwLine}` : null,
    ctx.nowLine ? `Now: ${ctx.nowLine}` : null,
    ctx.pinned != null ? `Cursor ${ctx.pinned ? 'pinned' : 'following'}` : null,
    ctx.xy ? `Cursor xy: ${ctx.xy}` : null,
  ].filter(Boolean).join('\n');

  const userContent = [
    {
      type: 'text',
      text:
        (isHub
          ? 'Summarize this Valinor hub screen for an agent or human in ≤50 words. '
            + 'Be factual about the active tab, any parked/loaded tabs, what the cursor is pointing at, the recent mouse path (last ~5 seconds), and any selection rectangle if present. '
          : 'Summarize this Valinor ACTIVITY screen for an agent or human in ≤50 words. '
            + 'Be factual about what is visible, what the cursor is pointing at, the recent mouse path (last ~5 seconds), any selection rectangle if present, and the current ACTIVITY UI state. ')
        + 'No preamble, no markdown, no quotes.\n\nDOM / UI hints:\n' + hintLines,
    },
  ];
  if (imageUrl) userContent.push({ type: 'image_url', image_url: { url: imageUrl } });

  const t0 = Date.now();
  const upstream = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4777',
      'X-Title': 'valinor-activity-cursor',
    },
    body: JSON.stringify({
      model: CURSOR_VISION_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You write ultra-short factual screen summaries (≤50 words) for agents. Output only the summary.',
        },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 120,
      stream: false,
      usage: { include: true },
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    let msg = errText.slice(0, 240);
    try { msg = JSON.parse(errText).error?.message || msg; } catch { /* keep */ }
    agentUsage.record({
      surface: 'cursor', model: CURSOR_VISION_MODEL, latencyMs: Date.now() - t0, ok: false, label: 'activity',
    });
    const fb = fallbackCursorSummary(ctx);
    return { ...fb, source: 'fallback-api', error: String(msg) };
  }

  const json = await upstream.json();
  const usage = json.usage || {};
  const raw = String(json.choices?.[0]?.message?.content || '').trim();
  const clamped = clampWords(raw.replace(/^["']|["']$/g, ''), 50);
  agentUsage.record({
    surface: 'cursor',
    model: json.model || CURSOR_VISION_MODEL,
    latencyMs: Date.now() - t0,
    usage,
    cost: usage.cost ?? null,
    ok: true,
    label: 'activity',
    input: '[screenshot]',
    output: clamped.summary || raw,
  });
  if (!clamped.summary) return { ...fallbackCursorSummary(ctx), source: 'fallback-empty' };
  return { ...clamped, source: 'model' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// binary-safe reader — readBody() coerces chunks through utf8, which corrupts audio bytes
function readRawBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': ok\n\n');
}

let restartScheduled = false;
let restartSpawned = false;

const server = http.createServer(async (req, res) => {
  const full = req.url || '/';
  const qIdx = full.indexOf('?');
  const url = qIdx >= 0 ? full.slice(0, qIdx) : full;
  const search = qIdx >= 0 ? full.slice(qIdx + 1) : '';
  const params = new URLSearchParams(search);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ---- reverse-proxied apps (before handviz routes / static files) ----
  const proxied = matchProxiedApp(url);
  if (proxied) { proxyTo(proxied, req, res); return; }

  // ---- agent: voice → tool loop (SSE) ----
  if (url === '/api/agent' && req.method === 'POST') {
    startSse(res);
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      await runAgentTurn(res, body, apiKey);
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ type: 'error', message: String(e.message || e) })}\n\n`); } catch {}
    }
    try { res.end(); } catch {}
    return;
  }

  // ---- local Kitten TTS (live companion voice) ----
  if (url === '/api/tts' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify(await tts.status()));
    } catch (e) {
      send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/tts' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const out = await tts.synthesize(body.text, body.voice, body.speed);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-TTS-Voice': out.voice || '',
        'X-TTS-Ms': String(out.ms == null ? '' : out.ms),
      });
      res.end(out.buffer);
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // ---- live companion: speech finals → streamed reply + durable session ----
  if (url === '/api/live' && req.method === 'GET') {
    send(res, 200, JSON.stringify({ messages: getHistory() }));
    return;
  }
  if (url === '/api/live/memory' && req.method === 'GET') {
    send(res, 200, JSON.stringify(getValinorMemory()));
    return;
  }
  if (url === '/api/live/memory/open' && req.method === 'POST') {
    const mem = getValinorMemory();
    if (process.platform !== 'darwin') {
      send(res, 400, JSON.stringify({ ok: false, error: 'Open is macOS-only' }));
      return;
    }
    execFile('open', [mem.path], (err) => {
      send(res, err ? 500 : 200, JSON.stringify({
        ok: !err,
        displayPath: mem.displayPath,
        error: err ? String(err.message || err) : undefined,
      }));
    });
    return;
  }
  if (url === '/api/live' && req.method === 'DELETE') {
    clearSession();
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  // ---- live threads: topic list, switch, new, continue-from-harness ----
  if (url === '/api/live/conversations' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify({ conversations: listLiveConversations() }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live/conversation' && req.method === 'GET') {
    const c = getLiveConversation(params.get('id') || '');
    if (!c) { send(res, 404, JSON.stringify({ error: 'not found' })); return; }
    send(res, 200, JSON.stringify(c));
    return;
  }
  if (url === '/api/live/conversation/new' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const c = await newLiveConversation(body.title || '');
      send(res, 200, JSON.stringify(c));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live/conversation/switch' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const c = await switchLiveConversation(String(body.id || ''));
      send(res, 200, JSON.stringify(c));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live/conversation/continue' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const c = await continueImportedConversation({
        title: body.title || '',
        source: body.source || '',
        transcript: body.transcript || '',
        messages: Array.isArray(body.messages) ? body.messages : [],
      });
      send(res, 200, JSON.stringify(c));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // ---- live system-prompt lab: edit / dry-run / refine / revert Val's voice prompt ----
  if (url === '/api/live/prompt' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify(livePrompt.getLab()));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live/prompt' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const out = livePrompt.deployPrompt(body.prompt || '', body.note || '');
      try { await resetLivePi(); } catch { /* session resets on next turn */ }
      send(res, 200, JSON.stringify({ ok: true, ...out, versions: livePrompt.getLab().versions }));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live/prompt/test' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const out = await livePrompt.testPrompt(body.prompt || '', body.input || '', process.env.OPENROUTER_API_KEY || '');
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live/prompt/refine' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const out = await livePrompt.refinePrompt({
        prompt: body.prompt || '',
        testInput: body.testInput || '',
        testResponse: body.testResponse || '',
        feedback: body.feedback || '',
      }, process.env.OPENROUTER_API_KEY || '');
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live/prompt/revert' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const out = livePrompt.revertVersion(String(body.id || ''));
      try { await resetLivePi(); } catch { /* session resets on next turn */ }
      send(res, 200, JSON.stringify({ ok: true, ...out, versions: livePrompt.getLab().versions }));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/live' && req.method === 'POST') {
    startSse(res);
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      await runLiveTurn(res, body, apiKey);
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ type: 'error', message: String(e.message || e) })}\n\n`); } catch {}
    }
    try { res.end(); } catch {}
    return;
  }

  // ---- rehearse: mock interview partner (SSE turns + cloud TTS) ----
  if (url === '/api/rehearse' && req.method === 'GET') {
    const s = rehearse.getSession(params.get('sessionId') || '');
    if (!s) { send(res, 404, JSON.stringify({ error: 'unknown session' })); return; }
    // Never leak companion context — history only.
    send(res, 200, JSON.stringify({
      sessionId: s.id, sessionType: s.type, mode: s.mode,
      sessionNumber: s.sessionNumber, depth: s.depth, turns: s.turns,
      history: s.history,
    }));
    return;
  }
  if (url === '/api/rehearse' && req.method === 'POST') {
    startSse(res);
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    const ac = new AbortController();
    let settled = false;
    // res (not req) 'close': req 'close' fires as soon as the POST body is
    // consumed, which would abort every turn instantly. res 'close' fires on
    // client disconnect (barge-in / Stop / tab switch) or after res.end().
    res.on('close', () => {
      // Client disconnected (barge-in / Stop / tab switch) — halt the OpenRouter stream.
      if (!settled) { settled = true; try { ac.abort(); } catch {} }
    });
    try {
      await rehearse.runRehearseTurn(res, body, apiKey, { signal: ac.signal });
    } catch (e) {
      if (!ac.signal.aborted) {
        try { res.write(`data: ${JSON.stringify({ type: 'error', message: String(e.message || e) })}\n\n`); } catch {}
      }
    }
    settled = true;
    try { res.end(); } catch {}
    return;
  }
  if (url === '/api/rehearse' && req.method === 'DELETE') {
    const ok = rehearse.endSession(params.get('sessionId') || '');
    send(res, ok ? 200 : 404, JSON.stringify(ok ? { ok: true } : { error: 'unknown session' }));
    return;
  }
  if (url === '/api/rehearse/tts' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await rehearse.synthesizeRehearseTts(body.text, apiKey, {
        voice: body.voice, format: body.format,
      });
      res.writeHead(200, {
        'Content-Type': out.contentType || 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-TTS-Model': out.model || '',
        'X-TTS-Ms': String(out.ms == null ? '' : out.ms),
        ...(out.cached ? { 'X-TTS-Cache': 'hit' } : {}),
      });
      res.end(out.buffer);
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // ---- speech fallback: record → transcribe via an audio-capable OpenRouter model.
  // Used by board/rehearse when the browser's own SpeechRecognition can't reach Google's
  // cloud STT (Electron, non-Chrome Chromium, blocked networks) — see agent-server.js.
  if (url === '/api/transcribe' && req.method === 'POST') {
    let raw;
    try { raw = await readRawBody(req); } catch (e) { send(res, 413, JSON.stringify({ error: String(e.message || e) })); return; }
    if (!raw.length) { send(res, 400, JSON.stringify({ error: 'empty audio' })); return; }
    const ctype = req.headers['content-type'] || 'audio/webm';
    const format = /ogg/i.test(ctype) ? 'ogg' : /mp4|m4a/i.test(ctype) ? 'mp4' : /wav/i.test(ctype) ? 'wav' : 'webm';
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const result = await transcribeAudio({ audioBase64: raw.toString('base64'), format }, apiKey);
      send(res, 200, JSON.stringify(result));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // ---- ingest store: voice capture -> refine+plan -> markdown file (PRIVATE) ----
  if (url === '/api/ingest/capture' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const rec = await ingest.capture(body, apiKey);
      send(res, 200, JSON.stringify(rec));
      // Epic 1: auto-render this capture into an EXECUTE suggestion in the BACKGROUND.
      // Fire-and-forget AFTER the response is flushed — never awaited, so capture latency
      // is unchanged (P8). Failures are swallowed/logged, never surfaced to capture. The
      // manual "Scan ingest" button remains the backstop for anything this misses.
      if (rec && rec.id) {
        Promise.resolve()
          .then(() => execute.renderNoteToSuggestion(rec.id, apiKey))
          .catch((err) => console.warn('[ingest] auto-render failed:', err && err.message ? err.message : err));
      }
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/ingest' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify({ items: ingest.listCaptures(200), dir: ingest.INGEST_DIR }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/ingest/item' && req.method === 'GET') {
    const rec = ingest.readCapture(params.get('id'));
    if (!rec) { send(res, 404, JSON.stringify({ error: 'not found' })); return; }
    send(res, 200, JSON.stringify(rec));
    return;
  }
  if (url === '/api/ingest/item' && req.method === 'DELETE') {
    const ok = ingest.deleteCapture(params.get('id'));
    if (!ok) { send(res, 404, JSON.stringify({ error: 'not found' })); return; }
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  if (url === '/api/ingest/media' && req.method === 'GET') {
    const fileParam = params.get('file');
    const media = fileParam ? ingest.readMediaFile(params.get('id'), fileParam) : ingest.readMedia(params.get('id'));
    if (!media) { send(res, 404, JSON.stringify({ error: 'not found' })); return; }
    res.writeHead(200, {
      'Content-Type': media.mime,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(media.buffer);
    return;
  }
  // pull Apple Notes (incl. phone notes via iCloud) into the store — manual sync button
  if (url === '/api/ingest/apple-notes/sync' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const summary = await appleNotes.importNotes({ folder: body.folder || null });
      send(res, 200, JSON.stringify(summary));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // scan recent Apple Photos → export + thumbnail candidates for the picker (pick-first)
  if (url === '/api/ingest/apple-photos/scan' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const out = await applePhotos.scanRecent({ hours: Number(body.hours) || 48, max: Number(body.max) || 150 });
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // serve a cached photo thumbnail for the picker
  if (url === '/api/ingest/apple-photos/thumb' && req.method === 'GET') {
    const p = applePhotos.thumbPath(params.get('token'));
    if (!p) { send(res, 404, JSON.stringify({ error: 'not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=600' });
    res.end(fs.readFileSync(p));
    return;
  }
  // ingest the chosen photos (caption + write into store)
  if (url === '/api/ingest/apple-photos/ingest' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await applePhotos.ingestSelected({ tokens: Array.isArray(body.tokens) ? body.tokens : [] }, apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // manually re-scan the Mac screenshots folder (also runs automatically on boot)
  if (url === '/api/ingest/screenshots/sync' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await screenshots.importScreenshots({ sinceHours: Number(body.sinceHours) || undefined }, apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // ---- pull integrations: config + email + imessage + pull-all ----
  if (url === '/api/ingest/integrations' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify(integrations.getConfig()));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/ingest/integrations' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      send(res, 200, JSON.stringify(integrations.saveConfig(body)));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/ingest/email/sync' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const cfg = integrations.getConfig().email;
      const out = await emailIngest.importEmails({
        mailbox: body.mailbox || cfg.mailbox,
        days: body.days || cfg.days,
        max: body.max || cfg.max,
      });
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/ingest/imessage/sync' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const cfg = integrations.getConfig().imessage;
      const out = await imessageIngest.importMessages({
        days: body.days || cfg.days,
        maxChats: body.maxChats || cfg.maxChats,
        perChat: body.perChat || cfg.perChat,
      });
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // pull from all non-interactive sources (photos stays pick-first in its modal)
  if (url === '/api/ingest/pull-all' && req.method === 'POST') {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    const cfg = integrations.getConfig();
    const out = {};
    const run = async (key, fn) => {
      try { out[key] = { ok: true, ...(await fn()) }; }
      catch (e) { out[key] = { ok: false, error: String(e.message || e) }; }
    };
    await run('notes', () => appleNotes.importNotes({}));
    await run('screenshots', () => screenshots.importScreenshots({}, apiKey));
    await run('email', () => emailIngest.importEmails(cfg.email));
    await run('imessage', () => imessageIngest.importMessages(cfg.imessage));
    send(res, 200, JSON.stringify(out));
    return;
  }
  // enhance a note into ONE tangible outcome (the PLAN step, on demand)
  if (url === '/api/ingest/enhance' && req.method === 'POST') {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await ingest.enhance(params.get('id'), apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // materialize a conversation record as a stable ingest capture (source 'convo'),
  // so convos merged into the ingest list can route to Writing / Execute / Enhance.
  // idempotent: same convoId always yields the same capture id.
  if (url === '/api/ingest/materialize' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const convoId = String(body.convoId || '').trim();
      if (!convoId) throw Object.assign(new Error('convoId required'), { status: 400 });
      const safe = convoId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
      const id = `convo-${safe}`;
      const title = String(body.title || convoId).slice(0, 120) || convoId;
      const created = String(body.created || '') || new Date().toISOString();
      const md = String(body.body || '');
      const out = ingest.writeCapture({
        id, created, source: 'convo', title,
        raw: md, refined: '', plan: '', nextAction: '',
        tags: ['ingest', 'convo'],
      });
      send(res, 200, JSON.stringify({ id: out.id }));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // ---- execute store: tangible outcomes -> tasks (Backlog/Active/Review/Done) PRIVATE ----
  if (url === '/api/execute' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify({ tasks: execute.listTasks(), dir: execute.EXECUTE_DIR }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const task = execute.createTask(body);
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/scan' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await execute.scanIngest(apiKey, {
        sinceHours: body.sinceHours,
        limit: body.limit,
      });
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/promote' && req.method === 'POST') {
    try {
      const task = execute.promoteTask(params.get('id'));
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/archive' && req.method === 'POST') {
    try {
      const task = execute.archiveTask(params.get('id'));
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/archive-done' && req.method === 'POST') {
    try {
      const out = execute.archiveCompleted();
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/evals' && req.method === 'GET') {
    try {
      const out = execute.evalRuns({ limit: params.get('limit') });
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/item' && req.method === 'PATCH') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const task = execute.updateTask(params.get('id'), body);
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/item' && req.method === 'DELETE') {
    const ok = execute.deleteTask(params.get('id'));
    if (!ok) { send(res, 404, JSON.stringify({ error: 'not found' })); return; }
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  if (url === '/api/execute/start' && req.method === 'POST') {
    try {
      const task = execute.startTask(params.get('id'));
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/unstep' && req.method === 'POST') {
    try {
      const task = execute.unstepTask(params.get('id'));
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // Manual completion step: Active -> Review. Requires proof (it unlocks Review).
  if (url === '/api/execute/toreview' && req.method === 'POST') {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const task = await execute.sendToReview(params.get('id'), apiKey);
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/proof' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const decoded = decodeFilePayload(body.file || body.image, body.mime);
    if (!decoded?.buf?.length) { send(res, 400, JSON.stringify({ error: 'proof file required' })); return; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const task = await execute.attachProof(
        { id: params.get('id'), buf: decoded.buf, mime: body.mime || decoded.mime, filename: body.name }, apiKey);
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/review' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try {
      const task = execute.saveReview(params.get('id'), body.answer);
      // Loop-back: write the review Q&A into the ingest store as a fresh note.
      try {
        const q = task.review?.question || '';
        const a = task.review?.answer || '';
        ingest.writeCapture({
          source: 'review',
          title: `Review · ${task.title}`.slice(0, 80),
          refined: [q ? `Q: ${q}` : '', a ? `A: ${a}` : ''].filter(Boolean).join('\n'),
          plan: [],
          nextAction: '',
          tags: ['ingest', 'review'],
        });
      } catch (e) {
        console.warn('[execute] review loop-back to ingest failed:', e && e.message ? e.message : e);
      }
      send(res, 200, JSON.stringify(task));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/proof/media' && req.method === 'GET') {
    const media = execute.readProof(params.get('id'));
    if (!media) { send(res, 404, JSON.stringify({ error: 'not found' })); return; }
    const inline = /^image\//i.test(media.mime);
    const disp = inline ? 'inline' : 'attachment';
    const filename = String(media.name || 'proof').replace(/[\r\n"]/g, '');
    res.writeHead(200, {
      'Content-Type': media.mime,
      'Content-Disposition': `${disp}; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(media.buffer);
    return;
  }

  // ---- execute planning: decompose a task + schedule the day + prompt lab ----
  // Decompose proposes (never persists). Promote chosen pieces via POST /api/execute
  // with { parentTaskId } so the split lineage stays queryable.
  if (url === '/api/execute/decompose' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const fromTask = body.id ? execute.getTask(body.id) : null;
      const out = await executePlan.decompose({
        title: body.title || (fromTask && fromTask.title) || '',
        outcome: body.outcome || (fromTask && fromTask.outcome) || '',
        why: body.why || (fromTask && fromTask.why) || '',
        sourceBody: body.sourceBody || (fromTask && (fromTask.sourceBody || fromTask.outcome)) || '',
      }, apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // Suggest hour blocks for backlog tasks not yet scheduled on the given date.
  if (url === '/api/execute/schedule/suggest' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : today;
      // Default day-start is NOW (rounded up to the next quarter hour) when
      // scheduling today — never book the morning again at 3pm. Future dates
      // still start at 09:00 unless the caller says otherwise.
      const minsToAdd = (15 - (d.getMinutes() % 15)) % 15;
      const q = new Date(d.getTime() + minsToAdd * 60000);
      q.setSeconds(0, 0);
      if (q <= d) q.setTime(q.getTime() + 15 * 60000); // exact-boundary + seconds guard
      const nowQ = `${String(q.getHours()).padStart(2, '0')}:${String(q.getMinutes()).padStart(2, '0')}`;
      const isToday = date === today;
      const startHour = /^\d{2}:\d{2}$/.test(String(body.startHour || ''))
        ? body.startHour
        : (isToday ? nowQ : '09:00');
      const open = execute.listTasks().filter((t) =>
        (t.status === 'backlog' && (t.kind || 'task') !== 'suggestion' && !t.blockKind) &&
        (!t.scheduled_block || t.scheduled_block.date !== date));
      const out = await executePlan.suggestSchedule({
        tasks: open.map((t) => ({ id: t.id, title: t.title, outcome: t.outcome, duration_bucket: t.duration_bucket })),
        date,
        startHour,
        currentTime: isToday ? nowQ : null,
        busy: execute.listTasks()
          .filter((t) => t.scheduled_block && t.scheduled_block.date === date && t.status !== 'archived' && t.status !== 'done')
          .map((t) => ({ start: t.scheduled_block.start, end: t.scheduled_block.end, label: t.title })),
      }, apiKey);
      send(res, 200, JSON.stringify({ ...out, considered: open.length }));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/plan/lab' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify(executePlan.getLab())); }
    catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/execute/plan/lab' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try { send(res, 200, JSON.stringify(executePlan.deployPrompt(body.prompt || '', body.note || ''))); }
    catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/execute/plan/lab/test' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await executePlan.decompose({
        title: '', outcome: String(body.input || ''),
        prompt: body.prompt || '',
      }, apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/plan/lab/refine' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await executePlan.refinePrompt({
        prompt: body.prompt || '',
        testInput: body.testInput || '',
        testResponse: body.testResponse || '',
        feedback: body.feedback || '',
      }, apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/execute/plan/lab/revert' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    try { send(res, 200, JSON.stringify(executePlan.revertVersion(String(body.id || '')))); }
    catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/execute/plan/runs' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify({ runs: executePlan.listRuns(params.get('limit')) })); }
    catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }

  // ---- agent trace bus (SSE broadcast + ring replay) ----
  if (url === '/api/agent/trace' && req.method === 'GET') {
    startSse(res);
    subscribeTrace(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
    }, 15000);
    res.on('close', () => clearInterval(ping));
    return;
  }

  // ---- agent usage monitor (ACTIVITY-style aggregates across OpenRouter surfaces) ----
  if (url === '/api/agent/usage' && req.method === 'GET') {
    const hours = Number(params.get('hours')) || 2;
    send(res, 200, JSON.stringify(agentUsage.getSnapshot(hours)));
    return;
  }

  if (url === '/api/agent/usage/stream' && req.method === 'GET') {
    const hours = Number(params.get('hours')) || 2;
    startSse(res);
    let closed = false;
    let ping = null;
    const pushSnap = () => {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(agentUsage.getSnapshot(hours))}\n\n`); }
      catch { cleanup(); }
    };
    const unsub = agentUsage.subscribe(() => pushSnap());
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      unsub();
    };
    req.on('close', cleanup);
    pushSnap();
    ping = setInterval(() => {
      if (closed) return;
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 15000);
    return;
  }

  // ---- frame proxy: strip XFO/CSP so the mini-browser can embed stubborn sites ----
  if (url === '/api/proxy' && req.method === 'GET') {
    const target = params.get('url');
    if (!target) { send(res, 400, 'missing url', 'text/plain'); return; }
    let parsed;
    try { parsed = new URL(target); } catch { send(res, 400, 'bad url', 'text/plain'); return; }
    if (!/^https?:$/.test(parsed.protocol)) { send(res, 400, 'only http(s)', 'text/plain'); return; }
    try {
      const upstream = await fetch(parsed.toString(), {
        headers: {
          'User-Agent': 'handviz-proxy/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      const ctype = (upstream.headers.get('content-type') || 'text/html').split(';')[0].trim();
      let buf = Buffer.from(await upstream.arrayBuffer());
      if (ctype.includes('html')) {
        let html = buf.toString('utf8');
        if (!/<base\s/i.test(html)) {
          html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${parsed.origin}${parsed.pathname.replace(/[^/]*$/, '')}">`);
        }
        buf = Buffer.from(html, 'utf8');
      }
      res.writeHead(upstream.status, {
        'Content-Type': ctype + (ctype.includes('text') || ctype.includes('json') || ctype.includes('javascript') ? '; charset=utf-8' : ''),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch (e) {
      send(res, 502, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // ---- letters: real markdown files in ./letters ----
  if (url === '/api/letters' && req.method === 'GET') {
    try {
      if (!fs.existsSync(LETTERS)) fs.mkdirSync(LETTERS);
      const list = fs.readdirSync(LETTERS).filter(f => f.endsWith('.md')).map(f => {
        const p = path.join(LETTERS, f), st = fs.statSync(p);
        return { file: f, path: p, mtime: st.mtimeMs, preview: fs.readFileSync(p, 'utf8').slice(0, 500) };
      }).sort((a, b) => b.mtime - a.mtime);
      send(res, 200, JSON.stringify({ dir: LETTERS, letters: list }));
    } catch (e) { send(res, 500, JSON.stringify({ error: String(e) })); }
    return;
  }
  async function gatherSessionPacket(hours) {
    const [recentR, machineSnapshot] = await Promise.all([
      sauronExec(['experience', 'recent', '80', '--json']),
      getMachineSnapshot(hours).catch(() => null),
    ]);
    const sauronRecent = Array.isArray(recentR.data) ? recentR.data : [];
    return letterSession.gather({
      hours,
      ingest,
      execute,
      getHistory,
      sauronRecent,
      machineSnapshot,
      agentSnapshot: agentUsage.getSnapshot(hours),
    });
  }
  if (url === '/api/letters/from-session' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const hours = Math.max(0.25, Math.min(6, Number(body.hours) || 1));
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const gathered = await gatherSessionPacket(hours);
      const letter = await letterSession.writeFromSession(gathered, apiKey);
      if (!fs.existsSync(LETTERS)) fs.mkdirSync(LETTERS);
      const d = new Date();
      const file = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getTime().toString(36)}.md`;
      const fp = path.join(LETTERS, file);
      fs.writeFileSync(fp, letter.body);
      send(res, 200, JSON.stringify({ file, path: fp, title: letter.title, hours }));
    } catch (e) {
      send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // ---- session reflection prompt: editable system prompt behind "From this hour" ----
  if (url === '/api/letters/session-prompt' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify(letterSession.getPrompt())); }
    catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/letters/session-prompt/test' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const hours = Math.max(0.25, Math.min(6, Number(b.hours) || 1));
      const apiKey = process.env.OPENROUTER_API_KEY || '';
      const gathered = await gatherSessionPacket(hours);
      const out = await letterSession.testSessionPrompt({ prompt: b.prompt, gathered }, apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/letters/session-prompt/refine' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const apiKey = process.env.OPENROUTER_API_KEY || '';
      const out = await letterSession.refineSessionPrompt({
        prompt: b.prompt, testTitle: b.testTitle, testBody: b.testBody,
        feedback: b.feedback, runId: b.runId,
      }, apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/letters/session-prompt/runs' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify(letterSession.listPromptRuns())); }
    catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/letters/session-prompt/revert' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const out = letterSession.revertPromptRun(b.id, b.which);
      send(res, 200, JSON.stringify(out));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/letters/session-prompt' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const saved = b.reset ? letterSession.resetPrompt() : letterSession.savePrompt(b.prompt);
      send(res, 200, JSON.stringify(saved));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  const lm = url.match(/^\/api\/letter\/([\w][\w.-]*\.md)$/);
  if (lm) {
    const fp2 = path.join(LETTERS, lm[1]);
    if (!fs.existsSync(LETTERS)) fs.mkdirSync(LETTERS);
    if (req.method === 'GET') {
      fs.readFile(fp2, 'utf8', (e, d) => e ? send(res, 404, 'not found', 'text/plain') : send(res, 200, d, 'text/markdown'));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => { try { fs.writeFileSync(fp2, body); send(res, 200, JSON.stringify({ ok: true, path: fp2 })); } catch (e) { send(res, 500, '{"error":"write failed"}'); } });
      return;
    }
    if (req.method === 'DELETE') {
      try { fs.unlinkSync(fp2); send(res, 200, '{"ok":true}'); } catch (e) { send(res, 404, '{"error":"not found"}'); }
      return;
    }
  }
  const lhm = url.match(/^\/api\/letter-history\/([\w][\w.()\- ]*\.md)$/);
  if (lhm) {
    const hp = letterHistPath(lhm[1]);
    if (!hp) { send(res, 400, JSON.stringify({ error: 'bad filename' })); return; }
    if (req.method === 'GET') {
      send(res, 200, JSON.stringify({ entries: readLetterHist(lhm[1]).slice().reverse() }));
      return;
    }
    if (req.method === 'POST') {
      try {
        const b = JSON.parse(await readBody(req) || '{}');
        const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
        if (!fs.existsSync(LETTER_HIST)) fs.mkdirSync(LETTER_HIST, { recursive: true });
        const entries = readLetterHist(lhm[1]);
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          ts: Date.now(),
          prompt: clip(b.prompt, 500),
          before: clip(b.before, 4000),
          after: clip(b.after, 4000),
          docBefore: clip(b.docBefore, 60000),
          docAfter: clip(b.docAfter, 60000),
          runId: clip(b.runId, 32),
          revertOf: clip(b.revertOf, 32),
        };
        if (!entry.after && !entry.docAfter) { send(res, 400, JSON.stringify({ error: 'nothing to record' })); return; }
        entries.push(entry);
        while (entries.length > LETTER_HIST_CAP) entries.shift();
        fs.writeFileSync(hp, JSON.stringify(entries, null, 2));
        send(res, 200, JSON.stringify({ entry, entries: entries.slice().reverse() }));
      } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
      return;
    }
  }

  // ---- writing voice: exemplars, the distilled profile, and the rewrite engine ----
  if (url === '/api/writing/voice' && req.method === 'GET') {
    try {
      const { profile, updatedAt, exists } = writingVoice.getProfile();
      send(res, 200, JSON.stringify({
        profile, updatedAt, exists,
        stars: writingVoice.getStars(),
        samples: writingVoice.getSamples(),
        hasKey: Boolean(process.env.OPENROUTER_API_KEY),
      }));
    } catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/voice' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = (() => { try { return JSON.parse(body); } catch { return { profile: body }; } })();
      const saved = writingVoice.saveProfile(parsed.profile != null ? parsed.profile : body);
      send(res, 200, JSON.stringify(saved));
    } catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/voice/build' && req.method === 'POST') {
    try {
      const saved = await writingVoice.buildProfile({ apiKey: process.env.OPENROUTER_API_KEY || '' });
      send(res, 200, JSON.stringify(saved));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/star' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const stars = writingVoice.setStar(b.file, b.on !== false);
      send(res, 200, JSON.stringify({ stars }));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/sample' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const sample = writingVoice.addSample(b);
      send(res, 200, JSON.stringify({ sample, samples: writingVoice.getSamples() }));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  const sm = url.match(/^\/api\/writing\/sample\/([\w]+)$/);
  if (sm && req.method === 'DELETE') {
    try {
      const samples = writingVoice.removeSample(sm[1]);
      send(res, 200, JSON.stringify({ samples }));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/rewrite' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const out = await writingVoice.rewriteSample({ ...b, apiKey: process.env.OPENROUTER_API_KEY || '' });
      send(res, 200, JSON.stringify(out));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/voice/refine' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const saved = await writingVoice.refineProfileFromFeedback({ ...b, apiKey: process.env.OPENROUTER_API_KEY || '' });
      send(res, 200, JSON.stringify(saved));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/voice/runs' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify({ runs: writingVoice.listRuns(80) })); }
    catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/voice/revert' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const saved = writingVoice.revertToRun(b.id, b.which || 'before');
      send(res, 200, JSON.stringify(saved));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }

  // ---- writing pipeline: Inspiration Ideas routed from ingest -> thread -> draft ----
  if (url === '/api/writing/projects' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify({ projects: writingPipeline.listProjects() })); }
    catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/route' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const p = writingPipeline.routeFromIngest(String(b.ingestId || ''));
      send(res, 200, JSON.stringify(p));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/project' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify(writingPipeline.getProject(params.get('id') || ''))); }
    catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/project/accept' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      send(res, 200, JSON.stringify(writingPipeline.acceptProject(String(b.id || ''))));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/project/dismiss' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      send(res, 200, JSON.stringify(writingPipeline.dismissProject(String(b.id || ''))));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/project/reply' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      send(res, 200, JSON.stringify(writingPipeline.appendReply(String(b.id || ''), b.text || '')));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/project/research' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const p = await writingPipeline.runResearch(String(b.id || ''), process.env.OPENROUTER_API_KEY || '');
      send(res, 200, JSON.stringify(p));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/project/options' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const p = await writingPipeline.runOptions(String(b.id || ''), process.env.OPENROUTER_API_KEY || '');
      send(res, 200, JSON.stringify(p));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/writing/project/draft' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const p = await writingPipeline.runDraft(String(b.id || ''), process.env.OPENROUTER_API_KEY || '');
      send(res, 200, JSON.stringify(p));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }

  // ---- conversations: past agent sessions from Sauron's experience graph ----
  if (url === '/api/conversations' && req.method === 'GET') {
    const q = (params.get('q') || '').trim();
    const limit = Math.min(Math.max(parseInt(params.get('limit') || '80', 10) || 80, 1), 200);
    const sauronBin = process.env.SAURON_BIN || path.join(os.homedir(), 'go', 'bin', 'sauron');
    const args = q
      ? ['experience', 'search', q, '--json', '--limit', String(limit)]
      : ['experience', 'recent', String(limit), '--json'];
    execFile(sauronBin, args, { timeout: 8000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) { send(res, 200, '[]'); return; }
      try {
        const parsed = JSON.parse(stdout || '[]');
        // `search` returns [{record, score}]; `recent` returns records directly — normalize both to a flat list.
        const records = (q ? parsed.map((r) => ({ ...r.record, score: r.score })) : parsed)
          .map((r) => { const { embedding, ...rest } = r; return rest; });
        send(res, 200, JSON.stringify(records));
      } catch { send(res, 200, '[]'); }
    });
    return;
  }

  // ---- lightweight HW metrics (1Hz ring; no Sauron) ----
  if (url === '/api/hw' && req.method === 'GET') {
    send(res, 200, JSON.stringify(hwSampler.getSnapshot()));
    return;
  }

  if (url === '/api/hw/stream' && req.method === 'GET') {
    startSse(res);
    let closed = false;
    let ping = null;
    const unsub = hwSampler.subscribe((point) => {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(point)}\n\n`); }
      catch { cleanup(); }
    });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      unsub();
    };
    req.on('close', cleanup);
    try {
      res.write(`event: history\ndata: ${JSON.stringify(hwSampler.getSnapshot())}\n\n`);
    } catch { cleanup(); return; }
    ping = setInterval(() => {
      if (closed) return;
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 15000);
    return;
  }

  // ---- activity screen grab: true macOS screenshot for cursor capture ----
  // The cursor tool wants the actual screen (main display) with the trail stamped
  // on top — not an html2canvas re-render of one iframe. macOS-only; the client
  // falls back to the html2canvas path when this 501s or fails.
  if (url === '/api/activity/screen' && req.method === 'POST') {
    if (process.platform !== 'darwin') { send(res, 501, JSON.stringify({ error: 'screen capture is macOS-only' })); return; }
    const tmp = path.join(os.tmpdir(), `valinor-screen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    execFile('screencapture', ['-x', '-m', '-t', 'jpg', tmp], { timeout: 15000 }, () => {
      fs.readFile(tmp, (e, buf) => {
        fs.unlink(tmp, () => {});
        if (e || !buf || !buf.length) { send(res, 500, JSON.stringify({ error: 'screencapture failed (no display access?)' })); return; }
        send(res, 200, JSON.stringify({ dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'), bytes: buf.length }));
      });
    });
    return;
  }

  // ---- activity live cursor: save shot + ≤50-word summary (debounced client-side) ----
  if (url === '/api/activity/cursor-context' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const decoded = decodeImagePayload(body.image);
    let screenshotPath = null;
    let screenshotUrl = null;
    if (decoded?.buf?.length) {
      try {
        const fileName = decoded.mime === 'image/png' ? CURSOR_SHOT_NAME + '.png'
          : decoded.mime === 'image/webp' ? CURSOR_SHOT_NAME + '.webp'
          : CURSOR_SHOT_NAME + '.jpg';
        const outPath = path.join(ROOT, fileName);
        fs.writeFileSync(outPath, decoded.buf);
        screenshotPath = outPath;
        screenshotUrl = '/' + fileName + '?t=' + Date.now();
      } catch (e) {
        send(res, 500, JSON.stringify({ error: 'screenshot write failed: ' + String(e.message || e) }));
        return;
      }
    }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    // Manual caption wins: skip the vision read entirely (no billed model call) —
    // the user's words become the summary saved to ingest.
    const manualCaption = String(body.caption || (body.context && body.context.caption) || '').trim();
    try {
      const result = manualCaption
        ? { ...clampWords(manualCaption, 200), source: 'manual-caption' }
        : await summarizeCursorContext({
          imageUrl: decoded?.dataUrl || null,
          context: body.context || {},
        }, apiKey);
      let ingestRec = null;
      if (decoded?.buf?.length) {
        try {
          ingestRec = ingest.writeCursorCapture({
            imageBuf: decoded.buf,
            mime: decoded.mime,
            summary: result.summary,
            context: body.context || {},
          });
        } catch (e) {
          console.warn('[ingest] cursor capture save failed:', e && e.message ? e.message : e);
        }
      }
      send(res, 200, JSON.stringify({
        summary: result.summary,
        words: result.words,
        source: result.source,
        error: result.error || null,
        screenshotPath: screenshotPath ? path.basename(screenshotPath) : null,
        screenshotAbsPath: screenshotPath,
        screenshotUrl: ingestRec
          ? `/api/ingest/media?id=${encodeURIComponent(ingestRec.id)}&t=${Date.now()}`
          : screenshotUrl,
        ingestId: ingestRec ? ingestRec.id : null,
      }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // ---- machine monitor: Sauron status + fused activity timeline ----
  if (url === '/api/machine' && req.method === 'GET') {
    const hours = Math.min(Math.max(parseFloat(params.get('hours') || '4') || 4, 0.25), 48);
    try {
      send(res, 200, JSON.stringify(await getMachineSnapshot(hours)));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/sauron/task/complete' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const id = String(body.task_id || '').trim();
    if (!sauronToken(id)) { send(res, 400, JSON.stringify({ error: 'missing task_id' })); return; }
    const r = await sauronExec(['task', 'complete', id, '--json']);
    bustMachineCache();
    send(res, r.ok ? 200 : 500, JSON.stringify(r.ok ? { ok: true } : { error: r.error || 'complete failed' }));
    return;
  }
  if (url === '/api/sauron/hint/stop' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const id = String(body.hint_id || '').trim();
    if (!sauronToken(id)) { send(res, 400, JSON.stringify({ error: 'missing hint_id' })); return; }
    const r = await sauronExec(['hint', 'stop', id, '--json']);
    bustMachineCache();
    send(res, r.ok ? 200 : 500, JSON.stringify(r.ok ? { ok: true } : { error: r.error || 'stop failed' }));
    return;
  }

  // ---- machine monitor live stream (SSE full snapshots) ----
  if (url === '/api/machine/stream' && req.method === 'GET') {
    const hours = Math.min(Math.max(parseFloat(params.get('hours') || '4') || 4, 0.25), 48);
    startSse(res);
    let closed = false;
    let busy = false;
    let poll = null;
    let ping = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      if (ping) clearInterval(ping);
    };
    req.on('close', cleanup);

    const push = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const snap = await getMachineSnapshot(hours);
        if (closed) return;
        res.write(`data: ${JSON.stringify(snap)}\n\n`);
      } catch (e) {
        if (closed) return;
        try { res.write(`data: ${JSON.stringify({ error: String(e.message || e) })}\n\n`); } catch { cleanup(); }
      } finally {
        busy = false;
      }
    };

    push();
    poll = setInterval(push, 30000);
    ping = setInterval(() => {
      if (closed) return;
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 15000);
    return;
  }

  // trigger Wispr Flow (speech-to-text) by firing its activation key
  if (url === '/api/dictate' && req.method === 'POST') {
    exec(WISPR_CMD, (err) => send(res, err ? 500 : 200, JSON.stringify({ ok: !err, error: err ? String(err) : undefined })));
    return;
  }

  // ---- messaging: read-only bridge into network.db (CRM) + chat.db (iMessage) ----
  if (url === '/api/roster' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify(networkData.getRoster())); }
    catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/context' && req.method === 'GET') {
    const id = parseInt(params.get('id') || '', 10);
    if (!Number.isFinite(id)) { send(res, 400, JSON.stringify({ error: 'missing/invalid id' })); return; }
    try {
      const ctx = networkData.getContext(id);
      send(res, ctx ? 200 : 404, JSON.stringify(ctx || { error: 'not found' }));
    } catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/events' && req.method === 'GET') {
    try { send(res, 200, JSON.stringify(networkData.getEvents())); }
    catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  // reconciliation: for a contact's past copied-but-unresolved drafts, check chat.db for
  // what was actually sent shortly after — closes the loop that clipboard-copy would
  // otherwise hide, feeding real edits back into future drafting.
  if (url === '/api/reconcile' && req.method === 'GET') {
    const id = parseInt(params.get('id') || '', 10);
    if (!Number.isFinite(id)) { send(res, 400, JSON.stringify({ error: 'missing/invalid id' })); return; }
    try {
      const file = path.join(ROOT, 'drafts.json');
      let all = [];
      try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { all = []; }
      let changed = false;
      const resolved = [];
      for (const s of all) {
        if (s.contactId !== id || !s.copiedAt || s.actualSentText) continue;
        const found = networkData.findSentAfter(id, s.copiedAt, 90);
        if (found) {
          s.actualSentText = found.text;
          s.actualSentAt = found.sentAt;
          changed = true;
        }
        if (s.actualSentText) resolved.push({ id: s.id, copiedText: s.copiedText, actualSentText: s.actualSentText });
      }
      if (changed) fs.writeFileSync(file, JSON.stringify(all, null, 2));
      send(res, 200, JSON.stringify({ resolved }));
    } catch (e) { send(res, 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/draft' && req.method === 'POST') {
    startSse(res);
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try { await runDraftTurn(res, body, apiKey); }
    catch (e) { try { res.write(`data: ${JSON.stringify({ type: 'error', message: String(e.message || e) })}\n\n`); } catch {} }
    try { res.end(); } catch {}
    return;
  }
  // "who should I ask about this?" — ranks the whole roster against a raw intent
  if (url === '/api/suggest' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const out = await suggestRecipients(body.intent || '', apiKey);
      send(res, 200, JSON.stringify(out));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (url === '/api/profile/refresh' && req.method === 'POST') {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    try {
      const profile = await refreshStyleProfile(apiKey);
      send(res, 200, JSON.stringify(profile));
    } catch (e) { send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }

  // ---- Place: OS timezone + optional browser GPS (IP city only if tz agrees) ----
  if (url === '/api/geo' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify(await getHubGeo()));
    } catch (e) {
      send(res, 200, JSON.stringify({ city: null, country_code: null, local: true, error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/geo' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      reportClientGeo(body.latitude, body.longitude);
      send(res, 200, JSON.stringify(await getHubGeo()));
    } catch (e) {
      send(res, 200, JSON.stringify({ city: null, country_code: null, local: true, error: String(e.message || e) }));
    }
    return;
  }

  // ---- server control (localhost self-restart) ----
  if (url === '/api/server/info' && req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify(await buildServerInfo()));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url === '/api/server/restart' && req.method === 'POST') {
    if (restartScheduled) {
      send(res, 409, JSON.stringify({ error: 'already restarting' }));
      return;
    }
    restartScheduled = true;
    send(res, 200, JSON.stringify({ ok: true, restarting: true }));
    setTimeout(() => {
      console.log('Valinor: restart requested — respawning server.js');
      stopLoopkeeper();
      tts.stop();
      const spawnNext = () => {
        if (restartSpawned) {
          process.exit(0);
          return;
        }
        restartSpawned = true;
        try {
          const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
            cwd: ROOT,
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
        } catch (e) {
          console.error('Valinor: failed to spawn replacement:', e && e.message ? e.message : e);
        }
        process.exit(0);
      };
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch { /* ignore */ }
      server.close(() => spawnNext());
      // open SSE sockets can delay close — hard exit after a beat
      setTimeout(spawnNext, 1500);
    }, 200);
    return;
  }

  // generic JSON store: /api/<name>  <->  <name>.json  (notes, drafts, crm, ...)
  const apiM = url.match(/^\/api\/([a-z0-9_-]+)$/i);
  const RESERVED = new Set(['agent', 'proxy', 'transcribe', 'roster', 'context', 'events', 'reconcile', 'draft', 'suggest', 'machine', 'conversations', 'dictate', 'letters', 'live', 'profile', 'activity', 'hw', 'server', 'geo', 'tts', 'rehearse']);
  if (apiM && !RESERVED.has(apiM[1])) {
    const file = path.join(ROOT, apiM[1] + '.json');
    if (req.method === 'GET') {
      fs.readFile(file, 'utf8', (e, d) => send(res, 200, e ? '[]' : d));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
          send(res, 200, '{"ok":true}');
        } catch { send(res, 400, '{"error":"bad json"}'); }
      });
      return;
    }
  }

  // static files (default to the hub)
  let rel = url === '/' ? '/hub.html' : url;
  try { rel = decodeURIComponent(rel); } catch { send(res, 400, 'bad path', 'text/plain'); return; }
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT + path.sep) && fp !== ROOT) { send(res, 403, 'forbidden', 'text/plain'); return; }
  fs.readFile(fp, (e, d) => {
    if (e) { send(res, 404, 'not found', 'text/plain'); return; }
    send(res, 200, d, MIME[path.extname(fp)] || 'application/octet-stream');
  });
});

(async () => {
  try {
    await startManagedLoopkeeper();
  } catch (e) {
    console.warn('Loopkeeper failed to start:', e && e.message ? e.message : e);
    console.warn('LOOPS tab will 502 until Loopkeeper is healthy on :' + LOOPKEEPER_PORT);
  }
  server.listen(PORT, BIND, () => {
    const apps = PROXIED_APPS.map(a => `${a.name} → ${a.base}`).join(', ');
    console.log(
      `Valinor on http://${BIND}:${PORT}` +
      (apps ? `  (${apps})` : '') +
      (process.env.OPENROUTER_API_KEY ? '  (OpenRouter key loaded)' : '  (OPENROUTER_API_KEY missing — agent will error clearly)'),
    );
    // Warm Kitten TTS in the background (first run downloads ~80MB). Live falls back
    // to browser speechSynthesis until ready.
    setTimeout(() => {
      tts.startManaged().catch((e) => console.warn('Kitten TTS:', e && e.message ? e.message : e));
    }, 500);
    // Pull Apple Notes (incl. phone notes via iCloud) into the ingest store on boot.
    // Non-blocking; first run may trigger a macOS Automation permission prompt. Disable
    // with INGEST_APPLE_NOTES_SYNC=0. Manual re-sync lives on the INGEST view button.
    if (process.env.INGEST_APPLE_NOTES_SYNC !== '0') {
      setTimeout(() => {
        appleNotes.importNotes()
          .then((s) => console.log(`Apple Notes sync: ${s.imported} new, ${s.updated} updated, ${s.skipped} unchanged (${s.total} total)`))
          .catch((e) => console.log(`Apple Notes sync skipped: ${String(e.message || e)}`));
      }, 3000);
    }
    // Auto-ingest recent Mac screenshots (folder source) on boot. Bounded to a recent window
    // + dedup, and captioned via the vision model. Disable with INGEST_SCREENSHOTS_SYNC=0.
    if (process.env.INGEST_SCREENSHOTS_SYNC !== '0') {
      setTimeout(() => {
        screenshots.importScreenshots({}, process.env.OPENROUTER_API_KEY || '')
          .then((s) => console.log(`Screenshots sync: ${s.imported} new, ${s.skipped} skipped${s.missing ? ' (folder missing)' : ''} (${s.dir})`))
          .catch((e) => console.log(`Screenshots sync skipped: ${String(e.message || e)}`));
      }, 6000);
    }
  });
})();
