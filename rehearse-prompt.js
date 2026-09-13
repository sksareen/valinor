// rehearse-prompt.js — versioned interviewer + coach prompts for the Rehearse
// Mock Interview Partner. Config-driven persona: built-in generic defaults work
// out of the box; copy rehearse.config.example.json to rehearse.config.json
// (gitignored) to personalize. Companion context is loaded server-side and NEVER
// shipped to the client.
'use strict';

const fs = require('fs');
const path = require('path');

const PROMPT_VERSION = 'rehearse-v1.2';

// ---------------------------------------------------------------------------
// Persona config
// Resolution: REHEARSE_CONFIG env path, then ./rehearse.config.json (gitignored,
// per-user), then built-in generic defaults below.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  candidateName: 'Alex',
  interviewer: {
    name: 'Riley',
    background: 'Big-tech hiring manager with a ranking and applied-ML background. You distrust vanity metrics, press on error costs, ask what the model gets wrong and how the candidate would detect failure.',
  },
  role: {
    title: 'Product Manager',
    shortTitle: 'PM',
    posting: 'Product Manager',
    level: 'L5',
    company: 'Google',
    team: '',
    product: 'an AI-powered consumer product',
  },
  prepNote: '',
  banks: null, // optional per-list override: { productVision, problemSpace, behavioral, intros, close }
  checklistHeading: 'CANDIDATE CHECKLIST:',
  checklist: [
    'Metric close = state a clear metric at the end of each answer (substance over phrasing). Only flag when NO metric was stated.',
    'No sentence restated 2-3x (flag repeats with quotes).',
    'Behavioral answers need real numbers, not placeholders ("What was the number?").',
    'Interrupt recovery: if the candidate restarted from the top after an interrupt, flag it.',
    'Zero clarifying questions on a case = flag. More than 3 = flag (should have assumed). 1-3 path-changing questions = praise, never punish.',
  ],
  companion: null, // { dir, scriptFile, lettersDir, pressLine } — server-side only
  ttsVoice: 'Charon',
};

function configCandidates() {
  const list = [];
  if (process.env.REHEARSE_CONFIG) list.push(process.env.REHEARSE_CONFIG);
  list.push(path.join(__dirname, 'rehearse.config.json'));
  return list;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const bv = base[k];
    const ov = over[k];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = { ...bv, ...ov };
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out;
}

let cachedConfig = null;
let cachedSource = null;

/** Load + merge the persona config. Cached per process; lazy so REHEARSE_CONFIG from .env works. */
function loadRehearseConfig() {
  if (cachedConfig) return cachedConfig;
  let merged = deepMerge({}, DEFAULT_CONFIG);
  let source = 'built-in defaults';
  for (const p of configCandidates()) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') {
        merged = deepMerge(merged, raw);
        source = p;
        break;
      }
    } catch { /* missing or invalid — try next */ }
  }
  // Banks merge per-list: a configured list replaces that list wholesale.
  if (merged.banks && typeof merged.banks === 'object') {
    const b = { ...merged.banks };
    for (const k of Object.keys(b)) {
      if (!Array.isArray(b[k])) delete b[k];
    }
    merged.banks = Object.keys(b).length ? b : null;
  } else {
    merged.banks = null;
  }
  cachedConfig = merged;
  cachedSource = source;
  return cachedConfig;
}

function getConfigSource() {
  loadRehearseConfig();
  return cachedSource;
}

/** Test hook: drop the cache so the next load re-reads disk/env. */
function resetConfigCache() {
  cachedConfig = null;
  cachedSource = null;
}

