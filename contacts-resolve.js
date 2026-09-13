// contacts-resolve.js — map phone numbers / emails to Contact names.
// Reads the macOS Contacts sqlite stores (passive file copy, no permission prompts).
// Never throws: on any failure returns empty maps and callers fall back to raw handles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCES_DIR = path.join(os.homedir(), 'Library/Application Support/AddressBook/Sources');

let cache = null; // { mtime, phones: Map, emails: Map }

function normPhone(h) {
  const d = String(h || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d[0] === '1') return d.slice(1); // US country code
  return d;
}

function displayName(r) {
  const first = (r.first || '').trim(), last = (r.last || '').trim();
  const full = [first, last].filter(Boolean).join(' ');
  return full || (r.org || '').trim() || (r.nick || '').trim() || '';
}

function sqlite(db, sql) {
  const out = execFileSync('sqlite3', ['-json', db, sql], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out.toString() || '[]');
}

function loadContactMaps() {
  try {
    const dbs = fs.readdirSync(SOURCES_DIR)
      .map(n => path.join(SOURCES_DIR, n, 'AddressBook-v22.abcddb'))
      .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (!dbs.length) return { phones: new Map(), emails: new Map() };
    const mtime = Math.max(...dbs.map(p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }));
    if (cache && cache.mtime >= mtime) return cache;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'));
    const phones = new Map(), emails = new Map();
    for (const db of dbs) {
      const dst = path.join(tmp, 'ab.db');
      try {
        fs.copyFileSync(db, dst);
        for (const ext of ['-wal', '-shm']) { try { fs.copyFileSync(db + ext, dst + ext); } catch {} }
        // collect raw rows first — owner ids are local to THIS db, so resolve names before merging
        const phoneRows = sqlite(dst, 'SELECT ZOWNER AS o, ZFULLNUMBER AS n FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL');
        const emailRows = sqlite(dst, 'SELECT ZOWNER AS o, ZADDRESSNORMALIZED AS a, ZADDRESS AS b FROM ZABCDEMAILADDRESS');
        const owners = new Set([...phoneRows.map(r => r.o), ...emailRows.map(r => r.o)].filter(v => typeof v === 'number'));
        const names = new Map();
        if (owners.size) {
          const recs = sqlite(dst, `SELECT Z_PK AS id, ZFIRSTNAME AS first, ZLASTNAME AS last, ZORGANIZATION AS org, ZNICKNAME AS nick FROM ZABCDRECORD WHERE Z_PK IN (${[...owners].join(',')})`);
          for (const r of recs) { const n = displayName(r); if (n) names.set(r.id, n); }
        }
        for (const row of phoneRows) {
          const d = normPhone(row.n), n = names.get(row.o);
          if (d && n && !phones.has(d)) phones.set(d, n);
        }
        for (const row of emailRows) {
          const a = String(row.a || row.b || '').trim().toLowerCase(), n = names.get(row.o);
          if (a && n && !emails.has(a)) emails.set(a, n);
        }
      } catch { /* skip unreadable store */ }
      finally { for (const f of [dst, dst + '-wal', dst + '-shm']) { try { fs.unlinkSync(f); } catch {} } }
    }
    try { fs.rmdirSync(tmp); } catch {}
    cache = { mtime, phones, emails };
    return cache;
  } catch {
    return { phones: new Map(), emails: new Map() };
  }
}

// Resolve an iMessage handle (+1510…, person@x.com) to a display name, or '' if unknown.
function resolveHandle(handle, maps) {
  const h = String(handle || '');
  if (!h) return '';
  if (h.includes('@')) return maps.emails.get(h.toLowerCase()) || '';
  const d = normPhone(h);
  if (!d) return '';
  return maps.phones.get(d) || '';
}

module.exports = { loadContactMaps, resolveHandle, normPhone };
