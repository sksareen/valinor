/**
 * Valinor Live tools — read-only retrieval over ingest, CRM, tasks, letters, activity,
 * Sauron, durable memory (recall/remember), lookup for current facts, plus play_video /
 * show_article for the Live SSE board handoff only.
 *
 * Loaded from valinor-agent/.pi/extensions (Pi cwd). CJS stores live in the repo root.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.VALINOR_ROOT || path.resolve(here, "../../..");

function loadCjs(name: string) {
  return require(path.join(repoRoot, name));
}

function cap(value: unknown, max = 8000): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function textResult(payload: unknown, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: cap(payload) }],
    details,
  };
}

function errResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: true },
  };
}

const IDENTITY_DIGEST_MAX = 1600;
const MEMORY_INJECT_MAX = 1200;
const MEMORY_FILE_MAX = 12000;
const IDENTITY_FILE_STEMS = new Set([
  "savar",
  "who is savar",
  "values",
  "vocation",
  "vocation-savar",
  "identity moc",
  "personal-operating-system",
  "operating-system",
]);

function vaultRoot(): string {
  const env = String(process.env.SAVAR_VAULT || "").trim();
  return env || path.join(os.homedir(), "Savar");
}

function memoryPath(): string {
  const env = String(process.env.VALINOR_MEMORY_PATH || "").trim();
  return env || path.join(os.homedir(), "Savar", "memory", "valinor.md");
}

function identityDir(): string {
  return path.join(vaultRoot(), "02_areas", "identity");
}

function stripFrontmatter(raw: string): string {
  const s = String(raw || "").replace(/^\uFEFF/, "");
  if (!s.startsWith("---")) return s;
  const end = s.indexOf("\n---", 3);
  if (end < 0) return s;
  const after = s.slice(end + 4);
  return after.replace(/^\s*\n/, "");
}

function firstLines(raw: string, maxChars: number): string {
  const body = stripFrontmatter(raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*#+\s*$/.test(line))
    .join("\n")
    .trim();
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars - 1).trimEnd() + "…";
}

function listIdentitySeedFiles(): string[] {
  const dir = identityDir();
  if (!fs.existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const hits: { abs: string; rank: number }[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !/\.md$/i.test(name)) continue;
    const abs = path.join(dir, name);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    const stem = name.replace(/\.md$/i, "").replace(/['’]/g, "").toLowerCase().trim();
    if (!IDENTITY_FILE_STEMS.has(stem)) continue;
    const rank = [...IDENTITY_FILE_STEMS].indexOf(stem);
    hits.push({ abs, rank: rank < 0 ? 99 : rank });
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits.slice(0, 5).map((h) => h.abs);
}

function readIdentitySnippets(budget = IDENTITY_DIGEST_MAX): string {
  const files = listIdentitySeedFiles();
  if (!files.length) return "";
  const parts: string[] = [];
  let used = 0;
  const perFile = Math.max(180, Math.floor(budget / Math.max(files.length, 1)));
  for (const abs of files) {
    if (used >= budget) break;
    let raw = "";
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const label = path.basename(abs);
    const snippet = firstLines(raw, Math.min(perFile, budget - used));
    if (!snippet) continue;
    const block = label + ":\n" + snippet;
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join("\n\n").trim();
}

function defaultMemorySeed(identity: string): string {
  const lines = [
    "# Valinor memory",
    "",
    "Short durable facts Valinor keeps about Savar. One bullet per fact.",
    "",
    "## Identity seed",
    "",
  ];
  if (identity) lines.push(identity, "");
  else lines.push("(no identity files found under the vault identity folder)", "");
  lines.push("## Learned", "");
  return lines.join("\n");
}

function ensureMemoryFile(): string {
  const file = memoryPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || !String(fs.readFileSync(file, "utf8") || "").trim()) {
    fs.writeFileSync(file, defaultMemorySeed(readIdentitySnippets(1400)), "utf8");
  }
  return file;
}

function readMemoryFile(max = MEMORY_FILE_MAX): string {
  try {
    const file = ensureMemoryFile();
    return cap(fs.readFileSync(file, "utf8"), max);
  } catch (e) {
    return "memory unavailable: " + String((e as Error).message || e);
  }
}

function learnedSection(full: string): string {
  const idx = full.search(/^##\s+Learned\s*$/m);
  if (idx < 0) return full;
  return full.slice(idx).trim();
}

function buildSpokenContext(): string {
  const chunks: string[] = [];
  const identity = readIdentitySnippets();
  if (identity) {
    chunks.push("Who Savar is (vault identity, truncated — call recall_memory or read vault for more):\n" + identity);
  }
  try {
    const mem = learnedSection(readMemoryFile(MEMORY_FILE_MAX));
    if (mem && mem.replace(/^##\s+Learned\s*/i, "").trim()) {
      chunks.push("Valinor memory (learned facts):\n" + cap(mem, MEMORY_INJECT_MAX));
    } else if (!identity) {
      chunks.push("Valinor memory is empty. Call recall_memory or read vault identity files before answering as a stranger.");
    }
  } catch {
    /* omit */
  }
  return chunks.join("\n\n").trim();
}

