// Pi SDK bridge for Live spoken turns. ESM — dynamically imported from live-server.js.
// cwd is valinor-agent/ so repo-root AGENTS.md (privacy guide) never loads into Val.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const require = createRequire(import.meta.url);
const agentUsage = require('./agent-usage.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const valinorAgentDir = path.join(repoRoot, 'valinor-agent');
const agentDir = path.join(valinorAgentDir, '.runtime');

const LIVE_TOOLS = [
  'read',
  'search_ingest',
  'lookup_person',
  'list_tasks',
  'list_letters',
  'sauron_sessions',
  'recent_activity',
  'play_video',
  'show_article',
  'lookup',
  'recall_memory',
  'remember',
  'capture_memory',
];

// Spoken-voice brain. Savar's pick: Muse Spark 1.3 — sharp enough for real tool
// routing and messy interrupted speech, fast enough for voice. Override with
// LIVE_MODEL (any OpenRouter slug, e.g. openai/gpt-4.1, anthropic/claude-sonnet-4.6).
const DEFAULT_MODEL = process.env.LIVE_MODEL || process.env.OPENROUTER_MODEL || 'meta/muse-spark-1.3';
// If the primary is gated at inference time (e.g. Spark's 18+ age confirmation),
// the turn transparently retries on the fallback instead of erroring to Savar.
const FALLBACK_MODEL = process.env.LIVE_FALLBACK_MODEL || 'openai/gpt-4.1';
let activeModelId = DEFAULT_MODEL;
// Muse (and some other OpenRouter endpoints) reject reasoning:{effort:"none"}.
// Pi sends that when thinkingLevel is "off" and the catalog has no off→null map
// (Spark 1.3 isn't in Pi 0.84's OpenRouter list, so it is a generic fallback).
let forcedThinkingLevel = null;

function isGateError(msg) {
  const s = String(msg || '');
  return /403|age confirmation|moderation|data policy/i.test(s);
}

function isReasoningMandatoryError(msg) {
  return /reasoning is mandatory|cannot be disabled/i.test(String(msg || ''));
}

function thinkingLevelFor(model) {
  if (forcedThinkingLevel) return forcedThinkingLevel;
  const id = String(model?.id || activeModelId || DEFAULT_MODEL);
  if (/muse/i.test(id)) return 'minimal';
  return 'off';
}

let session = null;
let modelRuntime = null;
let unsubscribe = null;
let currentTurn = null;
let initPromise = null;
let spokenChain = Promise.resolve();

function sse(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
}

function applyBoardHandoff(turn, toolName, argQuery, details) {
  const q = (details && typeof details.query === 'string' && details.query.trim())
    || (typeof argQuery === 'string' && argQuery.trim())
    || '';
  const kindFromDetails = details && (details.kind === 'video' || details.kind === 'wiki')
    ? details.kind
    : null;
  const kind = kindFromDetails
    || (toolName === 'play_video' ? 'video' : toolName === 'show_article' ? 'wiki' : '');
  if (q) turn.boardQuery = q;
  if (kind === 'video' || (kind === 'wiki' && turn.boardKind !== 'video')) {
    turn.boardKind = kind;
  }
}

function toPiImage(image) {
  if (!image || typeof image !== 'string') return null;
  const s = image.trim();
  if (!s) return null;
  const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (m) return { type: 'image', mimeType: m[1], data: m[2] };
  const data = s.replace(/^data:[^;]+;base64,/i, '');
  if (!data) return null;
  return { type: 'image', mimeType: 'image/jpeg', data };
}

function usageFromPi(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost.total : usage.cost;
  return {
    prompt_tokens: usage.input ?? usage.prompt_tokens ?? 0,
    completion_tokens: usage.output ?? usage.completion_tokens ?? 0,
    total_tokens: usage.totalTokens ?? usage.total_tokens ?? 0,
    cost: cost ?? null,
  };
}

function lastAssistantUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.usage) return m.usage;
  }
  return null;
}

function assistantText(msg) {
  if (!msg || msg.role !== 'assistant') return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && (p.type === 'text' || p.type === 'textDelta'))
    .map((p) => p.text || p.delta || '')
    .join('');
}

