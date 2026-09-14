// apple-photos.js — pull recent Apple Photos into the ingest store, with a pick-first flow.
//
// Access is via JXA (osascript -l JavaScript), same as apple-notes.js. Photos' library can
// hold tens of thousands of items, so we NEVER read them all: `whose({date})` filters
// server-side to a recent window (fast only while the result set is small — hence the 48h
// default). Each candidate is exported to its own numbered subdir (one file per dir = an
// unambiguous file→photo-id mapping), thumbnailed with `sips`, and cached. The INGEST view
// shows the thumbnails; the user unticks what they don't want; the chosen ones are captioned
// (vision model) and written into the store. PRIVATE — never promoted to valinor.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { INGEST_DIR, ensureDir, writeCapture, captionImage } = require('./ingest-server');

const CACHE_DIR = path.join(os.tmpdir(), 'hudhub-photos-cache');
const EXP_DIR = path.join(CACHE_DIR, 'exp');
const THUMB_DIR = path.join(CACHE_DIR, 'thumb');
const FULL_DIR = path.join(CACHE_DIR, 'full');
const MANIFEST = path.join(CACHE_DIR, 'manifest.json');

// The token doubles as the eventual capture id, so re-ingesting the same photo is a no-op.
function tokenFor(photoId) {
  return 'photo-' + crypto.createHash('sha1').update(String(photoId)).digest('hex').slice(0, 12);
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

// JXA: filter to the recent window, then — newest first, capped to `max` — export each to
// exp/<k>/. Reading properties off a live whose() collection re-runs the predicate per
// access (very slow), so we materialize the filtered set ONCE with `()` and read id/date
// only for the items we actually keep. (width/height dropped — not worth the per-item cost.)
function scanScript(hours, max) {
  return `
    function run() {
      const P = Application('Photos');
      const fm = $.NSFileManager.defaultManager;
      const cutoff = new Date(Date.now() - ${Number(hours)} * 3600 * 1000);
      let arr;
      try { arr = P.mediaItems.whose({ date: { _greaterThan: cutoff } })(); }
      catch (e) { return JSON.stringify({ error: 'filter: ' + String(e) }); }
      const n = arr.length;
      const base = ${JSON.stringify(EXP_DIR)};
      const items = [];
      for (let i = n - 1; i >= 0 && items.length < ${Number(max)}; i--) {  // newest first
        let name;
        try { name = arr[i].filename() || ''; } catch (e) { continue; }
        if (/\\.(mov|mp4|m4v|avi)$/i.test(name)) continue;  // skip videos
        const k = items.length;
        const dir = base + '/' + k;
        try {
          fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
          P.export([arr[i]], { to: Path(dir), usingOriginals: false });
          items.push({ k: k, id: arr[i].id(), filename: name, date: arr[i].date() });
        } catch (e) { /* skip an item that won't export */ }
      }
      return JSON.stringify({ total: n, exported: items.length, items: items });
    }`;
}

function runJxa(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const s = String(stderr || err.message || err);
        if (/-1743|not authoriz|permission/i.test(s)) {
          reject(new Error('macOS blocked Photos access. Grant permission: System Settings → Privacy & Security → Automation → (your terminal/node) → enable Photos, then retry.'));
        } else if (err.killed || /ETIMEDOUT/i.test(s)) {
          reject(new Error(`Photos read timed out after ${Math.round(timeoutMs / 1000)}s — narrow the window (fewer hours).`));
        } else {
          reject(new Error(s.slice(0, 400)));
        }
        return;
      }
      let data;
      try { data = JSON.parse(String(stdout || 'null')); } catch (e) { reject(new Error('could not parse Photos output')); return; }
      if (data && data.error) { reject(new Error(String(data.error))); return; }
      resolve(data);
    });
  });
}

function sips(src, out, size) {
  return new Promise((resolve) => {
    execFile('sips', ['-Z', String(size), '-s', 'format', 'jpeg', src, '--out', out], { timeout: 20000 }, (err) => resolve(!err));
  });
}