function localYmd(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatLocalClock(date: Date, tz: string): string {
  return date.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function formatLocalHm(date: Date, tz: string): string {
  return date.toLocaleString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

async function buildNowPlaceDigest(): Promise<string> {
  let geo: Record<string, unknown> = {};
  try {
    const live = loadCjs("live-server.js");
    if (typeof live.getHubGeo === "function") geo = (await live.getHubGeo()) || {};
  } catch {
    geo = {};
  }
  const osTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const tz = osTz;
  const now = new Date();
  const locBits = [geo.city, geo.region || geo.region_code, geo.country_code || geo.country]
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean);
  const lines = [
    "Now + place (this Mac's OS timezone; coords from browser GPS when available — not IP timezone):",
    "ISO: " + now.toISOString(),
    "Local: " + formatLocalClock(now, tz),
    "Timezone: " + tz,
    "Today (local calendar): " + localYmd(tz),
  ];
  if (locBits.length) {
    lines.push(
      "Location: " +
        locBits.join(", ") +
        (geo.approximate ? " (approximate)" : "") +
        (geo.source ? " [source=" + String(geo.source) + "]" : ""),
    );
  } else {
    lines.push("Location: unknown");
  }
  const lat = Number(geo.latitude);
  const lng = Number(geo.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    lines.push("lat: " + lat + ", lng: " + lng);
  } else {
    lines.push("lat/lng: missing");
  }
  if (geo.note) lines.push("Geo note: " + String(geo.note));
  if (geo.error) lines.push("Geo error: " + String(geo.error));
  return lines.join("\n");
}

function stripTags(s: string): string {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDdgHref(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    /* keep */
  }
  return href;
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 7000): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.json();
}

async function sunTimes(lat: number, lng: number, date: string, tz: string) {
  const url =
    "https://api.sunrise-sunset.org/json?lat=" +
    encodeURIComponent(String(lat)) +
    "&lng=" +
    encodeURIComponent(String(lng)) +
    "&date=" +
    encodeURIComponent(date) +
    "&formatted=0";
  const json = (await fetchJson(url)) as { status?: string; results?: Record<string, string> };
  if (json.status !== "OK" || !json.results) throw new Error("sunrise-sunset " + (json.status || "empty"));
  const r = json.results;
  const pick = (key: string) => {
    const iso = r[key];
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { utc: iso, local: null };
    return { utc: iso, local: formatLocalHm(d, tz) };
  };
  return {
    backend: "sunrise-sunset.org",
    date,
    timezone: tz,
    lat,
    lng,
    sunrise: pick("sunrise"),
    sunset: pick("sunset"),
    solar_noon: pick("solar_noon"),
    day_length_sec: r.day_length ? Number(r.day_length) : null,
  };
}

async function weatherNow(lat: number, lng: number, tz: string) {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    encodeURIComponent(String(lat)) +
    "&longitude=" +
    encodeURIComponent(String(lng)) +
    "&current=temperature_2m,weather_code,wind_speed_10m" +
    "&timezone=" +
    encodeURIComponent(tz);
  const json = (await fetchJson(url)) as { current?: Record<string, unknown> };
  return {
    backend: "open-meteo",
    timezone: tz,
    lat,
    lng,
    current: json.current || null,
  };
}

type SearchHit = { title: string; snippet: string; url: string };

async function searchExa(query: string): Promise<{ backend: string; results: SearchHit[] }> {
  const key = String(process.env.EXA_API_KEY || "").trim();
  if (!key) throw new Error("no EXA_API_KEY");
  const json = (await fetchJson(
    "https://api.exa.ai/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        query,
        numResults: 5,
        contents: { highlights: { maxCharacters: 280 } },
      }),
    },
    8000,
  )) as { results?: Array<{ title?: string; url?: string; highlights?: string[]; text?: string }> };
  const results: SearchHit[] = (json.results || []).slice(0, 5).map((r) => ({
    title: String(r.title || "").slice(0, 160),
    snippet: String((r.highlights && r.highlights[0]) || r.text || "").slice(0, 280),
    url: String(r.url || ""),
  }));
  return { backend: "exa", results };
}

