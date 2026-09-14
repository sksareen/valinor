// imessage-ingest.js — pull recent iMessages (this Mac) into the ingest store.
//
// Reads ~/Library/Messages/chat.db through the sqlite3 CLI. The live db is never
// touched: chat.db (+ its WAL sidecars, if present) is copied to a temp dir first
// and the copy is queried read-only. One capture per chat, overwritten each sync
// with the latest window — a living digest, always fresh, never duplicated. A sync
// rewrites a chat only when its newest message changed (lastRowid in frontmatter).
// Needs Full Disk Access for the server process if chat.db isn't readable, in which
// case sync fails with instructions instead of garbage.
// PRIVATE — these live in ~/Savar/memory/ingest and must NEVER be promoted to valinor.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { INGEST_DIR, ensureDir } = require('./ingest-server');
const { loadContactMaps, resolveHandle } = require('./contacts-resolve');

// ---- attachments: stage image/video/audio files next to the digest ---------
// Staged as <fid>-<rowid>-<i>.<ext> in INGEST_DIR, served by /api/ingest/media.
// HEIC/TIFF (not browser-renderable) are converted to JPEG via sips.
const MAX_ATT_BYTES = 60 * 1024 * 1024;
const MAX_ATTS_PER_MSG = 6;

function expandHome(p) {
  let s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}
function attKind(mime, filename) {
  const m = String(mime || '').toLowerCase();
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (m.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
  if (m === 'image/heic' || m === 'image/heic-sequence' || m === 'image/tiff' || ['.heic', '.heif', '.tif', '.tiff'].includes(ext)) return 'heic';
  if (m.startsWith('video/') || ['.mov', '.mp4', '.m4v'].includes(ext)) return 'video';
  if (m.startsWith('audio/') || ['.m4a', '.mp3', '.wav', '.caf'].includes(ext)) return 'audio';
  return 'file';
}
function attLabel(r) {
  const t = String(r.aname || '').trim();
  if (t) return t;
  const f = expandHome(r.afile);
  return path.basename(f) || 'attachment';
}
// Copy/convert one attachment into the vault. Returns {kind, url, label} or null.
function stageAttachment(fid, rowid, idx, r) {
  try {
    const src = expandHome(r.afile);
    if (!src) return { kind: 'file', url: null, label: attLabel(r) };
    let st = null;
    try { st = fs.statSync(src); } catch { return { kind: 'file', url: null, label: attLabel(r) }; }
    if (!st.isFile() || st.size === 0 || st.size > MAX_ATT_BYTES) {
      return { kind: 'file', url: null, label: attLabel(r) };
    }
    const kind = attKind(r.amime, src);
    if (kind === 'file') return { kind: 'file', url: null, label: attLabel(r) };
    let ext = path.extname(src).toLowerCase();
    let dest;
    if (kind === 'heic') {
      dest = path.join(INGEST_DIR, `${fid}-${rowid}-${idx}.jpg`);
      execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', dest], { timeout: 60000 });
    } else {
      if (kind === 'image' && !['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) ext = '.jpg';
      if (kind === 'video' && !ext) ext = '.mov';
      if (kind === 'audio' && !ext) ext = '.m4a';
      dest = path.join(INGEST_DIR, `${fid}-${rowid}-${idx}${ext}`);
      fs.copyFileSync(src, dest);
    }
    const base = path.basename(dest);
    return { kind, url: `/api/ingest/media?id=${encodeURIComponent(fid)}&file=${encodeURIComponent(base)}`, label: attLabel(r) };
  } catch {
    return { kind: 'file', url: null, label: attLabel(r) };
  }
}
function clearStaged(fid) {
  try {
    const pre = `${fid}-`;
    for (const f of fs.readdirSync(INGEST_DIR)) {
      if (f.startsWith(pre)) { try { fs.unlinkSync(path.join(INGEST_DIR, f)); } catch {} }
    }
  } catch {}
}

const CHAT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
// Cocoa Core Data timestamps: seconds since 2001-01-01.
const APPLE_EPOCH = 978307200;

function runSqlite(dbPath, sql, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', dbPath, sql], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const s = String(stderr || err.message || err);
        if (/unable to open|permission|denied|authorization/i.test(s)) {
          reject(new Error('Could not read chat.db. Grant Full Disk Access: System Settings → Privacy & Security → Full Disk Access → enable your terminal/node, then retry.'));
        } else {
          reject(new Error(s.slice(0, 300)));
        }
        return;
      }
      try {
        const rows = JSON.parse(String(stdout || '[]'));
        resolve(Array.isArray(rows) ? rows : []);
      } catch (e) { reject(new Error('could not parse sqlite output')); }
    });
  });
}

