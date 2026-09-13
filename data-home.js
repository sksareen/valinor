// data-home.js — user-data separation for every server-side store.
//
// Resolution order (the standing rule — see README "User data & updating"):
//   1. explicit per-store env var (e.g. REHEARSE_SESSION_PATH) when set;
//   2. the repo-local file, when it already exists (backward compat — existing
//      installs keep working exactly where their data already is);
//   3. VALINOR_DATA_DIR (or ~/.valinor/) for all NEW writes — fresh installs
//      never write state into the repo, so `git pull` can never touch user data.
//
// Resolution is computed fresh on every call (no module-level caching): server.js
// loads .env AFTER requires run, so a cached-at-require path would miss .env vars.
// Callers that need a stable path within a process (session stores) must cache the
// resolved value themselves, lazily on first use (never at require time).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;

/** User data home for new writes. Outside the repo by design. */
function dataDir() {
  const env = String(process.env.VALINOR_DATA_DIR || '').trim();
  return env || path.join(os.homedir(), '.valinor');
}

function ensureParent(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ok */ }
}

/**
 * Resolve a store FILE path.
 * @param {string} envName  per-store env var holding an explicit path
 * @param {string} name     file name under the data home for new writes
 * @param {string[]} legacy repo-local file names that win when already present
 */
function resolveStore({ env, name, legacy = [] }) {
  if (env) {
    const v = String(process.env[env] || '').trim();
    if (v) return v;
  }
  for (const l of legacy) {
    try {
      const p = path.isAbsolute(l) ? l : path.join(ROOT, l);
      if (fs.existsSync(p)) return p;
    } catch { /* try next */ }
  }
  const p = path.join(dataDir(), name);
  ensureParent(p);
  return p;
}

/**
 * Resolve a store DIRECTORY path (same order; the winning dir is created).
 * @param {string} envName  per-store env var holding an explicit dir
 * @param {string} name     dir name under the data home for new writes
 * @param {string[]} legacy repo-local dir names that win when already present
 */
function resolveDir({ env, name, legacy = [] }) {
  if (env) {
    const v = String(process.env[env] || '').trim();
    if (v) {
      try { fs.mkdirSync(v, { recursive: true }); } catch { /* ok */ }
      return v;
    }
  }
  for (const l of legacy) {
    try {
      const p = path.isAbsolute(l) ? l : path.join(ROOT, l);
      if (fs.existsSync(p)) return p;
    } catch { /* try next */ }
  }
  const p = path.join(dataDir(), name);
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* ok */ }
  return p;
}

// ---------------------------------------------------------------------------
// Board notes: the one migrated store. Runtime state lives in `board-notes.json`
// (gitignored, data-home aware); the legacy tracked `notes.json` is imported once
// when present and never written again.
// ---------------------------------------------------------------------------
function boardNotesPath() {
  return resolveStore({ env: 'BOARD_NOTES_PATH', name: 'board-notes.json', legacy: ['board-notes.json'] });
}

function legacyNotesPath() {
  return path.join(ROOT, 'notes.json');
}

/**
 * Read board notes: data-home/board file first, legacy tracked notes.json after.
 * On first read, when only the legacy file exists, its content is imported into
 * the new location (copy-based, never destructive — the legacy file is untouched).
 * Returns { notes, imported } — notes is always an array.
 */
function readBoardNotes() {
  const primary = boardNotesPath();
  try {
    const raw = JSON.parse(fs.readFileSync(primary, 'utf8'));
    if (Array.isArray(raw)) return { notes: raw, imported: false };
  } catch { /* missing or unreadable — try legacy */ }
  try {
    const raw = JSON.parse(fs.readFileSync(legacyNotesPath(), 'utf8'));
    if (Array.isArray(raw)) {
      try {
        ensureParent(primary);
        fs.writeFileSync(primary, JSON.stringify(raw, null, 2));
        console.log(`[data-home] imported legacy notes.json (${raw.length} notes) → ${primary}`);
        return { notes: raw, imported: true };
      } catch (e) {
        console.warn('[data-home] legacy notes import failed:', String(e.message || e));
        return { notes: raw, imported: false };
      }
    }
  } catch { /* no legacy content */ }
  return { notes: [], imported: false };
}

function writeBoardNotes(notes) {
  const p = boardNotesPath();
  ensureParent(p);
  fs.writeFileSync(p, JSON.stringify(notes, null, 2));
  return p;
}

module.exports = {
  ROOT,
  dataDir,
  resolveStore,
  resolveDir,
  boardNotesPath,
  legacyNotesPath,
  readBoardNotes,
  writeBoardNotes,
};