async function searchDdg(query: string): Promise<{ backend: string; results: SearchHit[] }> {
  const results: SearchHit[] = [];
  try {
    const instant = (await fetchJson(
      "https://api.duckduckgo.com/?q=" +
        encodeURIComponent(query) +
        "&format=json&no_html=1&no_redirect=1&skip_disambig=1",
      { headers: { Accept: "application/json", "User-Agent": "valinor-live/1.0" } },
      5000,
    )) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      Answer?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
    };
    if (instant.AbstractText) {
      results.push({
        title: String(instant.Heading || "DuckDuckGo").slice(0, 160),
        snippet: String(instant.AbstractText).slice(0, 280),
        url: String(instant.AbstractURL || ""),
      });
    }
    if (instant.Answer) {
      results.push({ title: "Answer", snippet: String(instant.Answer).slice(0, 280), url: "" });
    }
    for (const row of [...(instant.Results || []), ...(instant.RelatedTopics || [])].slice(0, 4)) {
      if (!row || !row.Text) continue;
      results.push({
        title: String(row.Text).split(" - ")[0].slice(0, 160),
        snippet: String(row.Text).slice(0, 280),
        url: String(row.FirstURL || ""),
      });
    }
  } catch {
    /* fall through to HTML */
  }
  if (results.length >= 3) return { backend: "duckduckgo", results: results.slice(0, 5) };

  const htmlRes = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { Accept: "text/html", "User-Agent": "valinor-live/1.0" },
    signal: AbortSignal.timeout(7000),
  });
  if (!htmlRes.ok) throw new Error("ddg HTML HTTP " + htmlRes.status);
  const html = await htmlRes.text();
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < 5) {
    const url = decodeDdgHref(m[1]);
    const title = stripTags(m[2]).slice(0, 160);
    const snippet = stripTags(m[3] || "").slice(0, 280);
    if (!title) continue;
    results.push({ title, snippet, url });
  }
  return { backend: "duckduckgo", results: results.slice(0, 5) };
}

async function webSearch(query: string): Promise<{ backend: string; results: SearchHit[] }> {
  if (String(process.env.EXA_API_KEY || "").trim()) {
    try {
      const exa = await searchExa(query);
      if (exa.results.length) return exa;
    } catch (e) {
      console.warn("[lookup] Exa failed, falling back:", String((e as Error).message || e).slice(0, 160));
    }
  }
  return searchDdg(query);
}

function isSunQuery(q: string): boolean {
  return /\b(sun\s*set|sun\s*rise|sunrise|sunset|dawn|dusk|solar noon|golden hour)\b/i.test(q);
}

function isWeatherQuery(q: string): boolean {
  return /\b(weather|forecast|temperature|how hot|how cold|rain|snow)\b/i.test(q);
}

