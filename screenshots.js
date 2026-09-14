// screenshots.js — auto-ingest recent Mac screenshots (a plain folder) into the store.
//
// Watches a folder of screenshot files (default ~/Pictures/Pics/Screenshots, override with
// SCREENSHOTS_DIR). New images within the recent window are captioned by the vision model and
// written into the ingest store so the agent can search them. Bounded to a recent window by
// default (SCREENSHOTS_SINCE_HOURS, default 48) so a folder with thousands of old shots does
// NOT get captioned all at once; dedup (by file path) keeps re-runs cheap. PRIVATE — never
// promoted to valinor.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { INGEST_DIR, ensureDir, writeCapture, captionImage } = require('./ingest-server');

const SCREENSHOTS_DIR =
  process.env.SCREENSHOTS_DIR || path.join(os.homedir(), 'Pictures', 'Pics', 'Screenshots');
const DEFAULT_SINCE_HOURS = Number(process.env.SCREENSHOTS_SINCE_HOURS || 48);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
function mimeFor(ext) {
  const e = ext.toLowerCase();
  return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : 'image/jpeg';
}

// Dedup by absolute path — same file never ingested twice.
function captureIdFor(absPath) {
  return 'shot-' + crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 12);
}

// Import recent screenshots. Returns a summary; best-effort captions (falls back to filename).
async function importScreenshots({ sinceHours = DEFAULT_SINCE_HOURS, max = 200 } = {}, apiKey) {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    return { dir: SCREENSHOTS_DIR, missing: true, total: 0, imported: 0, skipped: 0, failed: 0 };
  }
  ensureDir();
  const cutoff = Date.now() - Number(sinceHours) * 3600 * 1000;
  let candidates = [];
  for (const name of fs.readdirSync(SCREENSHOTS_DIR)) {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const abs = path.join(SCREENSHOTS_DIR, name);
    let st;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (!st.isFile() || st.mtimeMs < cutoff) continue;
    candidates.push({ abs, name, ext, mtimeMs: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  candidates = candidates.slice(0, max);

  let imported = 0, skipped = 0, failed = 0;
  const errors = [];
  for (const c of candidates) {
    const id = captureIdFor(c.abs);
    if (fs.existsSync(path.join(INGEST_DIR, `${id}.md`))) { skipped++; continue; }
    try {
      const buffer = fs.readFileSync(c.abs);
      const storedExt = c.ext === '.jpeg' ? '.jpg' : c.ext;
      const imgName = `${id}${storedExt}`;
      let cap = { title: '', description: '', tags: [] };
      try {
        cap = await captionImage({ buffer, mime: mimeFor(c.ext), hint: `Screenshot "${c.name}"` }, apiKey);
      } catch (e) { errors.push(`${c.name}: caption failed (${e.message})`); }
      fs.copyFileSync(c.abs, path.join(INGEST_DIR, imgName));
      writeCapture({
        id,
        created: new Date(c.mtimeMs).toISOString(),
        source: 'screenshot',
        title: cap.title || c.name,
        refined: cap.description || '',
        plan: [],
        nextAction: '',
        raw: `Screenshot · ${c.name}`,
        image: imgName,
        tags: ['ingest', 'screenshot', ...(cap.tags || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 8),
      });
      imported++;
    } catch (e) {
      failed++;
      errors.push(`${c.name}: ${e.message}`);
    }
  }
  return { dir: SCREENSHOTS_DIR, total: candidates.length, imported, skipped, failed, errors };
}

module.exports = { importScreenshots, SCREENSHOTS_DIR };
