// integrations.js — persisted config for the ingest pull integrations
// (email, iMessage). Lives OUTSIDE the repo at ~/Savar/memory/integrations.json
// so nothing credential-adjacent is ever committed. PRIVATE.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH =
  process.env.INTEGRATIONS_PATH || path.join(os.homedir(), 'Savar', 'memory', 'integrations.json');

function defaults() {
  return {
    email: { mailbox: 'INBOX', days: 7, max: 50 },
    imessage: { days: 7, maxChats: 25, perChat: 30 },
  };
}

function cleanNumber(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalize(raw) {
  const d = defaults();
  const r = (raw && typeof raw === 'object') ? raw : {};
  const e = (r.email && typeof r.email === 'object') ? r.email : {};
  const m = (r.imessage && typeof r.imessage === 'object') ? r.imessage : {};
  return {
    email: {
      mailbox: String(e.mailbox || d.email.mailbox).slice(0, 80),
      days: cleanNumber(e.days, d.email.days, 1, 90),
      max: cleanNumber(e.max, d.email.max, 1, 200),
    },
    imessage: {
      days: cleanNumber(m.days, d.imessage.days, 1, 90),
      maxChats: cleanNumber(m.maxChats, d.imessage.maxChats, 1, 100),
      perChat: cleanNumber(m.perChat, d.imessage.perChat, 5, 100),
    },
  };
}

function getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...normalize(JSON.parse(raw)), path: CONFIG_PATH };
  } catch (e) {
    return { ...defaults(), path: CONFIG_PATH };
  }
}

function saveConfig(body) {
  const cfg = normalize(body);
  try { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); } catch (e) {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { ...cfg, path: CONFIG_PATH };
}

module.exports = { getConfig, saveConfig, CONFIG_PATH };