function normalizeFact(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function factWords(s: string): Set<string> {
  return new Set(normalizeFact(s).split(" ").filter((w) => w.length > 2));
}

function factsOverlap(a: string, b: string): boolean {
  const na = normalizeFact(a);
  const nb = normalizeFact(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = factWords(a);
  const wb = factWords(b);
  if (!wa.size || !wb.size) return false;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  const denom = Math.min(wa.size, wb.size);
  return denom > 0 && hit / denom >= 0.7;
}

function parseLearnedBullets(full: string): { prefix: string; bullets: string[] } {
  const idx = full.search(/^##\s+Learned\s*$/m);
  if (idx < 0) return { prefix: full.trimEnd() + "\n\n## Learned\n", bullets: [] };
  const prefix = full.slice(0, idx).trimEnd() + "\n\n## Learned\n";
  const rest = full.slice(idx).replace(/^##\s+Learned\s*/m, "");
  const bullets = rest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l));
  return { prefix, bullets };
}

function appendMemoryFact(fact: string, kind?: string): { stored: boolean; reason: string; line: string } {
  const clean = String(fact || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!clean) return { stored: false, reason: "empty fact", line: "" };
  const file = ensureMemoryFile();
  const full = fs.readFileSync(file, "utf8");
  const { prefix, bullets } = parseLearnedBullets(full);
  const existingBody = (b: string) => b.replace(/^[-*]\s+/, "").replace(/^\d{4}-\d{2}-\d{2}\s*/, "").replace(/^\[[^\]]+\]\s*/, "");
  for (const b of bullets) {
    if (factsOverlap(existingBody(b), clean)) {
      return { stored: false, reason: "duplicate", line: b };
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  const tag = kind ? ` [${String(kind).trim().slice(0, 24)}]` : "";
  const line = `- ${day}${tag}: ${clean}`;
  const next = prefix + "\n" + [...bullets, line].join("\n") + "\n";
  fs.writeFileSync(file, next, "utf8");
  return { stored: true, reason: "appended", line };
}

const searchIngestTool = defineTool({
  name: "search_ingest",
  label: "Search ingest",
  description:
    "Search or read Savar's ingest captures (voice notes, screenshots, refined plans). Use when he asks about a note, capture, screenshot, or plan he ingested. Pass query to filter, or id to read one capture. Not in the every-turn digest — you must call this.",
  promptSnippet: "Search/read ingest captures",
  promptGuidelines: [
    "When Savar asks about a capture, screenshot, voice note, or ingest plan, call search_ingest. Do not guess from memory.",
  ],
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Filter title/preview (omit for recent)" })),
    id: Type.Optional(Type.String({ description: "Capture id to read in full" })),
    limit: Type.Optional(Type.Number({ description: "Max list results (default 12, max 40)" })),
  }),
  async execute(_toolCallId, params) {
    try {
      const ingest = loadCjs("ingest-server.js");
      const id = String(params.id || "").trim();
      if (id) {
        const rec = ingest.readCapture(id);
        if (!rec) return errResult("No capture with id " + id);
        const markdown = String(rec.markdown || "").slice(0, 4000);
        return textResult({
          id: rec.id,
          title: rec.meta?.title || rec.id,
          created: rec.meta?.created || null,
          source: rec.meta?.source || null,
          markdown,
        });
      }
      const limit = Math.min(Math.max(Number(params.limit) || 12, 1), 40);
      const q = String(params.query || "").trim().toLowerCase();
      let items = ingest.listCaptures(80) || [];
      if (q) {
        items = items.filter((c: { title?: string; preview?: string; id?: string }) => {
          const hay = `${c.id || ""} ${c.title || ""} ${c.preview || ""}`.toLowerCase();
          return hay.includes(q);
        });
      }
      items = items.slice(0, limit).map((c: { id: string; title?: string; created?: string; source?: string; preview?: string }) => ({
        id: c.id,
        title: c.title,
        created: c.created,
        source: c.source,
        preview: c.preview,
      }));
      return textResult({ count: items.length, items });
    } catch (e) {
      return errResult("ingest unavailable: " + String((e as Error).message || e));
    }
  },
});

const lookupPersonTool = defineTool({
  name: "lookup_person",
  label: "Lookup person",
  description:
    "Look up someone in Savar's CRM / iMessage roster by name or numeric id. Returns role, notes, and a short recent thread when available.",
  promptSnippet: "Look up a person in CRM",
  parameters: Type.Object({
    query: Type.String({ description: "Name (partial OK) or numeric person id" }),
  }),
  async execute(_toolCallId, params) {
    const query = String(params.query || "").trim();
    if (!query) return errResult("query is required");
    try {
      const network = loadCjs("network-data.js");
      if (/^-?\d+$/.test(query)) {
        const ctx = network.getContext(query);
        if (!ctx) return errResult("No person with id " + query);
        return textResult(slimPerson(ctx));
      }
      const roster = network.getRoster() || [];
      const needle = query.toLowerCase();
      const hits = roster.filter((p: { name?: string }) => String(p.name || "").toLowerCase().includes(needle));
      if (!hits.length) return textResult({ matches: [], note: "No roster match for " + query });
      if (hits.length === 1) {
        const ctx = network.getContext(hits[0].id);
        return textResult(ctx ? slimPerson(ctx) : slimRoster(hits[0]));
      }
      return textResult({
        matches: hits.slice(0, 8).map(slimRoster),
        note: "Several matches — ask Savar which one, or call again with an id.",
      });
    } catch (e) {
      return errResult("people store unavailable: " + String((e as Error).message || e));
    }
  },
});

function slimRoster(p: { id?: unknown; name?: string; company?: string; role?: string; oneLiner?: string; tags?: string[] }) {
  return {
    id: p.id,
    name: p.name,
    company: p.company || null,
    role: p.role || null,
    oneLiner: p.oneLiner || null,
    tags: p.tags || [],
  };
}

function slimPerson(ctx: Record<string, unknown>) {
  const thread = Array.isArray(ctx.thread)
    ? (ctx.thread as Array<{ fromMe?: boolean; text?: string }>).slice(-6).map((m) => ({
        fromMe: !!m.fromMe,
        text: String(m.text || "").slice(0, 220),
      }))
    : null;
  return {
    id: ctx.id,
    name: ctx.name,
    company: ctx.company || null,
    role: ctx.role || null,
    school: ctx.school || null,
    oneLiner: ctx.oneLiner || null,
    notes: ctx.notes ? String(ctx.notes).slice(0, 1500) : null,
    tags: ctx.tags || [],
    hasPhone: !!ctx.hasPhone,
    daysSince: ctx.daysSince ?? null,
    msgCount: ctx.msgCount ?? null,
    thread,
  };
}

const listTasksTool = defineTool({
  name: "list_tasks",
  label: "List tasks",
  description:
    "List Savar's execute-tab tasks (backlog / active / review / done), or fetch one by id. Use when he asks what he is working on, what's next, or task status. Not machine/app activity — that is recent_activity.",
  promptSnippet: "List execution tasks",
  promptGuidelines: [
    "When Savar asks what he is working on, what's next, or about a task, call list_tasks before answering.",
  ],
  parameters: Type.Object({
    id: Type.Optional(Type.String({ description: "Task id for a single task" })),
    limit: Type.Optional(Type.Number({ description: "Max list results (default 20, max 50)" })),
  }),
  async execute(_toolCallId, params) {
    try {
      const execute = loadCjs("execute-server.js");
      const id = String(params.id || "").trim();
      if (id) {
        const task = execute.getTask(id);
        if (!task) return errResult("No task with id " + id);
        return textResult(slimTask(task));
      }
      const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);
      const tasks = (execute.listTasks() || []).slice(0, limit).map(slimTask);
      return textResult({ count: tasks.length, tasks });
    } catch (e) {
      return errResult("tasks unavailable: " + String((e as Error).message || e));
    }
  },
});

