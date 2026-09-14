// apple-notes.js — pull Apple Notes (incl. phone notes via iCloud) into the ingest store.
//
// Reads the Mac's Notes app through JXA (osascript -l JavaScript), which mirrors iCloud —
// so a note taken on the iPhone lands here once iCloud has synced it to this Mac. Pull, not
// push: runs on server boot and on demand from the INGEST view's "Sync Apple Notes" button.
// Dedup is by Notes' own note id; a note is re-written only when its modification date moved.
// PRIVATE — these live in ~/Savar/memory/ingest and must NEVER be promoted to valinor.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { INGEST_DIR, ensureDir } = require('./ingest-server');

// Reading note properties one-by-one is ~1 Apple Event per property per note — for a few
// hundred notes that blows past any timeout. So we split the work:
//   1) metaScript: bulk-fetch id/name/dates/folder for ALL notes in one call each (fast).
//   2) bodyScript: fetch body() ONLY for the notes we actually need to (re)write, per note
//      inside a try/catch so one unreadable note (locked, attachment-only) can't abort the
//      batch — the bulk `.body()` array call fails hard on those (-1741).
// Dates serialize to ISO strings automatically via JSON.stringify.
const collExpr = (folder) =>
  folder
    ? `const f = Notes.folders.whose({name: ${JSON.stringify(folder)}})[0]; coll = f.notes;`
    : `coll = Notes.notes;`;

function metaScript(folder) {
  return `
    function run() {
      const Notes = Application('Notes');
      let coll;
      try { ${collExpr(folder)} } catch (e) { return JSON.stringify({ error: String(e) }); }
      let ids, names, created, modified, folders;
      try {
        ids = coll.id(); names = coll.name();
        created = coll.creationDate(); modified = coll.modificationDate();
      } catch (e) { return JSON.stringify({ error: String(e) }); }
      try { folders = coll.container.name(); } catch (e) { folders = ids.map(function(){ return ''; }); }
      const out = [];
      for (let i = 0; i < ids.length; i++) {
        out.push({ id: ids[i], name: names[i], created: created[i], modified: modified[i], folder: folders[i] || '' });
      }
      return JSON.stringify(out);
    }`;
}

// Re-fetch ids inside this call (cheap) so we address notes by id, not by a position that
// may have shifted since metaScript ran.
function bodyScript(folder, wantIds) {
  return `
    function run() {
      const Notes = Application('Notes');
      let coll;
      try { ${collExpr(folder)} } catch (e) { return JSON.stringify({ error: String(e) }); }
      const ids = coll.id();
      const pos = {};
      for (let i = 0; i < ids.length; i++) pos[ids[i]] = i;
      const want = ${JSON.stringify(wantIds)};
      const out = {};
      for (let k = 0; k < want.length; k++) {
        const id = want[k]; const i = pos[id];
        if (i == null) continue;
        try { out[id] = coll[i].body(); } catch (e) { out[id] = ''; }
      }
      return JSON.stringify(out);
    }`;
}

function runJxa(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const s = String(stderr || err.message || err);
          // -1743 / "Not authorized" = macOS Automation permission not granted for Notes.
          if (/-1743|not authoriz|permission/i.test(s)) {
            reject(new Error('macOS blocked Notes access. Grant permission: System Settings → Privacy & Security → Automation → (your terminal/node) → enable Notes, then retry.'));
          } else if (err.killed || /ETIMEDOUT/i.test(s)) {
            reject(new Error(`Notes read timed out after ${Math.round(timeoutMs / 1000)}s — too many notes to pull at once.`));
          } else {
            reject(new Error(s.slice(0, 400)));
          }
          return;
        }
        let data;
        try { data = JSON.parse(String(stdout || 'null')); } catch (e) { reject(new Error('could not parse Notes output')); return; }
        if (data && data.error) { reject(new Error(String(data.error))); return; }
        resolve(data);
      }
    );
  });
}

