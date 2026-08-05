// network-data.js — read-only bridge into the personal network CRM (network.db) and
// macOS iMessage history (chat.db). Never writes to either database. Zero npm deps —
// uses Node's built-in node:sqlite (Node 22+).
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Overridable via env — no machine-specific defaults.
function networkDbPath() {
  return process.env.NETWORK_DB_PATH || '';
}
function chatDbPath() {
  return process.env.CHAT_DB_PATH || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
}

// last-10-digits normalization, matching phone numbers stored in wildly different
// formats ("+1 646-290-0927" vs "16462900927") between network.db and chat.db.
const digits10 = (col) => `substr(replace(replace(replace(replace(replace(${col},'+',''),'-',''),' ',''),'(',''),')',''), -10)`;

let _db = null;
let _chatAttached = null; // null = not tried yet, true/false = cached result

// crm.json holds handviz-specific overlay data recovered from people/*.md and macOS
// Contacts (see backfill-crm.js) — emails, phone numbers, and "Next Step" the SQLite
// migration dropped, plus meeting-note bodies. Re-read on every call (cheap, small file)
// so a re-run of the backfill script or a manual edit takes effect without restarting
// the server.
function loadCrmFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'crm.json'), 'utf8'));
  } catch {
    return {};
  }
}
function crmOverlay(crm, id) {
  return crm[id] || null;
}
// A contact's phone may live in network.db OR be recovered into crm.json from Contacts —
// this is the single place that decides which one wins (DB always takes priority).
function effectivePhone(dbPhone, overlay) {
  if (dbPhone && dbPhone.trim()) return dbPhone;
  return overlay?.phone || null;
}

function getDb() {
  if (_db) return _db;
  const p = networkDbPath();
  if (!p) {
    throw new Error('NETWORK_DB_PATH is unset — messages/CRM stay empty until you point it at a network.db');
  }
  if (!fs.existsSync(p)) {
    throw new Error('NETWORK_DB_PATH not found: ' + p);
  }
  _db = new DatabaseSync(p, { readOnly: true });
  return _db;
}

// Attaches chat.db once per process. Reading it requires Full Disk Access for whatever
// process runs `node server.js` — if that isn't granted (or the file simply isn't there),
// this fails once, is cached, and every caller below degrades to CRM-only data instead
// of throwing on every request.
function chatAvailable() {
  if (_chatAttached !== null) return _chatAttached;
  const db = getDb();
  try {
    db.prepare('ATTACH DATABASE ? AS im').run(chatDbPath());
    db.prepare('SELECT count(*) AS n FROM im.message LIMIT 1').get();
    _chatAttached = true;
  } catch (e) {
    _chatAttached = false;
    console.warn('[network-data] chat.db unavailable — recency/thread context disabled:', e.message);
  }
  return _chatAttached;
}