function slimTask(t: Record<string, unknown>) {
  return {
    id: t.id,
    title: t.title || null,
    outcome: t.outcome ? String(t.outcome).slice(0, 400) : null,
    status: t.status || t.state || null,
    kind: t.kind || 'task',
    created: t.created || null,
    sourceIngestId: t.sourceIngestId || null,
  };
}

const listLettersTool = defineTool({
  name: "list_letters",
  label: "List letters",
  description: "List markdown letters Savar has written. Returns filename, preview, and an absolute path you can read.",
  promptSnippet: "List letters",
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max letters (default 15, max 40)" })),
  }),
  async execute(_toolCallId, params) {
    try {
      const dir = process.env.LETTERS_DIR || path.join(repoRoot, "letters");
      if (!fs.existsSync(dir)) return textResult({ count: 0, letters: [], note: "letters folder missing" });
      const limit = Math.min(Math.max(Number(params.limit) || 15, 1), 40);
      const files = fs
        .readdirSync(dir)
        .filter((f: string) => !f.startsWith(".") && /\.(md|txt)$/i.test(f))
        .map((f: string) => {
          const abs = path.join(dir, f);
          const st = fs.statSync(abs);
          let preview = "";
          try {
            preview = String(fs.readFileSync(abs, "utf8")).replace(/\s+/g, " ").trim().slice(0, 240);
          } catch {
            preview = "";
          }
          return { file: f, path: abs, mtime: st.mtimeMs, preview };
        })
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime)
        .slice(0, limit);
      return textResult({ count: files.length, letters: files });
    } catch (e) {
      return errResult("letters unavailable: " + String((e as Error).message || e));
    }
  },
});