// attributedBody is a binary plist wrapping the text (often UTF-16). Decode both
// ways, split on control bytes, drop serialization markers, and keep the longest
// surviving run — that's the message text ~always.
const MARKER_SUB = /streamtyped|nsstring|nsattributed|nsobject|nsdictionary|nsvalue|nskeyed|nsnumber|immessage|imfiletransfer|attributename|basewriting|__k|guid|avalanche|\$[a-z]|[0-9a-f]{8}-[0-9a-f]{4}/i;
const UUID_RUN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
function runsOf(s) {
  return s
    .split(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/)
    .map((r) => r.replace(/[\uFFFC\uFFFD]/g, '').trim())
    .filter((r) => r.length >= 2 && !MARKER_SUB.test(r) && !UUID_RUN.test(r) && /[a-zA-Z0-9\u00C0-\u024F\u{1F300}-\u{1FAFF}]/u.test(r));
}
// Mail/iMessage text can carry style prefixes ("+D…", "+)…", "+<…", "Dhttp…") — strip them.
function deprefix(s) {
  return String(s || '')
    .replace(/^\+[)"<A-Za-z0-9]\s?/, '')
    .replace(/^[A-Z](?=https?:)/, '')
    .trim();
}
function extractRichText(hex) {
  if (!hex) return '';
  let buf;
  try { buf = Buffer.from(String(hex), 'hex'); } catch (e) { return ''; }
  if (!buf.length) return '';
  // The string sits inside a binary plist at an *unaligned* offset, so decoding
  // the whole buffer as UTF-16 swaps every pair into CJK mojibake. Instead scan
  // for byte-level runs: 00 xx (UTF-16BE) or xx 00 (UTF-16LE), plus plain UTF-8.
  const ascii = (b) => (b >= 32 && b < 127) || b === 10 || b === 9;
  const found = [];
  let i = 0;
  while (i < buf.length - 1) {
    if (buf[i] === 0 && ascii(buf[i + 1])) {
      let s = '';
      while (i < buf.length - 1 && buf[i] === 0 && ascii(buf[i + 1])) { s += String.fromCharCode(buf[i + 1]); i += 2; }
      found.push(s);
      continue;
    }
    if (ascii(buf[i]) && buf[i + 1] === 0) {
      let s = '';
      while (i < buf.length - 1 && ascii(buf[i]) && buf[i + 1] === 0) { s += String.fromCharCode(buf[i]); i += 2; }
      found.push(s);
      continue;
    }
    i++;
  }
  try { found.push(buf.toString('utf8')); } catch (e) {}
  const runs = [];
  for (const s of found) runs.push(...runsOf(s));
  if (!runs.length) return '';
  runs.sort((a, b) => b.length - a.length);
  return deprefix(runs[0].slice(0, 2000));
}
// m.text is usually clean, but can carry attribute junk — same treatment.
function cleanText(s) {
  const runs = runsOf(String(s || ''));
  if (!runs.length) return '';
  runs.sort((a, b) => b.length - a.length);
  return deprefix(runs[0].slice(0, 2000));
}

function fmtTime(appleNs) {
  const d = new Date(Math.round(appleNs / 1e6) + APPLE_EPOCH * 1000);
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function isoTime(appleNs) {
  return new Date(Math.round(appleNs / 1e6) + APPLE_EPOCH * 1000).toISOString();
}

function chatFileId(guid) {
  return 'imsg-' + crypto.createHash('sha1').update(String(guid)).digest('hex').slice(0, 12);
}

function existingLastRowid(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 800);
    const m = /^lastRowid:\s*(\d+)$/m.exec(head);
    return m ? Number(m[1]) : null;
  } catch (e) { return null; }
}

function toMarkdown({ id, guid, name, lines, newestRowid, newestIso }) {
  const fm = [
    '---',
    `id: ${id}`,
    `created: ${newestIso}`,
    'source: imessage',
    `title: ${JSON.stringify(name)}`,
    `chat: ${JSON.stringify(guid)}`,
    `lastRowid: ${newestRowid}`,
    'tags: [ingest, imessage]',
    '---',
    '',
  ].join('\n');
  return `${fm}# ${name}\n\n${lines.join('\n')}\n`;
}

