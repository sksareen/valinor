'use strict';
/** Compact machine/activity summary for Valinor tools. Does not scrape HTML. */
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const SAURON_BIN = process.env.SAURON_BIN || path.join(os.homedir(), 'go', 'bin', 'sauron');

function sauronExec(args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(SAURON_BIN, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: String(err.message || err), stderr: String(stderr || '').slice(0, 200) });
        return;
      }
      const text = String(stdout || '').trim();
      if (!text) { resolve({ ok: true, data: null }); return; }
      try { resolve({ ok: true, data: JSON.parse(text) }); }
      catch { resolve({ ok: true, data: text, raw: true }); }
    });
  });
}

function slimHw() {
  try {
    const hw = require('./hw-sampler');
    const snap = hw.getSnapshot();
    const p = snap && snap.latest;
    if (!p) return null;
    return {
      cpu: p.cpu ?? null,
      memPct: p.memPct ?? null,
      memUsedGb: p.memUsedGb ?? null,
      diskUsedGb: p.diskUsedGb ?? null,
      diskTotalGb: p.diskTotalGb ?? null,
    };
  } catch {
    return null;
  }
}

function slimContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return {
    dominant_app: ctx.dominant_app || ctx.app || null,
    session_type: ctx.session_type || null,
    focus_score: ctx.focus_score ?? null,
    session_age_min: ctx.session_age_min ?? null,
    open_thread: ctx.open_thread ? String(ctx.open_thread).slice(0, 160) : null,
  };
}

function slimEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const summary = String(e.summary || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return {
    t: e.timestamp || e.ts || null,
    type: e.type || null,
    summary: summary || null,
  };
}

function slimActivity(act) {
  if (!act || typeof act !== 'object') return null;
  const breakdown = act.app_breakdown && typeof act.app_breakdown === 'object'
    ? Object.entries(act.app_breakdown)
        .sort((a, b) => (b[1] || 0) - (a[1] || 0))
        .slice(0, 5)
        .map(([app, n]) => ({ app, n }))
    : [];
  return {
    switches: act.switches ?? null,
    apps: breakdown,
  };
}

function cursorCaptures(limit) {
  try {
    const ingest = require('./ingest-server');
    const items = (ingest.listCaptures(40) || [])
      .filter((c) => /cursor/i.test(String(c.source || '')) || /cursor/i.test(String(c.title || '')))
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        title: c.title,
        created: c.created,
        preview: String(c.preview || '').slice(0, 120),
      }));
    return items;
  } catch {
    return [];
  }
}

async function compactRecentActivity({ hours = 2, limit = 8 } = {}) {
  const h = Math.min(Math.max(Number(hours) || 2, 0.25), 12);
  const n = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const [statusR, contextR, activityR, timelineR] = await Promise.all([
    sauronExec(['status']),
    sauronExec(['context', '--json']),
    sauronExec(['activity', String(h), '--json']),
    sauronExec(['timeline', '--hours', String(h), '--json']),
  ]);

  let status = { running: null };
  if (statusR.ok && typeof statusR.data === 'string') {
    const running = /sauron:\s*running/i.test(statusR.data) && !/not running/i.test(statusR.data);
    status = { running };
  } else if (!statusR.ok) {
    status = { running: false, error: statusR.error || 'sauron unavailable' };
  }

  const timeline = Array.isArray(timelineR.data) ? timelineR.data : [];
  const events = timeline
    .map(slimEvent)
    .filter(Boolean)
    .slice(-n)
    .reverse();

  return {
    hours: h,
    now: slimContext(contextR.ok ? contextR.data : null),
    status,
    activity: slimActivity(activityR.ok ? activityR.data : null),
    recent: events,
    hw: slimHw(),
    cursor_captures: cursorCaptures(3),
    errors: {
      context: contextR.ok ? null : contextR.error,
      activity: activityR.ok ? null : activityR.error,
      timeline: timelineR.ok ? null : timelineR.error,
    },
  };
}

module.exports = { compactRecentActivity };