const sauronSessionsTool = defineTool({
  name: "sauron_sessions",
  label: "Sauron sessions",
  description:
    "Recall recent machine/agent activity from Sauron's experience graph. Optional query searches; omit for recent records.",
  promptSnippet: "Recall recent Sauron activity",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Search string (omit for recent)" })),
    limit: Type.Optional(Type.Number({ description: "Max records (default 12, max 40)" })),
  }),
  async execute(_toolCallId, params) {
    const sauronBin = process.env.SAURON_BIN || path.join(os.homedir(), "go", "bin", "sauron");
    const limit = Math.min(Math.max(Number(params.limit) || 12, 1), 40);
    const q = String(params.query || "").trim();
    const args = q
      ? ["experience", "search", q, "--json", "--limit", String(limit)]
      : ["experience", "recent", String(limit), "--json"];
    try {
      const { stdout } = await execFileAsync(sauronBin, args, {
        timeout: 8000,
        maxBuffer: 2 * 1024 * 1024,
      });
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(String(stdout || "[]"));
      } catch {
        return textResult({ raw: String(stdout || "").slice(0, 2000) });
      }
      const rows = Array.isArray(parsed) ? parsed : [];
      const records = (q
        ? rows.map((r: { record?: unknown; score?: unknown }) => ({ ...(r.record as object || r), score: r.score }))
        : rows
      ).map((r: Record<string, unknown>) => {
        const { embedding, ...rest } = r;
        return rest;
      });
      return textResult({ count: records.length, records: records.slice(0, limit) });
    } catch (e) {
      return errResult("sauron unavailable: " + String((e as Error).message || e));
    }
  },
});

const recallMemoryTool = defineTool({
  name: "recall_memory",
  label: "Recall memory",
  description:
    "Read Valinor's durable memory about Savar (identity seed + learned facts). Use when asked who Savar is, preferences, ongoing threads, or when a reply would otherwise be generic.",
  promptSnippet: "Recall Savar's durable Valinor memory",
  promptGuidelines: [
    "If asked who Savar is, about his life, or you would otherwise answer as a stranger, call recall_memory first.",
  ],
  parameters: Type.Object({
    focus: Type.Optional(Type.String({ description: "Optional topic to emphasize (identity, plans, people)" })),
  }),
  async execute(_toolCallId, _params) {
    try {
      const identity = readIdentitySnippets();
      const memory = readMemoryFile();
      const body = [
        identity ? "Identity files (truncated):\n" + identity : "",
        "Memory file:\n" + memory,
      ]
        .filter(Boolean)
        .join("\n\n");
      return textResult(body, { path: memoryPath() });
    } catch (e) {
      return errResult("memory unavailable: " + String((e as Error).message || e));
    }
  },
});

const rememberTool = defineTool({
  name: "remember",
  label: "Remember",
  description:
    "Append a short durable fact about Savar (who, preference, project, people, commitment). Not a vault rewrite. Dedupes obvious repeats.",
  promptSnippet: "Store a short fact in Valinor memory",
  promptGuidelines: [
    "When Savar states a preference, plan, person, decision, or commitment worth keeping, call remember with one short fact.",
  ],
  parameters: Type.Object({
    fact: Type.String({ description: "One short fact to keep" }),
    kind: Type.Optional(
      Type.String({ description: "who | preference | project | people | commitment" }),
    ),
  }),
  async execute(_toolCallId, params) {
    const fact = String(params.fact || "").trim();
    if (!fact) return errResult("fact is required");
    try {
      const result = appendMemoryFact(fact, String(params.kind || "").trim() || undefined);
      return textResult(result, { path: memoryPath() });
    } catch (e) {
      return errResult("remember failed: " + String((e as Error).message || e));
    }
  },
});

