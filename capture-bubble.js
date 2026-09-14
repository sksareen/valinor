// capture-bubble.js — the always-there voice ingest bubble, mounted in the hub shell.
//
// Click the mic to latch talk-to-save; hold ` (backtick) or the mic for push-to-talk.
// audio is transcribed (/api/transcribe — works in Electron, unlike webkitSpeechRecognition)
// then refined into a note + plan (/api/ingest/capture) and shown in the bubble. The whole
// thing floats over every view because it lives in the shell, not any single page.
(function () {
  if (window.__captureBubble) return;
  window.__captureBubble = true;

  const HOLD_KEY = '`'; // hold backtick to talk

  // ---- styles ----
  const css = `
  #cbWrap{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:var(--font, Lato, system-ui, sans-serif);}
  /* Adopt the hub corner pill (cursor half) and add camera + mic halves. */
  #cbWrap #hubCornerPill{position:static;right:auto;bottom:auto;z-index:auto;}
  #camToggle,#cbDot,#hubCornerPill #cursorToggle{width:48px;height:48px;flex:none;border:none;border-radius:0;cursor:pointer;display:flex;align-items:center;justify-content:center;
    background:transparent;color:var(--accent,#7dd3fc);box-shadow:none;transition:background .12s,color .12s;padding:0;}
  #camToggle,#hubCornerPill #cursorToggle{border-right:1px solid rgba(255,255,255,.1);color:var(--dim,#94a3b8);}
  #camToggle:hover,#cbDot:hover{background:rgba(255,255,255,.04);}
  #camToggle.on{color:var(--accent,#7dd3fc);}
  #camToggle.off{color:var(--mute,#64748b);}
  #camToggle.off svg .cam-slash{opacity:1;}
  #camToggle svg .cam-slash{opacity:0;}
  #cbDot.rec{color:#fecaca;background:rgba(248,113,113,.14);box-shadow:inset 0 0 0 2px rgba(248,113,113,.35);}
  #cbDot.busy{opacity:.7;}
  #camToggle svg,#cbDot svg{width:22px;height:22px;}
  /* Mic/camera-only: if cursor pill never mounted, keep a round bubble. */
  #hubCornerPill:not(:has(#cursorToggle)){border-radius:999px;}
  #hubCornerPill:not(:has(#cursorToggle)):not(:has(#camToggle)) #cbDot{border-radius:50%;background:#0f172a;border:1px solid #1e293b;box-shadow:0 6px 24px rgba(0,0,0,.45);}
  #hubCornerPill:not(:has(#cursorToggle)):not(:has(#camToggle)) #cbDot:hover{transform:translateY(-1px);border-color:#334155;background:#0f172a;}
  #hubCornerPill:not(:has(#cursorToggle)):not(:has(#camToggle)) #cbDot.rec{border-color:#f87171;box-shadow:0 0 0 4px rgba(248,113,113,.18),0 6px 24px rgba(0,0,0,.45);}
  #cbPanel{position:absolute;right:0;bottom:60px;width:340px;max-height:60vh;display:none;flex-direction:column;
    background:var(--bg-elev,#0b1120);border:1px solid var(--line,#1e293b);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;}
  #cbWrap.open #cbPanel{display:flex;}
  #cbHead{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--line,#1e293b);color:var(--dim,#94a3b8);font-size:12px;}
  #cbHead b{color:var(--ink,#e2e8f0);font-weight:650;letter-spacing:.02em;}
  #cbThread{overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;}
  .cbCard{background:var(--bg-card,#0f172a);border:1px solid var(--line,#1e293b);border-radius:10px;padding:10px 12px;}
  .cbCard .t{color:var(--ink,#e2e8f0);font-weight:650;font-size:13px;margin-bottom:4px;}
  .cbCard .r{color:var(--ink-dim,#cbd5e1);font-size:13px;line-height:1.45;}
  .cbCard .plan{margin:8px 0 0;padding-left:16px;color:var(--dim,#94a3b8);font-size:12.5px;line-height:1.5;}
  .cbCard .next{margin-top:8px;color:var(--accent,#7dd3fc);font-size:12.5px;}
  .cbCard .raw{margin-top:8px;color:var(--mute,#64748b);font-size:11.5px;font-style:italic;border-top:1px dashed var(--line,#1e293b);padding-top:6px;}
  .cbCard.pending{color:var(--mute,#64748b);font-size:12.5px;font-style:italic;}
  #cbHint{padding:8px 12px;border-top:1px solid var(--line,#1e293b);color:var(--mute,#64748b);font-size:11.5px;text-align:center;}
  #cbHint kbd{background:var(--line,#1e293b);color:var(--ink-dim,#cbd5e1);border-radius:4px;padding:1px 5px;font-family:ui-monospace,monospace;}
  #cbClose{cursor:pointer;color:var(--mute,#64748b);}#cbClose:hover{color:var(--ink-dim,#cbd5e1);}
  :root[data-theme="light"] #hubCornerPill{background:rgba(255,255,255,.92);border-color:#e2e8f0;}
  :root[data-theme="light"] #hubCornerPill #cursorToggle{color:#64748b;border-right-color:#e2e8f0;}
  :root[data-theme="light"] #hubCornerPill #cursorToggle:hover{color:#0f172a;background:rgba(15,23,42,.04);}
  :root[data-theme="light"] #hubCornerPill #cursorToggle.on{color:#0284c7;background:rgba(2,132,199,.1);}
  :root[data-theme="light"] #camToggle{color:#64748b;border-right-color:#e2e8f0;}
  :root[data-theme="light"] #camToggle.on{color:#0284c7;}
  :root[data-theme="light"] #cbDot{color:#0284c7;}
  :root[data-theme="light"] #hubCornerPill:not(:has(#cursorToggle)):not(:has(#camToggle)) #cbDot{background:#fff;border-color:#e2e8f0;}
  :root[data-theme="light"] #cbPanel{background:#fff;border-color:#e2e8f0;}
  :root[data-theme="light"] #cbHead b{color:#0f172a;}
  :root[data-theme="light"] .cbCard{background:#f8fafc;border-color:#e2e8f0;}
  :root[data-theme="light"] .cbCard .t{color:#0f172a;}
  :root[data-theme="light"] .cbCard .r{color:#334155;}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`;
  const CAM = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/><line class="cam-slash" x1="2" y1="2" x2="22" y2="22"/></svg>`;

  // Reuse the cursor pill shell when present so cursor + camera + mic share one control.
  let pill = document.getElementById('hubCornerPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'hubCornerPill';
  }
  const orphanCursor = document.getElementById('cursorToggle');
  if (orphanCursor && orphanCursor.parentElement !== pill) pill.appendChild(orphanCursor);
  const wrap = document.createElement('div');
  wrap.id = 'cbWrap';
  const panelEl = document.createElement('div');
  panelEl.id = 'cbPanel';
  panelEl.innerHTML = `
      <div id="cbHead"><b>Capture</b><span id="cbClose">esc</span></div>
      <div id="cbThread"></div>
      <div id="cbHint">Click the mic to talk &middot; hold <kbd>\`</kbd> to push-to-talk</div>`;

  let camBtn = document.getElementById('camToggle');
  if (!camBtn) {
    camBtn = document.createElement('button');
    camBtn.type = 'button';
    camBtn.id = 'camToggle';
    camBtn.innerHTML = CAM;
  }
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.id = 'cbDot';
  dot.title = 'Click to talk · hold ` to push-to-talk';
  dot.setAttribute('aria-label', 'Microphone');
  dot.setAttribute('aria-pressed', 'false');
  dot.innerHTML = MIC;
  // Order: cursor | camera | mic
  if (camBtn.parentElement !== pill) {
    const cursor = pill.querySelector('#cursorToggle');
    if (cursor && cursor.nextSibling) pill.insertBefore(camBtn, cursor.nextSibling);
    else if (cursor) pill.appendChild(camBtn);
    else pill.insertBefore(camBtn, pill.firstChild);
  }
  pill.appendChild(dot);
  wrap.appendChild(panelEl);
  wrap.appendChild(pill);
  document.body.appendChild(wrap);

  function syncCamBtn(on) {
    const enabled = !!on;
    camBtn.classList.toggle('on', enabled);
    camBtn.classList.toggle('off', !enabled);
    camBtn.title = enabled ? 'Turn camera off' : 'Turn camera on';
    camBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }
  syncCamBtn(window.hubShared && window.hubShared.cameraEnabled);
  window.addEventListener('hub-camera', (e) => syncCamBtn(e.detail && e.detail.on));
  camBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const shared = window.hubShared;
    if (!shared || typeof shared.setCamera !== 'function') return;
    camBtn.disabled = true;
    try {
      await shared.setCamera(!shared.cameraEnabled);
    } finally {
      camBtn.disabled = false;
      syncCamBtn(shared.cameraEnabled);
    }
  });
  camBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

  const panel = wrap.querySelector('#cbThread');
  const hint = wrap.querySelector('#cbHint');
  wrap.querySelector('#cbClose').onclick = () => wrap.classList.remove('open');

  const thread = []; // {role, content} for contextual follow-ups
  let recorder = null, chunks = [], recording = false, busy = false, ownMic = null;
  let recGen = 0;
  let discard = false;
  let recMode = null; // 'latch' (click toggle) | 'hold' (backtick / press-and-hold)
  const IDLE_HINT = 'Click the mic to talk &middot; hold <kbd>`</kbd> to push-to-talk';

  function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
  function open() { wrap.classList.add('open'); }

  function renderCard(rec) {
    const card = document.createElement('div');
    card.className = 'cbCard';
    const plan = (rec.plan || []).map((s) => `<li>${esc(s)}</li>`).join('');
    card.innerHTML =
      `<div class="t">${esc(rec.title || 'Capture')}</div>` +
      `<div class="r">${esc(rec.refined || '')}</div>` +
      (plan ? `<ul class="plan">${plan}</ul>` : '') +
      (rec.nextAction ? `<div class="next">→ ${esc(rec.nextAction)}</div>` : '') +
      (rec.raw ? `<div class="raw">“${esc(rec.raw)}”</div>` : '');
    panel.appendChild(card);
    panel.scrollTop = panel.scrollHeight;
    thread.push({ role: 'user', content: rec.raw || '' });
    thread.push({ role: 'assistant', content: rec.refined || '' });
  }

  function pending(text) {
    const p = document.createElement('div');
    p.className = 'cbCard pending';
    p.textContent = text;
    panel.appendChild(p);
    panel.scrollTop = panel.scrollHeight;
    return p;
  }

  async function getMic() {
    try { if (window.hubShared && window.hubShared.mic) return window.hubShared.mic; } catch (e) {}
    if (ownMic) return ownMic;
    ownMic = await navigator.mediaDevices.getUserMedia({ audio: true });
    return ownMic;
  }

  async function startRec(mode) {
    if (recording || busy) return;
    recMode = mode || 'hold';
    const gen = ++recGen;
    discard = false;
    let stream;
    try { stream = await getMic(); } catch (e) { recMode = null; hint.textContent = 'mic blocked — check permission'; return; }
    if (gen !== recGen) { recMode = null; return; }
    // pause any other speech owner (Live, etc.) while we hold to talk
    try {
      const s = window.hubShared;
      if (s && s.speechOwner && s.speechOwner !== 'capture' && typeof s.speechStopper === 'function') s.speechStopper();
      if (s) { s.speechOwner = 'capture'; s.speechStopper = () => stopRec(true); }
    } catch (e) {}
    chunks = [];
    try { recorder = new MediaRecorder(stream); } catch (e) {
      hint.textContent = 'recording unsupported';
      recMode = null;
      try { const s = window.hubShared; if (s && s.speechOwner === 'capture') { s.speechOwner = null; s.speechStopper = null; } } catch (err) {}
      return;
    }
    if (gen !== recGen) {
      try { const s = window.hubShared; if (s && s.speechOwner === 'capture') { s.speechOwner = null; s.speechStopper = null; } } catch (err) {}
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onStop;
    recorder.start();
    recording = true;
    dot.classList.add('rec');
    dot.setAttribute('aria-pressed', 'true');
    open();
    hint.innerHTML = recMode === 'latch'
      ? 'listening… click mic to save'
      : 'listening… release to save';
  }

  function stopRec(silent) {
    recGen++;
    if (!recording) return;
    recording = false;
    recMode = null;
    if (silent) discard = true;
    dot.classList.remove('rec');
    dot.setAttribute('aria-pressed', 'false');
    try { recorder.stop(); } catch (e) {}
    try { const s = window.hubShared; if (s && s.speechOwner === 'capture') { s.speechOwner = null; s.speechStopper = null; } } catch (e) {}
    if (!silent) hint.textContent = 'thinking…';
  }

  async function onStop() {
    const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || 'audio/webm' });
    chunks = [];
    if (discard) {
      discard = false;
      hint.innerHTML = IDLE_HINT;
      return;
    }
    if (blob.size < 800) {
      hint.innerHTML = IDLE_HINT;
      if (!thread.length) wrap.classList.remove('open');
      return;
    }
    busy = true; dot.classList.add('busy');
    const p = pending('transcribing…');
    try {
      const tr = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok) throw new Error(tj.error || `transcribe ${tr.status}`);
      const text = (tj.text || '').trim();
      if (!text) {
        p.remove();
        hint.innerHTML = IDLE_HINT;
        if (!thread.length) wrap.classList.remove('open');
        return;
      }
      p.textContent = 'refining…';
      const cr = await fetch('/api/ingest/capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, history: thread.slice(-6), source: 'voice' }),
      });
      const cj = await cr.json().catch(() => ({}));
      if (!cr.ok) throw new Error(cj.error || `capture ${cr.status}`);
      p.remove();
      renderCard(cj);
      hint.innerHTML = 'saved &middot; ' + IDLE_HINT;
    } catch (e) {
      p.className = 'cbCard';
      p.innerHTML = `<div class="r" style="color:#f87171">${esc(e.message || e)}</div>`;
    } finally {
      busy = false; dot.classList.remove('busy');
    }
  }

  // ---- input: click toggles latch; hold mic or ` is push-to-talk ----
  const HOLD_MS = 180;
  let armed = false;
  let held = false;
  let holdTimer = 0;
  let keyArmed = false;
  let keyTimer = 0;

  function typingTarget() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  function toggleLatch() {
    if (busy) return;
    if (recMode === 'hold') return;
    if (recording) { stopRec(false); return; }
    if (recMode === 'latch') {
      recGen++;
      recMode = null;
      return;
    }
    startRec('latch');
  }

  function cancelHold(silent) {
    armed = false;
    keyArmed = false;
    clearTimeout(holdTimer);
    clearTimeout(keyTimer);
    held = false;
    if (recording) stopRec(silent !== false);
  }

  function beginKeyHold() {
    if (keyArmed || busy || document.hidden) return;
    if (recording) return;
    keyArmed = true;
    held = false;
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      if (!keyArmed || document.hidden) return;
      held = true;
      startRec('hold');
    }, HOLD_MS);
  }

  function endKeyHold() {
    if (recMode === 'latch') {
      keyArmed = false;
      clearTimeout(keyTimer);
      return;
    }
    if (!keyArmed) {
      if (recording && recMode === 'hold') stopRec(false);
      return;
    }
    keyArmed = false;
    clearTimeout(keyTimer);
    if (held) stopRec(false);
    held = false;
  }

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (wrap.classList.contains('open') || recording || keyArmed)) {
      wrap.classList.remove('open');
      cancelHold(true);
      return;
    }
    if (e.key !== HOLD_KEY || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (typingTarget()) return;
    e.preventDefault();
    beginKeyHold();
  });
  addEventListener('keyup', (e) => {
    if (e.key !== HOLD_KEY) return;
    if (keyArmed || recording) e.preventDefault();
    endKeyHold();
  });
  addEventListener('blur', () => {
    if (recording) return;
    cancelHold(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recMode !== 'latch') cancelHold(true);
  });

  dot.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { dot.setPointerCapture(e.pointerId); } catch { /* ok */ }
    armed = true;
    held = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!armed) return;
      if (recording && recMode === 'latch') return;
      held = true;
      startRec('hold');
    }, HOLD_MS);
  });
  dot.addEventListener('pointerup', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!armed) return;
    armed = false;
    clearTimeout(holdTimer);
    if (held) stopRec(false);
    else toggleLatch();
    held = false;
  });
  dot.addEventListener('pointercancel', () => cancelHold(true));
  dot.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  dot.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleLatch();
  });

  // Backtick held inside an embedded view can't reach this shell listener, so hub-client
  // forwards it as a capture-key message. Same hold delay as the shell key listener.
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type !== 'capture-key') return;
    if (e.data.phase === 'down') beginKeyHold();
    else if (e.data.phase === 'up') endKeyHold();
  });
})();
