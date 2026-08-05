// hub-client.js — the embed contract between hub.html (the shell) and each view.
// Every view loads this. Two modes:
//   embedded   — the page is a same-origin iframe inside hub.html, created after the
//                hub acquired camera+mic and started the shared hand tracker. The view
//                auto-starts, reuses the hub's camera stream, and consumes hand frames.
//   standalone — the page was opened directly; HubClient.embedded is false and the
//                view acquires camera/mic and runs its own tracker as before.
const HubClient = (() => {
  // NOTE: hub.html sets window.hubShared synchronously (before any iframe can be
  // created), so checking for its mere presence — not waiting for camera/mic to be
  // granted — is what tells us "this is our hub", without racing the permission grant.
  let hub = null;
  try { if (window.parent !== window && window.parent.hubShared) hub = window.parent; } catch (e) {}
  // embedded views start inactive until hub posts {type:'active', on:true}
  let active = !hub;
  const shared = () => (hub && hub.hubShared) || null;
  const handsCbs = [], modeCbs = [], activeCbs = [];
  if (hub) {
    addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.type === 'hands') handsCbs.forEach(f => f(e.data));
      if (e.data.type === 'mode') modeCbs.forEach(f => f(e.data.mode));
      if (e.data.type === 'active') {
        active = !!e.data.on;
        activeCbs.forEach(f => f(e.data.on));
      }
    });
  }
  function isElectron() {
    try {
      if (typeof process !== 'undefined' && process.versions && process.versions.electron) return true;
    } catch (e) {}
    return /Electron/i.test(navigator.userAgent || '');
  }
  return {
    embedded: !!hub,
    isActive() { return active; },
    // Electron's Chromium has no Google STT keys — webkitSpeechRecognition always
    // fails with error 'network'. Real Chrome/Edge browsers work.
    isElectron,
    // Base diagnostic only — callers append what they specifically do next (board/hud
    // fall back to record+transcribe; rehearse falls back to the timed scroll, since
    // voice-follow needs real-time transcripts that recording can't provide).
    speechHint() {
      if (isElectron())
        return 'speech needs Chrome (Electron has no Google STT) — open http://localhost:4777 in Chrome';
      return 'Chrome speech service unreachable (try real Chrome, not Arc/Brave/other Chromium, or check network/firewall)';
    },
    // the hub's 640x480 camera stream (also feeds the shared tracker); null when standalone
    // or while the hub's permission grant is still in flight
    camera() { const s = shared(); return s ? s.cam : null; },
    // the hub's shared mic stream — granted once at hub start; null when standalone,
    // still granting, or when the hub couldn't open a mic (see micError() for why)
    mic() { const s = shared(); return s ? s.mic : null; },
    micError() { const s = shared(); return s ? s.micError : null; },
    // At most ONE SpeechRecognition (or recording) across every hub iframe. claim() stops
    // any prior owner via its stopper callback before granting. release() when you stop.
    claimSpeech(id, stopper) {
      const s = shared();
      if (!s) return true;
      if (s.speechOwner && s.speechOwner !== id && typeof s.speechStopper === 'function') {
        try { s.speechStopper(); } catch (e) {}
      }
      s.speechOwner = id;
      s.speechStopper = stopper || null;
      return true;
    },
    releaseSpeech(id) {
      const s = shared();
      if (s && s.speechOwner === id) { s.speechOwner = null; s.speechStopper = null; }
    },
    // record → server-transcribe fallback for when SpeechRecognition can't reach Google's
    // cloud STT (Electron, non-Chrome Chromium, blocked networks). Verified against a real
    // audio-capable OpenRouter model — works from any browser that can just record audio.
    async transcribe(blob) {
      const r = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `transcribe HTTP ${r.status}`);
      return j.text || '';
    },
    // hand frames (~30fps, delivered only while this view is the active one):
    // { multiHandLandmarks: [[{x,y,z} x21], ...] } — same shape MediaPipe's onResults gets
    onHands(cb) { handsCbs.push(cb); },
    // hub nav drives the HUD's BREATHE/SYSTEM modes
    onMode(cb) { modeCbs.push(cb); },
    // fired with false when another view takes over — release mics/recordings here
    onActive(cb) { activeCbs.push(cb); },
    // opt-in: plain 1–9 then 0 (outside text fields) switches hub views.
    // Views where bare typing is content (the board) must NOT call this.
    forwardNavKeys() {
      if (!hub) return;
      addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        if (/^[0-9]$/.test(e.key)) hub.postMessage({ type: 'navkey', key: e.key }, location.origin);
      });
    },
    onTheme(cb) {
      if (!hub) return;
      addEventListener('message', (e) => {
        if (e.origin !== location.origin || !e.data) return;
        if (e.data.type === 'theme' && (e.data.theme === 'dark' || e.data.theme === 'light')) cb(e.data.theme);
      });
    },
  };
})();
// Cmd+I / Cmd+U / Cmd+K / Cmd+J / Cmd+P in any embedded hub view forward to the shell.
if (HubClient.embedded) {
  addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const key = e.key.toLowerCase();
    if (key === 'u') {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'cursor-toggle' }, location.origin); } catch (err) {}
    } else if (key === 'i') {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'theme-toggle' }, location.origin); } catch (err) {}
    } else if (key === 'k') {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'settings-toggle' }, location.origin); } catch (err) {}
    } else if (key === 'j') {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'sys-overlay-toggle' }, location.origin); } catch (err) {}
    } else if (key === 'p') {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'cmd-palette' }, location.origin); } catch (err) {}
    }
  });
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'appearance') {
      const root = document.documentElement;
      if (e.data.theme === 'dark' || e.data.theme === 'light') root.dataset.theme = e.data.theme;
      if (e.data.scheme) root.dataset.scheme = e.data.scheme;
      if (e.data.font) root.dataset.font = e.data.font;
      if (e.data.size) root.dataset.size = e.data.size;
      if (e.data.density) root.dataset.density = e.data.density;
    }
  });
}