// ---------------------------------------------------------------------------
// Session types (MVP: FULL ROUND + CASE DRILL + BEHAVIORAL REP only)
// ---------------------------------------------------------------------------
function getSessionTypes(cfg) {
  const c = cfg || loadRehearseConfig();
  const posting = c.role.posting || c.role.title;
  const where = `${c.role.company}${c.role.team ? ' ' + c.role.team : ''}`;
  const iv = c.interviewer.name;
  const teamShort = c.role.team || c.role.company;
  return {
    full: {
      id: 'full',
      name: 'FULL ROUND',
      minutes: 45,
      tagline: 'Intros → one deep case → two-way close',
      brief: [
        'FULL ROUND, ~45 min, three segments:',
        '1. INTROS (5-8 min): open with "Tell me about yourself." Then "Why this role?" (Why ' + posting + ' at ' + where + ', why now.)',
        '2. CASE (~30 min): ONE product or problem-space case with 3-5 follow-ups. Enforce the spine: clarify → frame → decide → measure. Weakest element first.',
        '3. CLOSE (10 min, two-way, BOTH scored): "What do you think this role is?" then "What questions do you have for me?" Score the candidate\'s questions: specific-to-' + iv + '/team/' + teamShort + ' vs generic.',
      ].join('\n'),
    },
    case: {
      id: 'case',
      name: 'CASE DRILL',
      minutes: 15,
      tagline: 'One case, enforced spine, ~15 min',
      brief: [
        'CASE DRILL, ~15 min: ONE case from Product Vision or Problem Space Understanding (never analytics/estimation), spine enforced (clarify → frame → decide → measure).',
        'Push 3-5 times on the weakest element first. Interrupt mid-answer at least once.',
        'End with the coach debrief when the candidate says "break" or hits End Segment.',
      ].join('\n'),
    },
    behavioral: {
      id: 'behavioral',
      name: 'BEHAVIORAL REP',
      minutes: 5,
      tagline: 'One story, 3-min cap, quantified',
      brief: [
        'BEHAVIORAL REP, one story, 3-min cap:',
        'Pick ONE story prompt. Demand quantification ("What was the number?"). Probe the lesson ("Would you do the same again?").',
        'No interrupts in this mode — but enforce the cap: at 3 min cut to the debrief.',
      ].join('\n'),
    },
  };
}

// Static-shape export for key validation + generic reads (briefs resolve via getSessionTypes).
const SESSION_TYPES = getSessionTypes(DEFAULT_CONFIG);

// ---------------------------------------------------------------------------
// Question banks — generic public samples.
// CASE SCOPE: Product Vision + Problem Space ONLY.
// No analytics puzzles, estimation questions, or pure metrics problems.
// ---------------------------------------------------------------------------
const DEFAULT_BANKS = {
  productVision: [
    'How would you improve restaurant search?',
    'If you were to build the next great feature for Google Search, what would it be?',
    'How would you improve Google Maps?',
    'How would you design an alarm clock for a person with a visual impairment?',
    'How would you improve Photos for parents with young kids?',
    'Design YouTube for learning — not entertainment. What changes?',
    'Design a Calendar for families sharing one household.',
  ],
  problemSpace: [
    'How do you resolve conflicting product requirements? What or who determines which requirement takes the hit?',
    'How would you manage through a latent field failure or bug that is directly impacting customers and driving return rates up or support contacts?',
    'Your largest customer is loudly advocating for a new feature which is not in your prioritized roadmap. Sales, eager to please, have gone straight to Engineering to see if they can drop everything and get this done. What do you do?',
    'A restricted-documents escalation lands on your desk Friday at 5pm: a partner team shipped a ranking change that surfaces potentially restricted documents in enterprise search results. Walk me through your first 48 hours.',
    'You can ship at 85% quality now or 95% in two quarters. The 85% version has a known failure mode that silently drops 1 in 20 tasks. Ship or wait?',
    'Your eng lead disagrees with your technical approach in front of the team and is probably right. What do you do in the room, and after?',
    'You need to sunset a feature with a small but extremely vocal user base. Walk me through it.',
  ],
  behavioral: [
    'Tell me about a time you went outside your comfort zone. What was the situation and what did you do?',
    'Tell me about a time you had to mobilize people who did not report to you to get something done.',
    'Tell me about a conflict with a peer or partner. What was it really about and how did it resolve?',
    'Tell me about a wrong decision you made. What did you miss, and what changed in how you decide?',
    'How do you work — individually and as part of a team? Give me a concrete example of each.',
    'How does your experience align with what this role needs? Be specific.',
  ],
  intros: null, // built from role at runtime (see buildBanks)
  close: [
    'What do you think this role is?',
    'What questions do you have for me?',
  ],
};

function buildIntros(cfg) {
  const posting = cfg.role.posting || cfg.role.title;
  const where = `${cfg.role.company}${cfg.role.team ? ' ' + cfg.role.team : ''}`;
  return [
    'Tell me about yourself.',
    `Why this role? Why ${posting} at ${where}, and why now?`,
  ];
}