function onlyFileIn(dir) {
  try { const f = fs.readdirSync(dir).filter((x) => !x.startsWith('.')); return f.length ? path.join(dir, f[0]) : null; }
  catch (e) { return null; }
}

// Scan the recent window: export + thumbnail the candidates, return them for the picker.
async function scanRecent({ hours = 48, max = 150 } = {}) {
  ensureDir();
  rmrf(CACHE_DIR);
  mkdir(EXP_DIR); mkdir(THUMB_DIR); mkdir(FULL_DIR);
  // whose() has real per-item overhead in Photos + export cost — be generous.
  const timeoutMs = Math.min(300000, 45000 + Number(max) * 2000);
  const data = await runJxa(scanScript(hours, max), timeoutMs);
  const manifest = {};
  const items = [];
  for (const it of (data.items || [])) {
    const src = onlyFileIn(path.join(EXP_DIR, String(it.k)));
    if (!src) continue;
    const token = tokenFor(it.id);
    const full = path.join(FULL_DIR, `${token}.jpg`);
    const thumb = path.join(THUMB_DIR, `${token}.jpg`);
    try { fs.copyFileSync(src, full); } catch (e) { continue; }
    const ok = await sips(full, thumb, 320);
    if (!ok) { try { fs.copyFileSync(full, thumb); } catch (e) {} } // fallback: serve full as thumb
    manifest[token] = { id: it.id, filename: it.filename, date: it.date, w: it.w, h: it.h, full };
    items.push({
      token,
      filename: it.filename,
      date: it.date,
      w: it.w,
      h: it.h,
      ingested: fs.existsSync(path.join(INGEST_DIR, `${token}.md`)),
      thumb: `/api/ingest/apple-photos/thumb?token=${encodeURIComponent(token)}`,
    });
  }
  rmrf(EXP_DIR); // raw exports no longer needed; keep full/ + thumb/
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest), 'utf8');
  return { hours: Number(hours), total: data.total || 0, exported: items.length, items };
}

function thumbPath(token) {
  const safe = path.basename(String(token || ''));
  const p = path.join(THUMB_DIR, `${safe}.jpg`);
  return fs.existsSync(p) ? p : null;
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return {}; }
}

// Ingest the chosen tokens: caption each (best-effort) and write image + note into the store.
async function ingestSelected({ tokens = [] } = {}, apiKey) {
  ensureDir();
  const manifest = readManifest();
  let ingested = 0, skipped = 0, failed = 0;
  const errors = [];
  for (const token of tokens) {
    const entry = manifest[token];
    if (!entry) { skipped++; continue; }
    const mdFile = path.join(INGEST_DIR, `${token}.md`);
    if (fs.existsSync(mdFile)) { skipped++; continue; } // already ingested
    try {
      const buffer = fs.readFileSync(entry.full);
      const imgName = `${token}.jpg`;
      let cap = { title: '', description: '', tags: [] };
      try {
        cap = await captionImage({ buffer, mime: 'image/jpeg', hint: `Apple Photo "${entry.filename}"` }, apiKey);
      } catch (e) { errors.push(`${entry.filename}: caption failed (${e.message})`); }
      fs.copyFileSync(entry.full, path.join(INGEST_DIR, imgName));
      writeCapture({
        id: token,
        created: entry.date || new Date().toISOString(),
        source: 'photos',
        title: cap.title || entry.filename || 'Photo',
        refined: cap.description || '',
        plan: [],
        nextAction: '',
        raw: `Apple Photos · ${entry.filename}`,
        image: imgName,
        tags: ['ingest', 'photo', ...(cap.tags || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 8),
      });
      ingested++;
    } catch (e) {
      failed++;
      errors.push(`${entry.filename || token}: ${e.message}`);
    }
  }
  return { requested: tokens.length, ingested, skipped, failed, errors };
}

module.exports = { scanRecent, ingestSelected, thumbPath, tokenFor, CACHE_DIR };