// Pull recent chats. One living digest per chat, newest message first across chats.
// Returns a summary.
async function importMessages({ days = 7, maxChats = 25, perChat = 30 } = {}) {
  ensureDir();
  days = Math.max(1, Number(days) || 7);
  maxChats = Math.max(1, Math.min(100, Number(maxChats) || 25));
  perChat = Math.max(5, Math.min(100, Number(perChat) || 30));
  // copy the db (never query live — WAL may be mid-write)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-'));
  try {
    for (const f of ['chat.db', 'chat.db-wal', 'chat.db-shm']) {
      const src = path.join(path.dirname(CHAT_DB), f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    }
    const cutoffApple = Date.now() / 1000 - 86400 * days - APPLE_EPOCH;
    const limit = maxChats * perChat * 2 + 200;
    const rows = await runSqlite(path.join(tmp, 'chat.db'), `
      SELECT m.ROWID AS rowid, m.text AS text, hex(m.attributedBody) AS rich,
             m.date AS date, m.is_from_me AS mine, m.cache_has_attachments AS att,
             h.id AS handle, c.guid AS chat, c.display_name AS name,
             a.filename AS afile, a.mime_type AS amime, a.transfer_name AS aname,
             a.is_sticker AS asticker, a.hide_attachment AS ahide
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = j.chat_id
      LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
      LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE m.date/1000000000 + ${APPLE_EPOCH} > ${cutoffApple}
        AND m.item_type = 0
        AND (m.associated_message_type IS NULL OR m.associated_message_type = 0
             OR m.associated_message_type < 2000 OR m.associated_message_type > 3999)
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
      ORDER BY m.date DESC LIMIT ${limit};`);
    // group into chats (newest chat first = first-seen order here)
    // JOIN fan-out: one row per (message, attachment) — fold attachments into the message
    const maps = loadContactMaps(); // phone/email -> contact name; empty on failure
    const whoName = (handle) => resolveHandle(handle, maps) || handle || 'them';
    const chats = new Map();
    for (const r of rows) {
      const key = r.chat || `handle:${r.handle || 'unknown'}`;
      if (!chats.has(key)) chats.set(key, { guid: key, name: r.name || null, handles: new Set(), msgs: [] });
      const c = chats.get(key);
      if (r.handle) c.handles.add(r.handle);
      let m = c.msgs.length ? c.msgs[c.msgs.length - 1] : null;
      if (!m || m.rowid !== r.rowid) {
        let text = cleanText(r.text);
        // attachment blobs decode to filename junk — never mine them for text
        if (!text && !r.att && r.rich) text = extractRichText(r.rich);
        m = { rowid: r.rowid, date: r.date, mine: !!r.mine, who: r.mine ? 'Me' : whoName(r.handle), text, atts: [] };
        c.msgs.push(m);
      }
      // collect attachment descriptors (skip hidden/link-unfurl rows)
      if (r.afile && !r.ahide && m.atts.length < MAX_ATTS_PER_MSG &&
          !m.atts.some(a => a.afile === r.afile)) {
        m.atts.push({ afile: r.afile, amime: r.amime, aname: r.aname, asticker: !!r.asticker });
      }
    }
    // drop messages with neither text nor attachments
    for (const c of chats.values()) {
      c.msgs = c.msgs.filter(m => (m.text && m.text.trim()) || m.atts.length);
    }
    let chatsSeen = 0, rewritten = 0, skipped = 0, messages = 0;
    for (const c of chats.values()) {
      if (chatsSeen >= maxChats) break;
      chatsSeen++;
      const msgs = c.msgs.slice(0, perChat);
      if (!msgs.length) continue;
      const fid = chatFileId(c.guid);
      const file = path.join(INGEST_DIR, `${fid}.md`);
      const newest = msgs[0].rowid;
      if (fs.existsSync(file) && existingLastRowid(file) === newest) { skipped++; continue; }
      clearStaged(fid); // drop previous attachment files before re-staging
      const others = [...c.handles].map(whoName).join(', ');
      const name = c.name || (others ? `Chat with ${others}` : 'iMessage chat');
      const lines = [];
      for (const m of msgs.slice().reverse()) {
        lines.push(`[${fmtTime(m.date)}] ${m.who}: ${m.text || ''}`.replace(/\s+$/, ''));
        m.atts.forEach((a, i) => {
          const s = stageAttachment(fid, m.rowid, i, a);
          if (!s) return;
          if (s.kind === 'image' && s.url) lines.push(`![${s.label}](${s.url})`);
          else if (s.kind === 'video' && s.url) lines.push(`\u{1F3AC} [${s.label}](${s.url})`);
          else if (s.kind === 'audio' && s.url) lines.push(`\u{1F50A} [${s.label}](${s.url})`);
          else lines.push(`\u{1F4CE} ${s.label}`);
        });
      }
      messages += msgs.length;
      fs.writeFileSync(file, toMarkdown({
        id: fid, guid: c.guid, name: name.slice(0, 140),
        lines, newestRowid: newest, newestIso: isoTime(msgs[0].date),
      }), 'utf8');
      rewritten++;
    }
    return { chats: chatsSeen, rewritten, skipped, messages, days };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { importMessages };