/** Merge configured bank overrides over the generic built-ins. */
function buildBanks(cfg) {
  const c = cfg || loadRehearseConfig();
  const over = (c.banks && typeof c.banks === 'object') ? c.banks : {};
  const pick = (key, fallback) => (Array.isArray(over[key]) && over[key].length ? over[key] : fallback);
  return {
    productVision: pick('productVision', DEFAULT_BANKS.productVision),
    problemSpace: pick('problemSpace', DEFAULT_BANKS.problemSpace),
    behavioral: pick('behavioral', DEFAULT_BANKS.behavioral),
    intros: pick('intros', buildIntros(c)),
    close: pick('close', DEFAULT_BANKS.close),
  };
}

// Back-compat export: generic built-in banks with default-config intros.
const QUESTION_BANKS = {
  ...DEFAULT_BANKS,
  intros: buildIntros(DEFAULT_CONFIG),
};

// Standard pushes — weakest element first, one at a time.
const STANDARD_PUSHES = [
  'What would you measure?',
  'What does the user see?',
  "You've described a process. What would you decide?",
  'What would prove you wrong?',
  "Why isn't this just a feature for [Gemini/Tasks/Assistant]?",
  "Where's the autonomy line and how does it move?",
  'If opt-in runs at 8%, do you still have a product?',
  'The person who lost that tradeoff escalates over your head. Now what?',
];

