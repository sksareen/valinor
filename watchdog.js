#!/usr/bin/env node
/**
 * Lightweight health watchdog for handviz (:4777).
 * Checks hub every INTERVAL_MS; restarts `node server.js` on failure with backoff.
 * Optionally warns if Sauron looks down (does not restart Sauron).
 *
 *   npm run watch
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const PORT = 4777;
const HEALTH_PATH = '/hub.html';
const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS) || 45_000;
const HEALTH_TIMEOUT_MS = 4_000;
const LOG_FILE = path.join(ROOT, 'handviz-watchdog.log');
const SAURON_PID = path.join(os.homedir(), '.sauron', 'sauron.pid');
const SAURON_BIN = process.env.SAURON_BIN || path.join(os.homedir(), 'go', 'bin', 'sauron');

const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

let backoffMs = BACKOFF_START_MS;
let child = null; // spawned server we own (if any)

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {
    /* ignore log write failures */
  }
  // Avoid duplicate lines when the user redirects stdout into the same log file.
  if (process.stdout.isTTY) console.log(line);
}

function checkHttp(pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: pathname, timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function portListening() {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Boolean(out && out.includes(`:${PORT}`));
  } catch {
    return false;
  }
}

function sauronOk() {
  try {
    if (fs.existsSync(SAURON_PID)) {
      const pid = Number(String(fs.readFileSync(SAURON_PID, 'utf8')).trim());
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          /* stale pid */
        }
      }
    }
  } catch (_) {
    /* fall through */
  }
  try {
    const out = execFileSync(SAURON_BIN, ['status'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /sauron:\s*running/i.test(out);
  } catch {
    return false;
  }
}

function startServer() {
  if (portListening()) {
    log(`skip restart: something already listening on :${PORT}`);
    return;
  }
  if (child && !child.killed) {
    try {
      child.kill();
    } catch (_) {
      /* ignore */
    }
    child = null;
  }

  log(`restarting handviz: node server.js (cwd=${ROOT})`);
  const out = fs.openSync(LOG_FILE, 'a');
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  child.on('exit', (code, signal) => {
    log(`spawned server exited code=${code} signal=${signal || ''}`);
    child = null;
  });
  log(`spawned server pid=${child.pid}`);
}

async function tick() {
  const ok = await checkHttp(HEALTH_PATH);
  if (ok) {
    if (backoffMs !== BACKOFF_START_MS) {
      log(`health ok — reset backoff`);
    }
    backoffMs = BACKOFF_START_MS;
    if (!sauronOk()) {
      log(`warn: Sauron not running (handviz ok)`);
    }
    return;
  }

  log(`FAIL: ${HEALTH_PATH} on :${PORT} not healthy`);
  if (!sauronOk()) log(`warn: Sauron also not running`);

  if (portListening()) {
    log(`port :${PORT} still has a listener but health failed — not killing; will retry`);
  } else {
    startServer();
  }

  log(`backoff ${backoffMs}ms before next check`);
  await sleep(backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loop() {
  try {
    await tick();
  } catch (err) {
    log(`tick error: ${err && err.message ? err.message : err}`);
  }
  setTimeout(loop, INTERVAL_MS);
}

async function main() {
  log(`watchdog start interval=${INTERVAL_MS}ms health=http://127.0.0.1:${PORT}${HEALTH_PATH} log=${LOG_FILE}`);
  // Immediate check so a cold start recovers without waiting a full interval.
  loop();
}

main().catch((err) => {
  log(`fatal: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