// ---- attributedBody decoder ----
// Modern macOS leaves message.text NULL for most rows; the actual text lives inside an
// NSAttributedString archived in Apple's old "typedstream" (NSArchiver) format — the blob
// starts with the literal magic "streamtyped". The message text sits behind an "NSString"
// class marker, then 1-4 bookkeeping bytes (object/class-reference markers whose count
// varies with message complexity — reactions, replies, group threads add more), then a
// 0x2b ("+", counted-string-follows) byte, then a length byte (or 0x81/0x82 prefix for
// 16/32-bit lengths), then the raw UTF-8 bytes. Verified against real chat.db data.
function decodeAttributedBody(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const marker = Buffer.from('NSString');
  const i = buf.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  // scan a short window for the "+" that precedes the counted string, rather than
  // assuming a fixed number of bookkeeping bytes
  const scanLimit = Math.min(buf.length, start + 12);
  let plus = -1;
  for (let j = start; j < scanLimit; j++) {
    if (buf[j] === 0x2b) { plus = j; break; }
  }
  if (plus < 0) return null;
  let p = plus + 1;
  let len = buf[p++];
  if (len === 0x81) {
    if (p + 2 > buf.length) return null;
    len = buf.readUInt16LE(p); p += 2;
  } else if (len === 0x82) {
    if (p + 4 > buf.length) return null;
    len = buf.readUInt32LE(p); p += 4;
  }
  if (len <= 0 || p + len > buf.length) return null;
  try {
    const text = buf.slice(p, p + len).toString('utf8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

function messageText(row) {
  if (row.text && row.text.trim()) return row.text.trim();
  return decodeAttributedBody(row.attributedBody);
}

// Mac absolute time is nanoseconds (modern) or seconds (pre-Sierra) since 2001-01-01.
const MAC_EPOCH_OFFSET_S = 978307200;
function macDateToMs(macDate) {
  if (macDate == null) return null;
  const n = Number(macDate);
  if (!n) return null;
  const seconds = n > 1e12 ? n / 1e9 : n;
  return (seconds + MAC_EPOCH_OFFSET_S) * 1000;
}
function daysSince(ms) {
  if (ms == null) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function truthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toUpperCase();
  return s !== '' && s !== 'FALSE' && s !== '0';
}

// JS twin of the digits10 SQL expression above — same character set removed, same last-10
// slice, so a phone normalized here always lands on the key chat.db grouped it under.
function digits10Js(s) {
  return String(s || '').replace(/[+\-\s()]/g, '').slice(-10);
}

// Synthetic ids for people who live in Contacts + chat.db but not network.db.
// Negative so they never collide with CRM rowids. Reversible: digits10 <-> -Number(digits10).
function contactsIdFromDigits(d10) {
  const n = Number(d10);
  return Number.isFinite(n) && n > 0 ? -n : null;
}
function digitsFromContactsId(id) {
  if (id == null || id >= 0) return null;
  return String(-id);
}

// ---- bulk warmth: one aggregate pass over chat.db, per-handle ----
// Per-contact recency queries are fine for one contact, but answering "who should I ask?"
// needs recency for all 185 at once. This is a single grouped scan (~160k messages, ~100ms)
// cached briefly, rather than 185 separate queries.
const WARMTH_TTL_MS = 60000;
let _warmthCache = null; // { at, map: Map<digits10, { n, lastMs }> }

function warmthMap() {
  if (_warmthCache && Date.now() - _warmthCache.at < WARMTH_TTL_MS) return _warmthCache.map;
  const map = new Map();
  if (chatAvailable()) {
    try {
      const stmt = getDb().prepare(`
        SELECT ${digits10('h.id')} AS d10, count(*) AS n, max(m.date) AS last_date
        FROM im.message m JOIN im.handle h ON m.handle_id = h.ROWID
        GROUP BY d10
      `);
      stmt.setReadBigInts(true);
      for (const r of stmt.all()) {
        if (!r.d10) continue;
        map.set(String(r.d10), { n: Number(r.n), lastMs: macDateToMs(r.last_date) });
      }
    } catch (e) {
      console.warn('[network-data] warmth aggregate failed:', e.message);
    }
  }
  _warmthCache = { at: Date.now(), map };
  return map;
}

// ---- Contacts × iMessage people who aren't in the curated CRM ----
// network.db is a hand-curated 185 people. The people you actually text every day
// (girlfriend, family, close friends) often never got a markdown note, so they were
// invisible to the Messages tab. Pull them from macOS Contacts, keep only those with
// real chat history, skip anyone already covered by a CRM phone.
function findContactsDbs() {
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');
  const found = [];
  const top = path.join(base, 'AddressBook-v22.abcddb');
  if (fs.existsSync(top)) found.push(top);
  const sourcesDir = path.join(base, 'Sources');
  if (fs.existsSync(sourcesDir)) {
    for (const entry of fs.readdirSync(sourcesDir)) {
      const p = path.join(sourcesDir, entry, 'AddressBook-v22.abcddb');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return found;
}

const CONTACTS_TTL_MS = 60000;
let _contactsCache = null; // { at, byDigits: Map<d10, { name, phone }> }

function contactsByDigits() {
  if (_contactsCache && Date.now() - _contactsCache.at < CONTACTS_TTL_MS) return _contactsCache.byDigits;
  const byDigits = new Map();
  for (const dbPath of findContactsDbs()) {
    let cdb;
    try { cdb = new DatabaseSync(dbPath, { readOnly: true }); } catch { continue; }
    let rows;
    try {
      rows = cdb.prepare(`
        SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, p.ZFULLNUMBER AS phone
        FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
        WHERE p.ZFULLNUMBER IS NOT NULL
        ORDER BY p.ZISPRIMARY DESC, p.ZORDERINGINDEX ASC
      `).all();
    } catch { continue; }
    for (const r of rows) {
      const name = [r.first, r.last].filter(Boolean).join(' ').trim();
      if (!name) continue;
      const d10 = digits10Js(r.phone);
      if (d10.length < 7) continue;
      if (!byDigits.has(d10)) byDigits.set(d10, { name, phone: r.phone });
    }
  }
  _contactsCache = { at: Date.now(), byDigits };
  return byDigits;
}

// Phones already claimed by a CRM person (db or crm.json overlay) — don't double-list them.
function crmPhoneDigits() {
  const db = getDb();
  const crm = loadCrmFile();
  const set = new Set();
  for (const r of db.prepare('SELECT id, phone FROM people').all()) {
    const phone = effectivePhone(r.phone, crmOverlay(crm, r.id));
    if (phone) set.add(digits10Js(phone));
  }
  return set;
}

function getMessageOnlyPeople() {
  const warmth = warmthMap();
  const contacts = contactsByDigits();
  const claimed = crmPhoneDigits();
  const out = [];
  for (const [d10, w] of warmth) {
    if (!w.n || claimed.has(d10)) continue;
    const c = contacts.get(d10);
    if (!c) continue; // chat handle with no Contacts name — can't show a useful row
    const id = contactsIdFromDigits(d10);
    if (id == null) continue;
    out.push({
      id,
      name: c.name,
      phone: c.phone,
      company: null,
      role: null,
      school: null,
      oneLiner: null,
      notesBrief: null,
      tags: ['imessage'],
      boardPriority: false,
      hasPhone: true,
      daysSince: daysSince(w.lastMs),
      msgCount: w.n,
      fromContacts: true,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

// Resolve CRM or Contacts-sourced person to a phone + display name.
function resolvePerson(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  if (n < 0) {
    const d10 = digitsFromContactsId(n);
    const c = contactsByDigits().get(d10);
    if (!c) return null;
    return { id: n, name: c.name, phone: c.phone, fromContacts: true };
  }
  const p = getDb().prepare('SELECT id, name, phone FROM people WHERE id = ?').get(n);
  if (!p) return null;
  const phone = effectivePhone(p.phone, crmOverlay(loadCrmFile(), p.id));
  return { id: p.id, name: p.name, phone, fromContacts: false };
}

// ---- roster: the full pickable contact list ----
const PERSON_JOIN_FIELDS = `
  (SELECT group_concat(tag, ', ') FROM tags WHERE person_id = p.id) AS tags,
  (SELECT c.name FROM person_companies pc JOIN companies c ON c.id = pc.company_id
     WHERE pc.person_id = p.id AND pc.is_current = 1 ORDER BY pc.start_date DESC LIMIT 1) AS current_company,
  (SELECT pc.role FROM person_companies pc
     WHERE pc.person_id = p.id AND pc.is_current = 1 ORDER BY pc.start_date DESC LIMIT 1) AS current_role,
  (SELECT s.name FROM person_schools ps JOIN schools s ON s.id = ps.school_id
     WHERE ps.person_id = p.id LIMIT 1) AS school_name
`;

function getRoster() {
  const db = getDb();
  const crm = loadCrmFile();
  const rows = db.prepare(`
    SELECT p.id, p.name, p.company, p.role, p.school, p.one_liner, p.phone,
           ${PERSON_JOIN_FIELDS}
    FROM people p
    ORDER BY p.name COLLATE NOCASE
  `).all();
  const crmRows = rows.map((r) => ({
    id: r.id,
    name: r.name,
    company: r.current_company || r.company || null,
    role: r.current_role || r.role || null,
    school: r.school_name || r.school || null,
    oneLiner: r.one_liner || null,
    tags: r.tags ? r.tags.split(', ').filter(Boolean) : [],
    hasPhone: !!effectivePhone(r.phone, crmOverlay(crm, r.id)),
    msgCount: null,
    fromContacts: false,
  }));
  // People you text a lot who never made it into the curated CRM.
  const extras = getMessageOnlyPeople().map((p) => ({
    id: p.id,
    name: p.name,
    company: p.msgCount ? `${p.msgCount.toLocaleString()} msgs` : 'iMessage',
    role: null,
    school: null,
    oneLiner: null,
    tags: p.tags,
    hasPhone: true,
    msgCount: p.msgCount,
    fromContacts: true,
  }));
  return [...crmRows, ...extras];
}

// ---- recipient matching: a compact, LLM-ready view of the entire roster ----
// Answers "who in my network should I ask about this?" — so it carries everything that
// makes someone a good or bad fit for an ask: what they do, how you know them (tags),
// whatever you wrote down about them, and whether you can actually reach them warmly.
const NOTES_BRIEF_CAP = 220; // enough to convey what someone's about, cheap enough x185

function getRosterForMatching() {
  const db = getDb();
  const crm = loadCrmFile();
  const warmth = warmthMap();
  const rows = db.prepare(`
    SELECT p.id, p.name, p.company, p.role, p.school, p.one_liner, p.notes, p.phone, p.board_priority,
           ${PERSON_JOIN_FIELDS}
    FROM people p
    ORDER BY p.name COLLATE NOCASE
  `).all();
  const crmRows = rows.map((r) => {
    const overlay = crmOverlay(crm, r.id);
    const phone = effectivePhone(r.phone, overlay);
    const w = phone ? warmth.get(digits10Js(phone)) : null;
    const notesSource = r.notes || overlay?.notesExtract || null;
    return {
      id: r.id,
      name: r.name,
      company: r.current_company || r.company || null,
      role: r.current_role || r.role || null,
      school: r.school_name || r.school || null,
      oneLiner: r.one_liner || null,
      notesBrief: notesSource ? String(notesSource).replace(/\s+/g, ' ').trim().slice(0, NOTES_BRIEF_CAP) : null,
      tags: r.tags ? r.tags.split(', ').filter(Boolean) : [],
      boardPriority: truthy(r.board_priority),
      hasPhone: !!phone,
      daysSince: w ? daysSince(w.lastMs) : null,
      msgCount: w ? w.n : (phone ? 0 : null),
    };
  });
  // Cap message-only extras in the matcher prompt — top by volume, not all 500.
  // Full roster is still searchable in the sidebar; the LLM just doesn't need every distant aunt.
  const extras = getMessageOnlyPeople()
    .filter((p) => p.msgCount >= 50)
    .sort((a, b) => b.msgCount - a.msgCount)
    .slice(0, 80)
    .map((p) => ({
      id: p.id,
      name: p.name,
      company: null,
      role: null,
      school: null,
      oneLiner: null,
      notesBrief: `Heavy iMessage contact — ${p.msgCount} messages on file. Not in curated CRM.`,
      tags: p.tags,
      boardPriority: false,
      hasPhone: true,
      daysSince: p.daysSince,
      msgCount: p.msgCount,
    }));
  return [...crmRows, ...extras];
}

// ---- context bundle for one contact ----
function attachThread(context, phone) {
  if (!phone) return context;
  if (!chatAvailable()) { context.chatUnavailable = true; return context; }
  try {
    const db = getDb();
    const summaryStmt = db.prepare(`
      SELECT count(*) AS n, max(m.date) AS last_date
      FROM im.message m JOIN im.handle h ON m.handle_id = h.ROWID
      WHERE ${digits10('h.id')} = ${digits10('?')}
    `);
    summaryStmt.setReadBigInts(true);
    const summary = summaryStmt.get(phone);
    context.msgCount = summary?.n ? Number(summary.n) : 0;
    context.daysSince = daysSince(macDateToMs(summary?.last_date));

    if (context.msgCount > 0) {
      const threadStmt = db.prepare(`
        SELECT m.is_from_me, m.date, m.text, m.attributedBody
        FROM im.message m JOIN im.handle h ON m.handle_id = h.ROWID
        WHERE ${digits10('h.id')} = ${digits10('?')}
        ORDER BY m.date DESC LIMIT 8
      `);
      threadStmt.setReadBigInts(true);
      const rows = threadStmt.all(phone);
      context.thread = rows
        .map((r) => ({ fromMe: !!r.is_from_me, date: macDateToMs(r.date), text: messageText(r) }))
        .filter((m) => m.text)
        .reverse();
    }
  } catch (e) {
    console.warn('[network-data] chat.db query failed:', e.message);
    context.chatUnavailable = true;
  }
  return context;
}

function getContext(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;

  // Contacts-only person (not in network.db) — still get full thread + voice matching.
  if (n < 0) {
    const person = resolvePerson(n);
    if (!person) return null;
    const context = {
      id: person.id,
      name: person.name,
      company: null,
      role: null,
      school: null,
      oneLiner: null,
      notes: null,
      location: null,
      linkedin: null,
      email: null,
      boardPriority: false,
      tags: ['imessage'],
      hasPhone: !!person.phone,
      daysSince: null,
      msgCount: null,
      thread: null,
      chatUnavailable: false,
      fromContacts: true,
    };
    return attachThread(context, person.phone);
  }

  const db = getDb();
  const p = db.prepare(`
    SELECT p.*, ${PERSON_JOIN_FIELDS}
    FROM people p WHERE p.id = ?
  `).get(n);
  if (!p) return null;

  const crm = loadCrmFile();
  const overlay = crmOverlay(crm, p.id);
  const notesParts = [p.notes].filter(Boolean);
  if (overlay?.nextStep) notesParts.push(`Next step: ${overlay.nextStep}`);
  if (overlay?.notesExtract) notesParts.push(overlay.notesExtract);
  const phone = effectivePhone(p.phone, overlay);

  const context = {
    id: p.id,
    name: p.name,
    company: p.current_company || p.company || null,
    role: p.current_role || p.role || null,
    school: p.school_name || p.school || null,
    oneLiner: p.one_liner || null,
    notes: notesParts.join('\n\n') || null,
    location: p.location || p.current_city || null,
    linkedin: p.linkedin || null,
    email: p.email || overlay?.email || null,
    boardPriority: truthy(p.board_priority),
    tags: p.tags ? p.tags.split(', ').filter(Boolean) : [],
    hasPhone: !!phone,
    daysSince: null,
    msgCount: null,
    thread: null,
    chatUnavailable: false,
  };

  if (!context.hasPhone) return context;
  return attachThread(context, phone);
}

// ---- voice matching: the user's own sent messages to a contact, for few-shot style ----
function getSentMessages(id, limit = 40) {
  const person = resolvePerson(id);
  const phone = person?.phone || null;
  if (!phone || !chatAvailable()) return [];
  try {
    const stmt = getDb().prepare(`
      SELECT m.date, m.text, m.attributedBody
      FROM im.message m JOIN im.handle h ON m.handle_id = h.ROWID
      WHERE m.is_from_me = 1 AND ${digits10('h.id')} = ${digits10('?')}
      ORDER BY m.date DESC LIMIT ?
    `);
    stmt.setReadBigInts(true);
    const rows = stmt.all(phone, limit);
    return rows
      .map((r) => messageText(r))
      .filter((t) => t && t.length > 2 && t.length < 400 && !/^https?:\/\//i.test(t))
      .slice(0, limit);
  } catch (e) {
    console.warn('[network-data] sent-messages query failed:', e.message);
    return [];
  }
}

// Finds the first message the user actually sent to this contact shortly after they
// copied a draft — used to close the loop between "what we drafted" and "what was sent".
function findSentAfter(id, afterMs, windowMinutes = 60) {
  const person = resolvePerson(id);
  const phone = person?.phone || null;
  if (!phone || !chatAvailable()) return null;
  const afterMac = (afterMs / 1000) - MAC_EPOCH_OFFSET_S;
  const beforeMac = afterMac + windowMinutes * 60;
  try {
    const stmt = getDb().prepare(`
      SELECT m.date, m.text, m.attributedBody
      FROM im.message m JOIN im.handle h ON m.handle_id = h.ROWID
      WHERE m.is_from_me = 1 AND ${digits10('h.id')} = ${digits10('?')}
        AND (m.date BETWEEN ? * 1000000000 AND ? * 1000000000)
      ORDER BY m.date ASC LIMIT 1
    `);
    stmt.setReadBigInts(true);
    const rows = stmt.all(phone, afterMac, beforeMac);
    if (!rows.length) return null;
    const text = messageText(rows[0]);
    if (!text) return null;
    return { text, sentAt: macDateToMs(rows[0].date) };
  } catch (e) {
    console.warn('[network-data] findSentAfter query failed:', e.message);
    return null;
  }
}

// ---- events + attendees, for event-aware batch drafting ----
function getEvents() {
  const db = getDb();
  const events = db.prepare('SELECT id, name, location, start_date, end_date, description FROM events ORDER BY start_date DESC').all();
  const attendees = db.prepare(`
    SELECT ea.event_id, p.id AS person_id, p.name, ea.role, ea.notes
    FROM event_attendees ea JOIN people p ON p.id = ea.person_id
  `).all();
  const byEvent = new Map();
  for (const a of attendees) {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, []);
    byEvent.get(a.event_id).push({ id: a.person_id, name: a.name, role: a.role || null, notes: a.notes || null });
  }
  return events.map((e) => ({ ...e, attendees: byEvent.get(e.id) || [] }));
}

module.exports = {
  getRoster,
  getRosterForMatching,
  getContext,
  getSentMessages,
  findSentAfter,
  getEvents,
  decodeAttributedBody, // exported for the backfill script / debugging
};