// ---------------------------------------------------------------------------
// INTERVIEWER persona — default mode
// ---------------------------------------------------------------------------
function interviewerSystem({ companion, sessionType, sessionCount, stressor, cfg }) {
  const c = cfg || loadRehearseConfig();
  const st = getSessionTypes(c)[sessionType] || getSessionTypes(c).full;
  const candidate = c.candidateName;
  const iv = c.interviewer.name;
  const roleCtx = `${c.role.posting || c.role.title}, ${c.role.level}, ${c.role.company}${c.role.team ? ' ' + c.role.team : ''}. Product: ${c.role.product}.${c.prepNote ? ' ' + c.prepNote : ''}`;
  return [
    `You are ${iv}, a ${c.role.company} hiring manager running a mock ${c.role.level} ${c.role.title} interview. The candidate is ${candidate}. Stay in character until the segment ends or ${candidate} says "break".`,
    ``,
    `${iv.toUpperCase()}'S BACKGROUND (react like this person): ${c.interviewer.background}`,
    ``,
    `ROLE CONTEXT: ${roleCtx}`,
    ``,
    `SESSION: ${st.name} (${st.minutes} min).`,
    st.brief,
    ``,
    sessionCount > 1 && stressor ? `DIFFICULTY (session ${sessionCount}): apply this ONE stressor — ${stressor}.` : ``,
    ``,
    `INTERVIEWER RULES (hard):`,
    `- Terse, polite, skeptical. Never praise, coach, explain, hint, or telegraph mid-case.`,
    `- ONE question at a time. Never compound (never two questions in one turn).`,
    `- CASE SCOPE (hard): Product Vision or Problem Space Understanding ONLY — never analytics puzzles, estimation questions, or pure metrics problems.`,
    `- After the opening answer, push 3-5 times, WEAKEST element first. Draw on: ${STANDARD_PUSHES.join(' / ')}`,
    `- Never accept: framework names as answers, both-sides without a pick, "it depends" without a NAMED dependency.`,
    `- Ambiguity: if the candidate asks >3 clarifying questions, answer the third with "What would you assume?" If the candidate asks ZERO, note it silently for the debrief — do not prompt.`,
    `- Interrupt training (FULL ROUND and CASE DRILL): interrupt mid-answer at least once per session with a sharp follow-up. If the candidate restarts from the top after an interrupt, note it for the debrief (say nothing now).`,
    `- Keep every turn SHORT (1-3 sentences, one question). This is spoken aloud — no lists, no markdown, no stage directions. Max ~60 words per turn.`,
    companion ? `` : ``,
    companion ? `COMPANION CONTEXT (what you know about ${candidate} — use to press, never to praise):\n${companion}` : ``,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// COACH mode — scoring + debrief. Never blended with INTERVIEWER.
// ---------------------------------------------------------------------------
function coachSystem({ companion, cfg }) {
  const c = cfg || loadRehearseConfig();
  const candidate = c.candidateName;
  const level = c.role.level;
  const checklist = (Array.isArray(c.checklist) ? c.checklist : []).map((l) => `- ${l}`).join('\n');
  return [
    `You are the COACH debriefing ${candidate} after a mock ${c.role.company} ${level} ${c.role.shortTitle} interview segment. The interviewer persona is OFF. Be blunt, evidence-quoted, no filler praise.`,
    ``,
    `STEP 0 — CLASSIFY FIRST (before any scoring): VISION (build/improve/design/next-great-X), PROBLEM SPACE (live mess + avoided decision + stakeholders + tradeoffs under pressure), or BEHAVIORAL (past story). State "Classified: <CATEGORY>" as your first line. If an explicit question type was provided, use it. Score with that category's marker set ONLY — misclassification invalidates the debrief.`,
    ``,
    `SCORING RUBRIC — score EVERY answer 1-4 with ONE quoted evidence line per score:`,
    `${c.role.company}'s five:`,
    `1. Problem understanding — stated assumptions and moved; clarifying questions (≤3, path-changing) are REWARDED here, never punished.`,
    `2. Problem solving — structure, decomposition, root-cause or insight announced as the turn of the answer.`,
    `3. Solutions — concrete, user-visible, with a DECISION and a named cost. Framework names are not answers.`,
    `4. Support — named cons/risks of the pick unprompted, defended anyway, ended with a METRIC. A risk named unprompted is the core Support behavior — it can never coexist with Support=1.`,
    `5. Communication — crisp, no restated sentences, length discipline (intro ≤90s, behavioral ≤3min, case opening ≤3min). A good clarifying question NEVER lowers this score.`,
    ``,
    `${level} MARKERS — universal (ALL categories; any miss is a HEADLINE):`,
    `- Set scope: stated assumptions and moved. Clarifying questions (≤3, path-changing) are REWARDED. Only permission-seeking ("am I free to…", "is there a timeframe…", "what should I focus on?") counts against.`,
    `- Made a call and named its cost (who/what loses, explicitly).`,
    ``,
    `${level} MARKERS — VISION only (never apply to problem-space answers):`,
    `- One named user (not "users"). A non-obvious insight (why this, why now). What the product BECOMES over time. A named sacrifice: what is deliberately NOT being built and why. First build + what would prove it wrong.`,
    ``,
    `${level} MARKERS — PROBLEM SPACE only (never apply to vision answers):`,
    `- Two clocks separated (now vs later, never blurred). Recoverability on genuine conflicts (protect the irreversible side; detection + rollback named). Fix-the-class mechanism (the system preventing recurrence, not a one-off).`,
    ``,
    `${level} MARKERS — BEHAVIORAL only: STAR spine intact; quantified impact with real numbers; lesson learned stated.`,
    ``,
    `CATEGORY-VALIDITY IS HARD: two clocks, fix-the-class, and detection-plus-rollback are problem-space instruments — there is no "recurrence" to prevent in a vision case, so citing them there is a scoring error. Named sacrifice and non-obvious insight are vision instruments — never demand them on problem-space answers.`,
    ``,
    `SCORE CALIBRATION: 1 = element absent. 2 = attempted, materially flawed. 3 = present and competent, one clear upgrade. 4 = would impress a real ${level} panel. Evidence quotes MUST come from the section being scored. Credit present behaviors BEFORE naming deficits. Harsh is correct; harsh-and-invalid is worse than generous — when torn between adjacent scores, take the higher one and name the single upgrade that locks it.`,
    ``,
    `${c.checklistHeading || 'CANDIDATE CHECKLIST:'}`,
    checklist,
    ``,
    `DEBRIEF FORMAT (spoken aloud + shown in chat — keep it tight, no markdown headers, plain sentences):`,
    `1. First line: "Classified: <VISION | PROBLEM SPACE | BEHAVIORAL>".`,
    `2. Headlines next: MAX 2, both category-valid, each with a short quote. ${level} misses + metric-skip (substance) + banned-list hits.`,
    `3. Per-answer scores 1-4 on the five dimensions, one quoted evidence line each, quote from the scored section. Do NOT be generous; do NOT be invalid.`,
    `4. MAX 2 fixes — the two highest-leverage changes, concrete and actionable.`,
    `5. End with exactly ONE offer: a targeted re-run of the weakest 90 seconds (name the slice), not the whole answer.`,
    `6. Include the voice metrics provided (durations, time-to-first-decision, filler rate, restarts) as one short line each where relevant.`,
    ``,
    `ANTI-BEHAVIORS: no encouraging praise, no generous scoring, no invalid-category markers, no punishment of rewarded behaviors (good clarifiers, unprompted risks, substantive metric closes), no answer rewriting unless explicitly asked, never end without classification + scores + max 2 fixes + re-run offer.`,
    companion ? `` : ``,
    companion ? `BACKGROUND ON ${candidate} (for calibration only):\n${companion}` : ``,
  ].filter(Boolean).join('\n');
}

// Difficulty stressors — session 2+ adds ONE.
const STRESSORS = [
  'tighter interrupts (cut in earlier, twice this session)',
  'hostile framing (steelman the opposing view hard; make the candidate defend)',
  'curveball domain (run the case in an unfamiliar domain, e.g. healthcare ops or logistics)',
  '6-deep chain (one thread, six follow-ups, no mercy — go until the reasoning bottoms out)',
];

function stressorForSession(count) {
  if (count < 2) return null;
  return STRESSORS[(count - 2) % STRESSORS.length];
}

// Guard / cut-in lines (server can use verbatim for reliability).
const GUARD_LINE = "Let me stop you — what's the answer?";
const CUTIN_PREFIXES = [
  'Let me jump in here — ',
  'Hold on, let me push on that — ',
  'Sorry to cut in — ',
];

module.exports = {
  PROMPT_VERSION,
  SESSION_TYPES,
  getSessionTypes,
  QUESTION_BANKS,
  DEFAULT_BANKS,
  buildBanks,
  buildIntros,
  STANDARD_PUSHES,
  STRESSORS,
  GUARD_LINE,
  CUTIN_PREFIXES,
  DEFAULT_CONFIG,
  loadRehearseConfig,
  getConfigSource,
  resetConfigCache,
  interviewerSystem,
  coachSystem,
  stressorForSession,
  loadCompanionContext,
};

// ---------------------------------------------------------------------------
// Companion context loader — SERVER-SIDE ONLY. Reads rehearsed script modules
// + letter filenames (citations) from the configured companion dir. Never ships
// to the client. Cached per process. Null companion config → no context.
// ---------------------------------------------------------------------------
let companionCache = null;
let companionCacheKey = null;
function loadCompanionContext(companionCfg, candidateName) {
  const key = JSON.stringify(companionCfg || null) + '|' + (candidateName || '');
  if (companionCache && companionCacheKey === key) return companionCache;
  companionCacheKey = key;
  if (!companionCfg || typeof companionCfg !== 'object' || !companionCfg.dir) {
    companionCache = '';
    return companionCache;
  }
  const candidate = candidateName || 'the candidate';
  const pressLine = companionCfg.pressLine || 'press on specifics';
  const dir = path.isAbsolute(companionCfg.dir)
    ? companionCfg.dir
    : path.join(__dirname, companionCfg.dir);
  const parts = [];
  try {
    const scriptFile = companionCfg.scriptFile || 'companion.json';
    const raw = JSON.parse(fs.readFileSync(path.join(dir, scriptFile), 'utf8'));
    const list = Array.isArray(raw) ? raw : [];
    for (const s of list) {
      const body = String(s.body || '').replace(/\s+/g, ' ').trim().slice(0, 900);
      if (body) parts.push(`- ${s.title || s.id}: ${body}`);
    }
  } catch { /* no private scripts — fine */ }
  try {
    const lettersDir = path.join(dir, companionCfg.lettersDir || 'letters');
    const files = fs.readdirSync(lettersDir).filter((f) => !f.startsWith('.') && /\.md$/i.test(f)).slice(0, 12);
    if (files.length) parts.push(`- Letters on file (citations available): ${files.join(', ')}`);
  } catch { /* omit */ }
  companionCache = parts.length
    ? `${candidate}'s rehearsed material (${pressLine}; never praise it):\n${parts.join('\n')}`
    : '';
  return companionCache;
}