const captureMemoryTool = defineTool({
  name: "capture_memory",
  label: "Capture memory",
  description:
    "Save a thought, idea, recommendation, or decision from this conversation into ingest as a memory artifact. It lands in capture with full text, shows up for promotion to tasks, and auto-suggests follow-ups. Use when the conversation produces anything worth keeping — your recommendations, his ideas, agreed next steps. Prefer several small captures over one big one.",
  promptSnippet: "Save a memory artifact to ingest",
  promptGuidelines: [
    "When this conversation yields an idea, recommendation, decision, or next step worth keeping, call capture_memory with the full text. One artifact per thought — call it multiple times rather than merging.",
  ],
  parameters: Type.Object({
    text: Type.String({ description: "Full text of the thought/recommendation (1-6 sentences)" }),
    kind: Type.Optional(Type.String({ description: "idea | recommendation | decision | thought (default thought)" })),
    title: Type.Optional(Type.String({ description: "Short title (omit to auto-generate)" })),
    threadId: Type.Optional(Type.String({ description: "Conversation thread id (omit = current live thread)" })),
  }),
  async execute(_toolCallId, params) {
    const text = String(params.text || "").trim();
    if (!text) return errResult("text is required");
    try {
      const ingest = loadCjs("ingest-server.js");
      const live = loadCjs("live-server.js");
      const apiKey = String(process.env.OPENROUTER_API_KEY || "");
      if (!apiKey) return errResult("OPENROUTER_API_KEY is missing — cannot refine the capture");
      let threadId = String(params.threadId || "").trim();
      let threadTitle = "";
      if (!threadId) {
        try {
          const active = live.getActiveConversationId ? live.getActiveConversationId() : null;
          if (active) {
            threadId = "live:" + active;
            const c = live.getLiveConversation ? live.getLiveConversation(active) : null;
            threadTitle = (c && (c as { title?: string }).title) || "";
          }
        } catch { /* proceed without provenance */ }
      }
      const rec = await ingest.capture({
        text,
        source: "conversation",
        kind: String(params.kind || "thought"),
        title: String(params.title || "").trim() || undefined,
        threadId: threadId || undefined,
        threadTitle: threadTitle || undefined,
        origin: "agent",
      }, apiKey);
      return textResult({ id: rec.id, title: rec.title, kind: String(params.kind || "thought"), threadId: threadId || null }, { path: rec.path });
    } catch (e) {
      return errResult("capture_memory failed: " + String((e as Error).message || e));
    }
  },
});

const recentActivityTool = defineTool({
  name: "recent_activity",
  label: "Recent activity",
  description:
    "Compact snapshot of what Savar is doing on the machine now: frontmost app, recent timeline events, light HW, latest cursor captures. Use when he asks what he is doing, which app he is in, or recent machine/cursor activity. Not the execute task list and not a full Sauron dump.",
  promptSnippet: "Read current machine/activity snapshot",
  promptGuidelines: [
    "When Savar asks what he is doing now, what he is working on at the computer, or recent app/cursor activity, call recent_activity (and list_tasks if he means the execute backlog).",
  ],
  parameters: Type.Object({
    hours: Type.Optional(Type.Number({ description: "Lookback hours (default 2, max 12)" })),
    limit: Type.Optional(Type.Number({ description: "Max timeline events (default 8, max 20)" })),
  }),
  async execute(_toolCallId, params) {
    try {
      const hours = Math.min(Math.max(Number(params.hours) || 2, 0.25), 12);
      const limit = Math.min(Math.max(Number(params.limit) || 8, 1), 20);
      const activity = loadCjs("activity-context.js");
      const snap = await activity.compactRecentActivity({ hours, limit });
      return textResult(snap);
    } catch (e) {
      return errResult("activity unavailable: " + String((e as Error).message || e));
    }
  },
});

const lookupTool = defineTool({
  name: "lookup",
  label: "Lookup",
  description:
    "Answer current facts: sunset/sunrise, weather, news, scores, or anything that needs the web. Uses hub geo + local date when relevant. Not the board — do not use this to put a Wikipedia card or video on screen.",
  promptSnippet: "Look up current facts (sunset, weather, news, web)",
  promptGuidelines: [
    "For sunset, weather, news, scores, or other current facts, call lookup. Do not call play_video or show_article.",
    "Use injected now + geo (OS timezone; GPS or timezone-city coords). Do not ask Savar what city he is in if lat/lng or city is present.",
    "Speak 1–3 sentences with a local clock time (e.g. sunset was 7:52 pm).",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "What to look up, e.g. sunset today, weather, or a news/score query." }),
  }),
  async execute(_toolCallId, params) {
    const query = String(params.query || "").trim();
    if (!query) return errResult("query is required");
    try {
      let geo: Record<string, unknown> = {};
      try {
        const live = loadCjs("live-server.js");
        if (typeof live.getHubGeo === "function") geo = (await live.getHubGeo()) || {};
      } catch {
        geo = {};
      }
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const lat = Number(geo.latitude);
      const lng = Number(geo.longitude);
      const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);
      const date = localYmd(tz);
      const extras: Record<string, unknown> = {
        query,
        timezone: tz,
        date,
        source: geo.source || null,
        approximate: !!geo.approximate,
      };

      if (isSunQuery(query) && hasGeo) {
        extras.sun = await sunTimes(lat, lng, date, tz);
        extras.backend = "sunrise-sunset.org";
        console.log("[lookup] backend=sunrise-sunset.org date=" + date);
        return textResult(extras, { backend: "sunrise-sunset.org", query });
      }
      if (isWeatherQuery(query) && hasGeo) {
        extras.weather = await weatherNow(lat, lng, tz);
        extras.backend = "open-meteo";
        console.log("[lookup] backend=open-meteo");
        return textResult(extras, { backend: "open-meteo", query });
      }

      const search = await webSearch(query);
      extras.backend = search.backend;
      extras.results = search.results;
      if (hasGeo) {
        extras.lat = lat;
        extras.lng = lng;
        extras.location = [geo.city, geo.region || geo.region_code, geo.country_code]
          .filter(Boolean)
          .join(", ");
      }
      console.log("[lookup] backend=" + search.backend + " hits=" + search.results.length);
      return textResult(extras, { backend: search.backend, query });
    } catch (e) {
      return errResult("lookup failed: " + String((e as Error).message || e));
    }
  },
});