function onSessionEvent(event) {
  const turn = currentTurn;
  if (!turn) return;

  const ame = event.assistantMessageEvent;
  if (event.type === 'message_update' && ame?.type === 'text_delta' && ame.delta) {
    turn.full += ame.delta;
    sse(turn.res, { type: 'token', text: ame.delta });
    return;
  }
  if (event.type === 'message_update' && ame?.type === 'text_end' && ame.content && !turn.full) {
    turn.full = String(ame.content);
    sse(turn.res, { type: 'token', text: turn.full });
    return;
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const t = assistantText(event.message);
    if (t && t.length > turn.full.length) turn.full = t;
    if (event.message.stopReason) turn.stopReason = event.message.stopReason;
    if (event.message.errorMessage) turn.errorMessage = String(event.message.errorMessage);
  }

  if (event.type === 'tool_execution_start' && event.toolName) {
    if (!Array.isArray(turn.tools)) turn.tools = [];
    turn.tools.push(event.toolName);
    console.log('[live-pi] tool start:', event.toolName);
  }

  if (event.type === 'tool_execution_end' && event.toolName === 'lookup') {
    const backend = event.result?.details?.backend || '';
    console.log('[live-pi] lookup end:', backend || 'ok');
  }

  const boardTools = event.toolName === 'play_video' || event.toolName === 'show_article';
  if (event.type === 'tool_execution_start' && boardTools) {
    applyBoardHandoff(turn, event.toolName, event.args && event.args.query, null);
    return;
  }

  if (event.type === 'tool_execution_end' && boardTools) {
    const details = event.result?.details;
    applyBoardHandoff(turn, event.toolName, event.args && event.args.query, details);
    return;
  }

  if (event.type === 'agent_end' && Array.isArray(event.messages)) {
    const u = lastAssistantUsage(event.messages);
    if (u) turn.usage = u;
  }
}

async function resolveModel(runtime, modelId) {
  const id = String(modelId || DEFAULT_MODEL).replace(/^openrouter\//, '');
  const direct = runtime.getModel?.('openrouter', id);
  if (direct) return direct;
  const resolved = resolveCliModel({
    cliProvider: 'openrouter',
    cliModel: id,
    modelRuntime: runtime,
  });
  if (resolved.model) return resolved.model;
  if (resolved.warning) console.warn('[live-pi] model resolve:', resolved.warning);
  if (resolved.error) console.warn('[live-pi] model resolve:', resolved.error);
  const available = await runtime.getAvailable();
  const hit = (available || []).find((m) => (
    m.provider === 'openrouter' && (m.id === id || m.id.endsWith('/' + id) || String(m.id).includes(id))
  ));
  if (hit) return hit;
  const anyOr = (available || []).find((m) => m.provider === 'openrouter');
  if (anyOr) return anyOr;
  throw new Error(resolved.error || 'No OpenRouter model available. Check OPENROUTER_API_KEY.');
}

async function createSession(apiKey) {
  process.env.VALINOR_ROOT = repoRoot;
  fs.mkdirSync(agentDir, { recursive: true });

  modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
  });
  await modelRuntime.setRuntimeApiKey('openrouter', apiKey);

  const model = await resolveModel(modelRuntime, activeModelId);
  const settingsManager = SettingsManager.create(valinorAgentDir, agentDir, { projectTrusted: true });
  settingsManager.setProjectTrusted(true);

  const loader = new DefaultResourceLoader({
    cwd: valinorAgentDir,
    agentDir,
    settingsManager,
    agentsFilesOverride: (current) => ({
      agentsFiles: (current.agentsFiles || []).filter((f) => {
        const resolved = path.resolve(f.path);
        return resolved === path.join(valinorAgentDir, 'AGENTS.md')
          || resolved.startsWith(valinorAgentDir + path.sep);
      }),
    }),
  });
  await loader.reload();

  const thinkingLevel = thinkingLevelFor(model);
  console.log('[live-pi] session model:', model.id, 'thinking:', thinkingLevel);
  const result = await createAgentSession({
    cwd: valinorAgentDir,
    agentDir,
    model,
    thinkingLevel,
    modelRuntime,
    tools: LIVE_TOOLS,
    excludeTools: ['bash', 'edit', 'write'],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(valinorAgentDir),
    settingsManager,
  });

  if (result.extensionsResult?.errors?.length) {
    for (const err of result.extensionsResult.errors) {
      console.warn('[live-pi] extension error:', err.path, err.error);
    }
  }
  if (result.modelFallbackMessage) {
    console.warn('[live-pi]', result.modelFallbackMessage);
  }

  session = result.session;
  unsubscribe = session.subscribe(onSessionEvent);
  return session;
}