// Bulk metadata for every note (no bodies). Fast even for thousands of notes.
async function dumpMeta({ folder } = {}, timeoutMs = 60000) {
  const data = await runJxa(metaScript(folder || null), timeoutMs);
  return Array.isArray(data) ? data : [];
}

// Bodies for a specific set of note ids, keyed by id. Fetched in chunks: osascript silently
// fails to marshal a very large return string back over stdout, so one call per ~100 notes
// keeps each payload small. ~26 notes/sec, so scale each chunk's timeout to its size.
const BODY_CHUNK = 100;
async function dumpBodies({ folder } = {}, wantIds = [], timeoutMs) {
  if (!wantIds.length) return {};
  const out = {};
  for (let i = 0; i < wantIds.length; i += BODY_CHUNK) {
    const chunk = wantIds.slice(i, i + BODY_CHUNK);
    const ms = timeoutMs || Math.min(300000, 20000 + chunk.length * 300);
    const data = await runJxa(bodyScript(folder || null, chunk), ms);
    if (data && typeof data === 'object') Object.assign(out, data);
  }
  return out;
}

// Full pull (meta + bodies for everything) — kept for callers/tools that want every note.
async function dumpNotes(opts = {}) {
  const metas = await dumpMeta(opts);
  const bodies = await dumpBodies(opts, metas.map((m) => m.id).filter(Boolean));
  return metas.map((m) => ({ ...m, body: bodies[m.id] || '' }));
}

// Notes bodies are HTML — convert to plain markdown-ish text without external deps.
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<\s*(br|div|p|h[1-6]|li|tr)[^>]*>/gi, '\n');
  s = s.replace(/<\s*li[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCharCode(+d); } catch (e) { return ''; } });
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

function noteFileId(appleId) {
  return 'apple-' + crypto.createHash('sha1').update(String(appleId)).digest('hex').slice(0, 12);
}

function existingModified(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 600);
    const m = /^modified:\s*(.+)$/m.exec(head);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

function toMarkdown(note, id) {
  const title = (note.name || '').trim() || 'Untitled note';
  const body = htmlToText(note.body);
  // Notes usually repeats the title as the first body line — drop it if so.
  const lines = body.split('\n');
  const cleaned = (lines[0] && lines[0].trim() === title) ? lines.slice(1).join('\n').trim() : body;
  const fm = [
    '---',
    `id: ${id}`,
    `created: ${note.created || ''}`,
    `modified: ${note.modified || ''}`,
    'source: apple-notes',
    `folder: ${JSON.stringify(note.folder || '')}`,
    `title: ${JSON.stringify(title)}`,
    `appleId: ${JSON.stringify(note.id || '')}`,
    'tags: [ingest, apple-notes]',
    '---',
    '',
  ].join('\n');
  return `${fm}# ${title}\n\n${cleaned}\n`;
}

// Pull note metadata, figure out which notes are new/changed, fetch bodies only for those,
// and write them into the store. Unchanged notes never cost a body read. Returns a summary.
async function importNotes(opts = {}) {
  ensureDir();
  const metas = await dumpMeta(opts);
  const byId = new Map();
  const wantIds = [];
  for (const m of metas) {
    if (!m || !m.id) continue;
    byId.set(m.id, m);
    const fid = noteFileId(m.id);
    const file = path.join(INGEST_DIR, `${fid}.md`);
    if (fs.existsSync(file) && existingModified(file) === String(m.modified || '')) continue; // unchanged
    wantIds.push(m.id);
  }
  const bodies = await dumpBodies(opts, wantIds);
  let imported = 0, updated = 0;
  for (const appleId of wantIds) {
    const m = byId.get(appleId);
    const fid = noteFileId(appleId);
    const file = path.join(INGEST_DIR, `${fid}.md`);
    const exists = fs.existsSync(file);
    fs.writeFileSync(file, toMarkdown({ ...m, id: appleId, body: bodies[appleId] || '' }, fid), 'utf8');
    if (exists) updated++; else imported++;
  }
  return { total: metas.length, imported, updated, skipped: metas.length - wantIds.length };
}

module.exports = { importNotes, dumpNotes, dumpMeta, dumpBodies };
