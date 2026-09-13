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
  // Walk parent then grandparent so nested embeds (e.g. board.html inside live.html
  // inside hub.html) still find hubShared on the shell.
  let hub = null;
  try {
    let p = window.parent;
    for (let depth = 0; depth < 2 && p && p !== window; depth++) {
      if (p.hubShared) { hub = p; break; }
      if (p.parent === p) break;
      p = p.parent;
    }
  } catch (e) {}
  // embedded views start inactive until hub (or a parent relay) posts {type:'active', on:true}
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
        if (e.data.type === 'appearance' && (e.data.theme === 'dark' || e.data.theme === 'light')) cb(e.data.theme);
      });
    },
    uiFont() {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
      return v || 'Lato, sans-serif';
    },
  };
})();
// Cmd+I / Cmd+U / Cmd+K / Cmd+J / Cmd+P in any embedded hub view forward to the shell.
if (HubClient.embedded) {
  function applyHubPad(data) {
    const root = document.documentElement;
    let layout = data && data.layout;
    let fit = data && data.fit;
    if (!layout || !fit) {
      try {
        const d = window.parent.document.documentElement.dataset;
        layout = layout || d.layout;
        fit = fit || d.fit;
      } catch (err) {}
    }
    if (layout) root.dataset.hubLayout = layout;
    if (fit) root.dataset.hubFit = fit;
    const inset = (fit || root.dataset.hubFit) === 'inset';
    const side = (layout || root.dataset.hubLayout) === 'left';
    if (inset) {
      root.style.setProperty('--hub-pad-top', '0px');
      root.style.setProperty('--hub-pad-left', '0px');
    } else if (side) {
      root.style.setProperty('--hub-pad-top', '0px');
      root.style.setProperty('--hub-pad-left', '168px');
    } else {
      root.style.setProperty('--hub-pad-top', '44px');
      root.style.setProperty('--hub-pad-left', '0px');
    }
  }
  function applyAppearance(data) {
    if (!data) return;
    const root = document.documentElement;
    if (data.theme === 'dark' || data.theme === 'light') {
      root.dataset.theme = data.theme;
      root.style.colorScheme = data.theme;
    }
    if (data.scheme) root.dataset.scheme = data.scheme;
    if (data.font) root.dataset.font = data.font;
    if (data.size) root.dataset.size = data.size;
    if (data.density) root.dataset.density = data.density;
    applyHubPad(data);
  }
  function appearanceFromParent() {
    try {
      const d = window.parent.document.documentElement.dataset;
      return {
        theme: d.theme,
        scheme: d.scheme,
        font: d.font,
        size: d.size,
        density: d.density,
        layout: d.layout,
        fit: d.fit,
      };
    } catch (err) {
      return null;
    }
  }
  applyHubPad();
  applyAppearance(appearanceFromParent());
  try {
    const parentRoot = window.parent.document.documentElement;
    new MutationObserver(() => applyAppearance(appearanceFromParent())).observe(parentRoot, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-scheme', 'data-font', 'data-size', 'data-density', 'data-layout', 'data-fit'],
    });
  } catch (err) {}
  addEventListener('storage', (e) => {
    if (e.key === 'lk-theme' && (e.newValue === 'dark' || e.newValue === 'light')) {
      applyAppearance({ theme: e.newValue });
    }
  });
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
    } else if (key === 'p') {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'cmd-palette' }, location.origin); } catch (err) {}
    }
  });
  // Hold ` (backtick) inside an embedded view → forward to the shell's capture bubble,
  // which lives top-level and holds the mic permission. Mirrors the Cmd+* forwarding above.
  let captureKeyDown = false;
  addEventListener('keydown', (e) => {
    if (e.key !== '`' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    captureKeyDown = true;
    try { window.parent.postMessage({ type: 'capture-key', phase: 'down' }, location.origin); } catch (err) {}
  });
  addEventListener('keyup', (e) => {
    if (e.key !== '`') return;
    if (!captureKeyDown) return;
    captureKeyDown = false;
    try { window.parent.postMessage({ type: 'capture-key', phase: 'up' }, location.origin); } catch (err) {}
  });
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'appearance') applyAppearance(e.data);
    else if (e.data.type === 'theme') applyAppearance({ theme: e.data.theme });
  });
}

// Hub chrome already uses --font. Views hardcoded Lato, so the settings picker
// never reached them. This bridge loads the faces and forces UI type to follow
// data-font (from the appearance post, the parent hub, or localStorage).
(function applyHubTypeface() {
  const OK = /^(lato|plex|source|mono)$/;
  const HREF = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:wght@400;600;700&family=Lato:wght@400;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap';
  if (!document.getElementById('hub-font-link')) {
    const link = document.createElement('link');
    link.id = 'hub-font-link';
    link.rel = 'stylesheet';
    link.href = HREF;
    document.head.appendChild(link);
  }
  if (!document.getElementById('hub-font-bridge')) {
    const style = document.createElement('style');
    style.id = 'hub-font-bridge';
    style.textContent = [
      'html[data-font="lato"]{--font:Lato,sans-serif}',
      'html[data-font="plex"]{--font:"IBM Plex Sans",sans-serif}',
      'html[data-font="source"]{--font:"Source Serif 4",Georgia,serif}',
      'html[data-font="mono"]{--font:"IBM Plex Mono",ui-monospace,monospace}',
      'html[data-font]{font-family:var(--font)}',
      'html[data-font] body{font-family:var(--font)}',
      'html[data-font] :not(code):not(pre):not(kbd):not(samp):not(tt):not([data-font]){font-family:var(--font)!important}',
      'html[data-font] code,html[data-font] pre,html[data-font] kbd,html[data-font] samp,html[data-font] tt{font-family:ui-monospace,SFMono-Regular,Menlo,"IBM Plex Mono",monospace!important}',
    ].join('');
    document.head.appendChild(style);
  }
  function readFont() {
    const fromRoot = document.documentElement.dataset.font;
    if (OK.test(fromRoot || '')) return fromRoot;
    try {
      const p = window.parent;
      if (p && p !== window) {
        const f = p.document.documentElement.dataset.font;
        if (OK.test(f || '')) return f;
      }
    } catch { /* cross-origin */ }
    try {
      const f = localStorage.getItem('hub-font');
      if (OK.test(f || '')) return f;
    } catch { /* blocked */ }
    return null;
  }
  const font = readFont();
  if (font) document.documentElement.dataset.font = font;
})();

// Same contract as font: seed data-theme before the hub's appearance post arrives
// (and for standalone opens) so light CSS can paint the first frame correctly.
(function applyHubTheme() {
  function readTheme() {
    try {
      const p = window.parent;
      if (p && p !== window) {
        const t = p.document.documentElement.dataset.theme;
        if (t === 'dark' || t === 'light') return t;
      }
    } catch { /* cross-origin */ }
    const fromRoot = document.documentElement.dataset.theme;
    if (fromRoot === 'dark' || fromRoot === 'light') return fromRoot;
    try {
      const t = localStorage.getItem('lk-theme');
      if (t === 'dark' || t === 'light') return t;
    } catch { /* blocked */ }
    try {
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch { /* ok */ }
    return 'dark';
  }
  const theme = readTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