async function ensureSession(apiKey) {
  if (session) {
    if (modelRuntime && apiKey) {
      try { await modelRuntime.setRuntimeApiKey('openrouter', apiKey); } catch { /* keep */ }
    }
    return session;
  }
  if (!initPromise) {
    initPromise = createSession(apiKey).finally(() => { initPromise = null; });
  }
  return initPromise;
}

export function abortSpokenTurn() {
  currentTurn = null;
  try {
    if (session && typeof session.abort === 'function') {
      const p = session.abort();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch { /* ignore */ }
}

export function resetSession() {
  abortSpokenTurn();
  currentTurn = null;
  const s = session;
  const unsub = unsubscribe;
  session = null;
  unsubscribe = null;
  modelRuntime = null;
  initPromise = null;
  try { unsub?.(); } catch { /* ok */ }
  try { s?.dispose(); } catch { /* ok */ }
}

async function runSpokenTurnInner(res, { text, image, activeTab }, apiKey, helpers) {
  const liveServer = require('./live-server.js');
  if (typeof liveServer.setSpokenTurnMeta === 'function') {
    liveServer.setSpokenTurnMeta({ activeTab });
  }

  const t0 = Date.now();
  const modelLabel = DEFAULT_MODEL;
  const persistPath = helpers?.persistPath ?? null;
  const appendAssistant = helpers?.appendAssistant;
  const appendSession = helpers?.appendSession;
  const send = helpers?.sse || sse;

  let sess;
  try {
    sess = await ensureSession(apiKey);
  } catch (e) {
    agentUsage.record({ surface: 'live', model: modelLabel, latencyMs: Date.now() - t0, ok: false, label: 'speak' });
    send(res, { type: 'error', message: String(e.message || e) });
    return;
  }

  const turn = { res, full: '', boardQuery: '', boardKind: '', tools: [], usage: null };
  currentTurn = turn;

  const images = [];
  const piImage = toPiImage(image);
  if (piImage) images.push(piImage);

  const userText = String(text || '');

  // Continuing a thread from another harness (or a switched live thread):
  // prefix the first turn with the imported transcript so Val answers in context.
  let promptText = userText;
  try {
    const seed = liveServer && typeof liveServer.consumeSeed === 'function'
      ? liveServer.consumeSeed()
      : null;
    if (seed && seed.transcript) {
      promptText = '[Continuing past conversation "' + String(seed.title || 'imported').slice(0, 120) + '":\n'
        + String(seed.transcript).slice(0, 6000)
        + '\n— end of past conversation —]\n\nSavar now says: ' + userText;
    }
  } catch { /* prompt without seed */ }

  async function promptOnce(imgs) {
    turn.full = '';
    turn.boardQuery = '';
    turn.boardKind = '';
    turn.tools = [];
    turn.usage = null;
    turn.stopReason = undefined;
    turn.errorMessage = undefined;
    currentTurn = turn;
    await sess.prompt(promptText, imgs.length ? { images: imgs } : undefined);
  }

  try {
    await promptOnce(images);
    if (turn.errorMessage && images.length && !isGateError(turn.errorMessage) && !isReasoningMandatoryError(turn.errorMessage)) {
      console.warn('[live-pi] vision failed, resetting and retrying text-only:', String(turn.errorMessage).slice(0, 160));
      currentTurn = null;
      resetSession();
      sess = await ensureSession(apiKey);
      await promptOnce([]);
    }
    // Muse-class endpoints require reasoning; Pi's "off" maps to effort "none".
    if (turn.errorMessage && isReasoningMandatoryError(turn.errorMessage) && forcedThinkingLevel !== 'minimal') {
      console.warn('[live-pi] reasoning required, retrying with thinkingLevel=minimal');
      forcedThinkingLevel = 'minimal';
      currentTurn = null;
      resetSession();
      sess = await ensureSession(apiKey);
      await promptOnce(images);
    }
    // Primary gated at inference (403 / age confirmation) → rebuild on fallback, retry once.
    if (turn.errorMessage && isGateError(turn.errorMessage) && activeModelId !== FALLBACK_MODEL) {
      console.warn(`[live-pi] ${activeModelId} gated, falling back to ${FALLBACK_MODEL}`);
      activeModelId = FALLBACK_MODEL;
      forcedThinkingLevel = null;
      currentTurn = null;
      resetSession();
      sess = await ensureSession(apiKey);
      await promptOnce(images);
    }
  } catch (e) {
    if (isReasoningMandatoryError(e.message) && forcedThinkingLevel !== 'minimal') {
      console.warn('[live-pi] reasoning required (throw), retrying with thinkingLevel=minimal');
      forcedThinkingLevel = 'minimal';
      currentTurn = null;
      resetSession();
      try {
        sess = await ensureSession(apiKey);
        await promptOnce(images);
      } catch (e2) {
        currentTurn = null;
        agentUsage.record({
          surface: 'live',
          model: sess.model?.id || modelLabel,
          latencyMs: Date.now() - t0,
          ok: false,
          label: 'speak',
        });
        send(res, { type: 'error', message: String(e2.message || e2) });
        return;
      }
    } else if (isGateError(e.message) && activeModelId !== FALLBACK_MODEL) {
      console.warn(`[live-pi] ${activeModelId} gated (throw), falling back to ${FALLBACK_MODEL}`);
      activeModelId = FALLBACK_MODEL;
      forcedThinkingLevel = null;
      currentTurn = null;
      resetSession();
      try {
        sess = await ensureSession(apiKey);
        await promptOnce(images);
      } catch (e2) {
        currentTurn = null;
        agentUsage.record({
          surface: 'live',
          model: sess.model?.id || modelLabel,
          latencyMs: Date.now() - t0,
          ok: false,
          label: 'speak',
        });
        send(res, { type: 'error', message: String(e2.message || e2) });
        return;
      }
    } else {
      currentTurn = null;
      agentUsage.record({
        surface: 'live',
        model: sess.model?.id || modelLabel,
        latencyMs: Date.now() - t0,
        ok: false,
        label: 'speak',
      });
      send(res, { type: 'error', message: String(e.message || e) });
      return;
    }
  }

  currentTurn = null;

  if (turn.errorMessage) {
    console.warn('[live-pi] assistant error:', turn.stopReason, String(turn.errorMessage).slice(0, 240));
  }

  if (!turn.full) {
    const msgs = sess.messages || sess.agent?.state?.messages || [];
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; }
    }
    for (let i = msgs.length - 1; i > lastUser; i--) {
      const m = msgs[i];
      if (!m || m.role !== 'assistant' || m.stopReason === 'error') continue;
      const t = assistantText(m);
      if (t) { turn.full = t; break; }
    }
  }

  if (!turn.full && turn.errorMessage) {
    agentUsage.record({
      surface: 'live',
      model: sess.model?.id || modelLabel,
      latencyMs: Date.now() - t0,
      ok: false,
      label: 'speak',
    });
    send(res, { type: 'error', message: 'Live model error: ' + String(turn.errorMessage).slice(0, 180) });
    return;
  }
  if (!turn.usage) {
    turn.usage = lastAssistantUsage(sess.agent?.state?.messages || sess.messages || []);
  }

  const mapped = usageFromPi(turn.usage);
  agentUsage.record({
    surface: 'live',
    model: sess.model?.id || modelLabel,
    latencyMs: Date.now() - t0,
    usage: mapped,
    cost: mapped.cost ?? null,
    ok: true,
    label: 'speak',
    input: String(text || ''),
    output: String(turn.full || ''),
  });

  let reply = String(turn.full || '').trim();
  if (turn.boardQuery) {
    const boardEvt = { type: 'board', query: turn.boardQuery };
    if (turn.boardKind) boardEvt.kind = turn.boardKind;
    console.log('[live-pi] board:', turn.boardKind || 'any', turn.boardQuery);
    send(res, boardEvt);
    if (!reply) reply = turn.boardKind === 'video'
      ? 'On it — playing that.'
      : 'On it — putting that on the board.';
  }
  if (typeof appendSession === 'function') {
    appendSession({
      t: Date.now(),
      role: 'route',
      text: userText,
      tools: Array.isArray(turn.tools) ? turn.tools : [],
      boardKind: turn.boardKind || null,
    });
  }
  if (!reply) reply = 'Say that once more, Savar — I missed it.';
  send(res, { type: 'done', text: reply, persist: persistPath });
  if (typeof appendAssistant === 'function') appendAssistant(reply);
}

export function runSpokenTurn(res, payload, apiKey, helpers) {
  abortSpokenTurn();
  const run = spokenChain.then(() => runSpokenTurnInner(res, payload, apiKey, helpers));
  spokenChain = run.catch((e) => {
    console.warn('[live-pi] spoken turn failed:', e);
  });
  return run;
}

export { valinorAgentDir, LIVE_TOOLS as liveTools };
