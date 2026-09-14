// Lightweight 1Hz hardware sampler (CPU / mem / disk / net). No Sauron.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const HISTORY_MAX = 120;
const TICK_MS = 1000;

const history = [];
let latest = null;
let prevCpu = null;
let prevDiskMb = null;
let prevDiskAt = null;
let prevNet = null; // { inB, outB, t }
let diskSpace = null;
let diskSpaceAt = 0;
const DISK_SPACE_EVERY_MS = 15000;
const DF_PATH = process.platform === 'darwin' && fs.existsSync('/System/Volumes/Data')
  ? '/System/Volumes/Data'
  : '/';
let busy = false;
let started = false;
const listeners = new Set();

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function sampleCpu() {
  const cur = cpuTimes();
  let cpu = null;
  if (prevCpu) {
    const di = cur.idle - prevCpu.idle;
    const dt = cur.total - prevCpu.total;
    cpu = dt > 0 ? Math.round((1 - di / dt) * 1000) / 10 : 0;
  }
  prevCpu = cur;
  return cpu;
}

function sampleMem() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    memPct: Math.round((used / total) * 1000) / 10,
    memUsedGb: Math.round((used / (1024 ** 3)) * 100) / 100,
    memTotalGb: Math.round((total / (1024 ** 3)) * 100) / 100,
  };
}

function execText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2500, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout || ''));
    });
  });
}

/** Used/total from POSIX `df -Pk` (Darwin Data volume, else /). */
function parseDf(text) {
  if (!text) return null;
  for (const line of String(text).split('\n')) {
    const row = line.trim();
    if (!row || /^Filesystem\b/i.test(row)) continue;
    const parts = row.split(/\s+/);
    if (parts.length < 6) continue;
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    if (![totalKb, usedKb].every((n) => Number.isFinite(n) && n >= 0) || totalKb <= 0) continue;
    const used = usedKb * 1024;
    const total = totalKb * 1024;
    return {
      diskPct: Math.round((used / total) * 1000) / 10,
      diskUsedGb: Math.round((used / (1024 ** 3)) * 100) / 100,
      diskTotalGb: Math.round((total / (1024 ** 3)) * 100) / 100,
    };
  }
  return null;
}

/** Cumulative MB transferred across disks from `iostat -Id` (Darwin). */
function parseDiskMb(text) {
  if (!text) return null;
  let sum = 0;
  let found = false;
  for (const line of String(text).split('\n')) {
    if (/KB\/t|xfrs|^[\s]*disk\d/i.test(line) || !line.trim()) continue;
    const nums = line.trim().split(/\s+/).map(Number);
    if (!nums.length || nums.some((n) => Number.isNaN(n))) continue;
    // Groups of 3: KB/t, xfrs, MB — sum MB columns across disks
    if (nums.length >= 3 && nums.length % 3 === 0) {
      for (let i = 2; i < nums.length; i += 3) {
        sum += nums[i];
        found = true;
      }
    }
  }
  return found ? sum : null;
}

/** Sum Ibytes/Obytes from netstat -ib Link rows, excluding lo0. */
function parseNetBytes(text) {
  let inB = 0;
  let outB = 0;
  if (!text) return { inB, outB };
  for (const line of String(text).split('\n')) {
    if (!/<Link#\d+>/.test(line)) continue;
    const name = line.trim().split(/\s+/)[0];
    if (!name || name === 'lo0') continue;
    const gt = line.indexOf('>');
    if (gt < 0) continue;
    const parts = line.slice(gt + 1).trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Optional MAC / address before the counters
    if (parts[0] && /[a-fA-F:]/.test(parts[0]) && !/^\d+$/.test(parts[0])) i = 1;
    // Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    const ibytes = Number(parts[i + 2]);
    const obytes = Number(parts[i + 5]);
    if (Number.isFinite(ibytes)) inB += ibytes;
    if (Number.isFinite(obytes)) outB += obytes;
  }
  return { inB, outB };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

async function tick() {
  if (busy) return;
  busy = true;
  const t = Date.now();
  try {
    const cpu = sampleCpu();
    const mem = sampleMem();

    const needSpace = !diskSpace || (t - diskSpaceAt) >= DISK_SPACE_EVERY_MS;
    const [diskOut, netOut, dfOut] = await Promise.all([
      process.platform === 'darwin' ? execText('iostat', ['-Id']) : Promise.resolve(null),
      execText('netstat', ['-ib', '-n']),
      needSpace ? execText('df', ['-Pk', DF_PATH]) : Promise.resolve(null),
    ]);
    if (needSpace) {
      const parsed = parseDf(dfOut);
      if (parsed) {
        diskSpace = parsed;
        diskSpaceAt = t;
      }
    }

    const diskMb = parseDiskMb(diskOut);
    let diskMBs = null;
    if (diskMb != null && prevDiskMb != null && prevDiskAt != null) {
      const dt = Math.max((t - prevDiskAt) / 1000, 0.001);
      diskMBs = Math.max(0, round3((diskMb - prevDiskMb) / dt));
    }
    if (diskMb != null) {
      prevDiskMb = diskMb;
      prevDiskAt = t;
    }

    const net = parseNetBytes(netOut);
    let netInMBs = null;
    let netOutMBs = null;
    let netMBs = null;
    if (prevNet) {
      const dt = Math.max((t - prevNet.t) / 1000, 0.001);
      const toMBs = (delta) => Math.max(0, round3(delta / (1024 * 1024) / dt));
      netInMBs = toMBs(net.inB - prevNet.inB);
      netOutMBs = toMBs(net.outB - prevNet.outB);
      netMBs = round3(netInMBs + netOutMBs);
    }
    prevNet = { inB: net.inB, outB: net.outB, t };

    const point = {
      t,
      cpu,
      memPct: mem.memPct,
      memUsedGb: mem.memUsedGb,
      memTotalGb: mem.memTotalGb,
      diskMBs,
      diskPct: diskSpace ? diskSpace.diskPct : null,
      diskUsedGb: diskSpace ? diskSpace.diskUsedGb : null,
      diskTotalGb: diskSpace ? diskSpace.diskTotalGb : null,
      netMBs,
      netInMBs,
      netOutMBs,
    };

    latest = point;
    history.push(point);
    while (history.length > HISTORY_MAX) history.shift();

    for (const fn of listeners) {
      try { fn(point); } catch { /* ignore subscriber errors */ }
    }
  } finally {
    busy = false;
  }
}

function start() {
  if (started) return;
  started = true;
  tick();
  setInterval(tick, TICK_MS);
}

function getSnapshot() {
  return { history: history.slice(), latest };
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { start, getSnapshot, subscribe, HISTORY_MAX, TICK_MS };