const playVideoTool = defineTool({
  name: "play_video",
  label: "Play video",
  description:
    "Play a YouTube video on the Live board. Use when Savar says play, watch, video, clip, song, trailer, or YouTube. Never Wikipedia. Not for sunset/weather/news (use lookup).",
  promptSnippet: "Play a YouTube video on the board",
  promptGuidelines: [
    "play / watch / video / clip / song / trailer / YouTube → play_video. Current facts use lookup.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: 'YouTube search query, e.g. "The Odyssey movie review YouTube".' }),
  }),
  async execute(_toolCallId, params) {
    const query = String(params.query || "").trim();
    if (!query) return errResult("query is required");
    return {
      content: [{ type: "text" as const, text: "Queued video on the board: " + query }],
      details: { query, board: true, kind: "video" },
    };
  },
});

const showArticleTool = defineTool({
  name: "show_article",
  label: "Show article",
  description:
    "Put a Wikipedia article on the Live board. Use when Savar wants a card/article on screen, not a video, and not a spoken fact (use lookup).",
  promptSnippet: "Put a Wikipedia card on the board",
  promptGuidelines: [
    "Put it on the board / Wikipedia card / show the article → show_article. Videos use play_video. Facts use lookup.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: 'Wikipedia search query, e.g. "Alan Turing".' }),
  }),
  async execute(_toolCallId, params) {
    const query = String(params.query || "").trim();
    if (!query) return errResult("query is required");
    return {
      content: [{ type: "text" as const, text: "Queued article on the board: " + query }],
      details: { query, board: true, kind: "wiki" },
    };
  },
});

export default function valinorExtension(pi: ExtensionAPI) {
  pi.registerTool(searchIngestTool);
  pi.registerTool(lookupPersonTool);
  pi.registerTool(listTasksTool);
  pi.registerTool(listLettersTool);
  pi.registerTool(sauronSessionsTool);
  pi.registerTool(recentActivityTool);
  pi.registerTool(playVideoTool);
  pi.registerTool(showArticleTool);
  pi.registerTool(lookupTool);
  pi.registerTool(recallMemoryTool);
  pi.registerTool(rememberTool);
  pi.registerTool(captureMemoryTool);

  pi.on("before_agent_start", async (event) => {
    try {
      const extras: string[] = [];
      const spoken = buildSpokenContext();
      if (spoken) extras.push(spoken);
      extras.push(await buildNowPlaceDigest());
      // Absolute paths the model can feed to `read` (injected at runtime so no
      // home-directory paths are ever written into repo prompt files).
      extras.push(
        "Paths (`read` takes absolute paths):\n" +
          "Repo root (hub source — plan.html, server.js, *.js): " + repoRoot + "\n" +
          "Agent home (skills under .pi/skills): " + path.join(repoRoot, "valinor-agent") + "\n" +
          "Vault root (identity, journal, people notes): " + vaultRoot() + "\n" +
          "Memory file: " + memoryPath()
      );
      const live = loadCjs("live-server.js");
      const meta = typeof live.getSpokenTurnMeta === "function" ? live.getSpokenTurnMeta() : {};
      const digest =
        typeof live.buildHubDigest === "function" ? live.buildHubDigest({ activeTab: meta.activeTab }) : "";
      if (digest) extras.push("Hub context (may be stale by seconds):\n" + digest);
      if (!extras.length) return undefined;
      return {
        systemPrompt: event.systemPrompt + "\n\n" + extras.join("\n\n"),
      };
    } catch {
      return undefined;
    }
  });
}
