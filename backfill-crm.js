#!/usr/bin/env node
// backfill-crm.js — one-time recovery script (Phase 2 of the messaging plan).
//
// The move from Obsidian markdown notes to network.db dropped every email address and
// "Next Step" field, and left the substantial meeting-note bodies behind entirely. This
// script matches people/*.md files to network.db people by name and writes the recovered
// fields into crm.json, which handviz's context API layers on top of the DB read-only.
//
// It also does a second recovery pass against macOS Contacts (the real source of phone
// numbers on this machine) for the 92 people network.db has no phone for — without a phone,
// a contact can never be joined against chat.db, so they never get recency/thread context
// or show up as a voice-matching source, no matter how much CRM data they have.
//
// Safe to re-run: it always rebuilds crm.json from the current markdown + DB + Contacts
// state, so it never accumulates stale data. Run manually — not part of the server's
// request path, and never writes back to network.db or Contacts itself (both read-only).
//
//   node backfill-crm.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const NETWORK_DB = process.env.NETWORK_DB_PATH || '';
const PEOPLE_DIR = process.env.NETWORK_PEOPLE_DIR || '';
const CRM_FILE = require('./data-home').resolveStore({ env: 'CRM_PATH', name: 'crm.json', legacy: ['crm.json'] });
const NOTES_CHAR_CAP = 2000; // meeting notes can run to 100+ lines; keep the prompt cheap

if (!NETWORK_DB || !PEOPLE_DIR) {
  console.error('Set NETWORK_DB_PATH and NETWORK_PEOPLE_DIR (see .env.example). No machine defaults.');
  process.exit(1);
}
if (!fs.existsSync(NETWORK_DB)) {
  console.error('NETWORK_DB_PATH not found:', NETWORK_DB);
  process.exit(1);
}
if (!fs.existsSync(PEOPLE_DIR)) {
  console.error('NETWORK_PEOPLE_DIR not found:', PEOPLE_DIR);
  process.exit(1);
}

// macOS Contacts stores each account's data in its own Core Data SQLite file under
// Sources/<account-uuid>/ — enumerate all of them rather than hardcoding a UUID that will
// differ per machine (and can change if iCloud re-syncs).
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

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fields: {}, body: text.trim() };
  const [, fm, body] = m;
  const fields = {};
  for (const line of fm.split('\n')) {
    if (/^\s/.test(line) || line.trim().startsWith('-')) continue; // array continuation lines
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (val) fields[key] = val;
  }
  return { fields, body: body.trim() };
}

function stripWikilinks(text) {
  // leading "[[Connector]]" lines are graph hub links, not notes — drop them, keep the rest
  return text.split('\n').filter((l) => !/^\s*\[\[.*\]\]\s*$/.test(l)).join('\n').trim();
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function main() {
  if (!fs.existsSync(PEOPLE_DIR)) {
    console.error(`people directory not found: ${PEOPLE_DIR}`);
    process.exit(1);
  }
  const db = new DatabaseSync(NETWORK_DB, { readOnly: true });
  const people = db.prepare('SELECT id, name, email, notes, phone FROM people').all();
  const byNormName = new Map(people.map((p) => [normalizeName(p.name), p]));

  const files = fs.readdirSync(PEOPLE_DIR).filter((f) => f.endsWith('.md'));
  const crm = {};
  let matched = 0, emails = 0, nextSteps = 0, notesRecovered = 0;

  for (const file of files) {
    const full = path.join(PEOPLE_DIR, file);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const { fields, body } = parseFrontmatter(text);

    const given = fields['Given Name'] || '';
    const family = fields['Family Name'] || '';
    const constructedName = [given, family].filter(Boolean).join(' ').trim();
    const filenameName = path.basename(file, '.md');
    const candidates = [constructedName, filenameName].filter(Boolean);

    let person = null;
    for (const c of candidates) {
      person = byNormName.get(normalizeName(c));
      if (person) break;
    }
    if (!person) continue;
    matched++;

    const email = fields['E-mail 1 - Value'] || fields['E-mail 2 - Value'] || null;
    const nextStep = fields['Next Step'] && fields['Next Step'] !== 'Say Hi!' ? fields['Next Step'] : (fields['Next Step'] || null);
    const cleanedBody = stripWikilinks(body);
    const notesExtract = cleanedBody && cleanedBody.length > 20 ? cleanedBody.slice(0, NOTES_CHAR_CAP) : null;

    const entry = crm[person.id] || {};
    // only recover what the DB is actually missing — never overwrite a real DB value
    if (email && !person.email) { entry.email = email; emails++; }
    if (nextStep) { entry.nextStep = nextStep; nextSteps++; }
    if (notesExtract) { entry.notesExtract = notesExtract; notesRecovered++; }
    if (Object.keys(entry).length) crm[person.id] = entry;
  }
  console.log(`Matched ${matched}/${files.length} markdown files to network.db people.`);
  console.log(`Recovered from markdown: ${emails} emails, ${nextSteps} Next Steps, ${notesRecovered} meeting-note extracts.`);

  // ---- pass 2: recover phone numbers from macOS Contacts ----
  const needPhone = people.filter((p) => !p.phone || !p.phone.trim());
  const dbs = findContactsDbs();
  if (!dbs.length) {
    console.log('No macOS Contacts database found — skipping phone recovery.');
  } else {
    const byNormNameNeedingPhone = new Map(needPhone.map((p) => [normalizeName(p.name), p]));
    const phonesByName = new Map(); // normalized name -> first phone found (primary preferred)
    for (const dbPath of dbs) {
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
      } catch (e) {
        console.warn(`Skipping unreadable Contacts db ${dbPath}: ${e.message}`);
        continue;
      }
      for (const r of rows) {
        const full = [r.first, r.last].filter(Boolean).join(' ').trim();
        if (!full) continue;
        const norm = normalizeName(full);
        if (!byNormNameNeedingPhone.has(norm) || phonesByName.has(norm)) continue; // first (primary) wins
        phonesByName.set(norm, r.phone);
      }
    }
    let phones = 0;
    for (const [norm, phone] of phonesByName) {
      const person = byNormNameNeedingPhone.get(norm);
      const entry = crm[person.id] || {};
      entry.phone = phone;
      crm[person.id] = entry;
      phones++;
    }
    console.log(`Matched ${dbs.length} Contacts source(s); recovered ${phones}/${needPhone.length} missing phone numbers.`);
  }

  fs.writeFileSync(CRM_FILE, JSON.stringify(crm, null, 2));
  console.log(`Wrote ${CRM_FILE}`);
}

main();
