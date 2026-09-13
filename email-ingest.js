// email-ingest.js — pull Apple Mail (on this Mac) into the ingest store.
//
// Reads the Mac's Mail app through JXA (osascript -l JavaScript): bulk-fetch
// id/subject/sender/date for every message in the target mailbox in one call each
// (fast), then fetch content() only for recent messages we haven't saved yet.
// Dedup is by Mail's own message id; emails are immutable so existing files are
// never re-written. No model calls, no credentials — it's all local.
// Personal content — captures live under INGEST_DIR, out of git. Scrub before
// any public promotion (code promotes; captured data never does).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { INGEST_DIR, ensureDir, writeCapture } = require('./ingest-server');

// Mailbox expression: no folder (or INBOX) -> the combined inbox, else first
// mailbox with that name across all accounts.
const boxExpr = (folder) =>
  !folder || /^inbox$/i.test(folder)
    ? 'box = Mail.inbox;'
    : `box = Mail.mailboxes.whose({name: ${JSON.stringify(folder)}})[0];
       if (!box || !box.exists()) throw new Error('no mailbox named ' + ${JSON.stringify(folder)});`;

function metaScript(folder) {
  return `
    function run() {
      const Mail = Application('Mail');
      let box;
      try { ${boxExpr(folder)} } catch (e) { return JSON.stringify({ error: String(e) }); }
      const msgs = box.messages;
      let ids, subjects, senders, dates;
      try {
        ids = msgs.id(); subjects = msgs.subject();
        senders = msgs.sender(); dates = msgs.dateReceived();
      } catch (e) { return JSON.stringify({ error: String(e) }); }
      const out = [];
      for (let i = 0; i < ids.length; i++) {
        out.push({ id: ids[i], subject: subjects[i], sender: senders[i], date: dates[i] });
      }
      return JSON.stringify(out);
    }`;
}

// Content per message id, one try/catch each so a single unreadable message
// (encrypted, gigantic, gone) can't abort the batch.
function bodyScript(folder, wantIds) {
  return `
    function run() {
      const Mail = Application('Mail');
      let box;
      try { ${boxExpr(folder)} } catch (e) { return JSON.stringify({ error: String(e) }); }
      const want = ${JSON.stringify(wantIds)};
      const out = {};
      for (let k = 0; k < want.length; k++) {
        const id = want[k];
        try { out[id] = String(box.messages.byId(id).content() || ''); }
        catch (e) { out[id] = ''; }
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
          if (/-1743|not authoriz|permission/i.test(s)) {
            reject(new Error('macOS blocked Mail access. Grant permission: System Settings → Privacy & Security → Automation → (your terminal/node) → enable Mail, then retry.'));
          } else if (err.killed || /ETIMEDOUT/i.test(s)) {
            reject(new Error(`Mail read timed out after ${Math.round(timeoutMs / 1000)}s — try a smaller window.`));
          } else {
            reject(new Error(s.slice(0, 400)));
          }
          return;
        }
        let data;
        try { data = JSON.parse(String(stdout || 'null')); } catch (e) { reject(new Error('could not parse Mail output')); return; }
        if (data && data.error) { reject(new Error(String(data.error))); return; }
        resolve(data);
      }
    );
  });
}

function emailFileId(mailId) {
  return 'email-' + crypto.createHash('sha1').update(String(mailId)).digest('hex').slice(0, 12);
}

const CONTENT_CAP = 6000;

function cleanContent(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[\uFFFC\uFFFD]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, CONTENT_CAP);
}

// Pull recent mail into the store. Emails are immutable: anything already saved
// is skipped, so repeat syncs are cheap. Returns a summary.
async function importEmails({ mailbox, days = 7, max = 50 } = {}) {
  ensureDir();
  const data = await runJxa(metaScript(mailbox || null), 90000);
  const metas = Array.isArray(data) ? data : [];
  const cutoff = Date.now() - Number(days || 7) * 86400 * 1000;
  const recent = metas
    .filter((m) => m && m.id)
    .map((m) => ({ ...m, ts: m.date ? Date.parse(m.date) : NaN }))
    .filter((m) => Number.isFinite(m.ts) && m.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, Number(max) || 50));
  const fresh = recent.filter((m) => !fs.existsSync(path.join(INGEST_DIR, `${emailFileId(m.id)}.md`)));
  const bodies = {};
  const CHUNK = 25;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const chunk = fresh.slice(i, i + CHUNK).map((m) => m.id);
    const ms = Math.min(180000, 15000 + chunk.length * 1500);
    const out = await runJxa(bodyScript(mailbox || null, chunk), ms);
    if (out && typeof out === 'object') Object.assign(bodies, out);
  }
  let imported = 0;
  for (const m of fresh) {
    const fid = emailFileId(m.id);
    const subject = String(m.subject || '').trim() || '(no subject)';
    const sender = String(m.sender || '').trim() || '(unknown sender)';
    const content = cleanContent(bodies[m.id]);
    const refined = `From: ${sender}\nDate: ${new Date(m.ts).toLocaleString()}\n\n${content}`;
    writeCapture({
      id: fid,
      created: new Date(m.ts).toISOString(),
      source: 'email',
      title: subject.slice(0, 140),
      refined,
      raw: '',
      tags: ['ingest', 'email'],
    });
    imported++;
  }
  return { total: metas.length, recent: recent.length, imported, skipped: recent.length - fresh.length, mailbox: mailbox || 'INBOX' };
}

module.exports = { importEmails };
