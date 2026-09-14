// Global hub cursor capture — click/drag stroke trail + screenshot + ≤50-word summary.
// One instance in hub.html covers every view (active + parked iframes).
// Tools: pen (default, stroke-on-drag), rect (press `c` to toggle), text
// (press `t`, click to drop a pin, type a caption — the caption is saved and
// overwrites the AI image read). Capture runs on stroke/rect end (pointerup),
// or on caption save for the text tool. Escape cancels drafts.
//
// HubCursor.init({
//   storageKey?: string,
//   endpoint?: string,
//   getContext: () => object,          // active tab, parked tabs, UI hints
//   getCaptureRoot: () => Element,     // preferred html2canvas root (iframe doc body)
//   isUiChrome?: (el) => boolean,      // ignore stroke clicks on chrome
//   accent?: string,
// })
(function (global) {
  const STYLE_ID = 'hub-cursor-capture-css';
  const TRAIL_MS = 5000;
  const TRAIL_MAX = 240;
  const TRAIL_MIN_DIST = 1.5;
  const TOOL_TIP =
    'Toggle global cursor capture (⌘U / Ctrl+U) — pen default (drag to paint); c for rect; t for text caption; Escape cancels';

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #hubCursorHit {
        position: fixed; inset: 0; z-index: 180; display: none;
        cursor: none; background: transparent;
      }
      #hubCursorHit.on { display: block; }
      #cursorTrail {
        position: fixed; inset: 0; z-index: 181; pointer-events: none; display: none;
      }
      #cursorTrail.on { display: block; }
      #liveCursor {
        position: fixed; z-index: 182; width: 34px; height: 34px;
        margin: -17px 0 0 -17px; pointer-events: none; display: none;
      }
      #liveCursor.on { display: block; }
      #liveCursor .ring {
        position: absolute; inset: 0; border-radius: 50%;
        border: 1.5px solid rgba(125,211,252,.85);
        box-shadow: 0 0 0 1px rgba(5,6,10,.55);
      }
      #liveCursor .dot {
        position: absolute; left: 50%; top: 50%; width: 5px; height: 5px;
        margin: -2.5px 0 0 -2.5px; border-radius: 50%; background: #7dd3fc;
      }
      #liveCursor .crossH, #liveCursor .crossV {
        position: absolute; background: rgba(125,211,252,.45);
      }
      #liveCursor .crossH { left: 4px; right: 4px; top: 50%; height: 1px; margin-top: -.5px; }
      #liveCursor .crossV { top: 4px; bottom: 4px; left: 50%; width: 1px; margin-left: -.5px; }
      #liveCursor.pinned .ring { border-color: #fbbf24; }
      #liveCursor.pinned .dot { background: #fbbf24; }
      #liveCursor.busy .ring { border-color: #94a3b8; animation: hubCursorPulse 1s ease-in-out infinite; }
      @keyframes hubCursorPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: .55; transform: scale(1.08); }
      }
      #cursorDock {
        position: fixed; z-index: 183; left: 50%; bottom: 76px; transform: translateX(-50%);
        width: min(640px, calc(100% - 28px));
        display: none; gap: 12px; align-items: stretch;
        padding: 10px 12px; border-radius: 12px;
        background: var(--bg-elev, rgba(7, 9, 16, .94)); border: 1px solid var(--line, rgba(255,255,255,.1));
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
        font-family: var(--font, Lato, sans-serif); color: var(--ink, #e2e8f0);
      }
      html[data-theme="light"] #cursorDock { background: rgba(255,255,255,.96); }
      #cursorDock.on { display: flex; }
      #cursorThumb {
        flex: none; width: 88px; height: 64px; border-radius: 8px; object-fit: cover;
        background: #0b0d14; border: 1px solid rgba(255,255,255,.08);
      }
      #cursorDockMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      #cursorDockLbl {
        font: 700 10px var(--font, Lato, sans-serif); letter-spacing: .1em; color: var(--faint, #475569); text-transform: uppercase;
      }
      #cursorSummary {
        font-size: 12.5px; color: var(--ink, #e2e8f0); line-height: 1.45;
        max-height: 4.2em; overflow: hidden;
      }
      #cursorSummary.empty { color: var(--mute, #64748b); }
      #cursorMeta {
        font-size: 10.5px; color: var(--faint, #475569); font-variant-numeric: tabular-nums;
        display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
      }
      #cursorMeta a { color: var(--accent, #7dd3fc); text-decoration: none; }
      #cursorDockActs { flex: none; display: flex; flex-direction: column; gap: 6px; }
      #cursorDockActs button {
        min-width: 56px; height: 28px; padding: 0 10px; border-radius: 8px;
        border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.04);
        color: #94a3b8; font: 700 11px var(--font, Lato, sans-serif); letter-spacing: .04em; cursor: pointer;
      }
      #cursorDockActs button:hover { color: #e2e8f0; border-color: rgba(125,211,252,.35); }
      #cursorCaptionRow { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
      #cursorCaptionRow[hidden] { display: none; }
      #cursorCaption {
        width: 100%; background: #0b0d14; color: #e2e8f0; border: 1px solid rgba(251,191,36,.35);
        border-radius: 8px; padding: 7px 9px; font: 400 12.5px var(--font, Lato, sans-serif);
        resize: vertical; box-sizing: border-box;
      }
      #cursorCaption:focus { outline: none; border-color: rgba(251,191,36,.7); }
      #cursorCaptionActs { display: flex; gap: 6px; }
      #cursorCaptionActs button {
        min-width: 56px; height: 26px; padding: 0 10px; border-radius: 8px;
        border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.04);
        color: #94a3b8; font: 700 11px var(--font, Lato, sans-serif); letter-spacing: .04em; cursor: pointer;
      }
      #cursorCaptionSave { color: #fbbf24; border-color: rgba(251,191,36,.4); }
      /* Split pill shell — capture-bubble.js appends the mic half into #hubCornerPill. */
      #hubCornerPill {
        position: fixed; z-index: 184; right: 18px; bottom: 18px;
        display: flex; align-items: stretch; height: 48px;
        border-radius: 999px; overflow: hidden;
        border: 1px solid rgba(255,255,255,.12); background: rgba(8,10,18,.88);
        box-shadow: 0 8px 28px rgba(0,0,0,.35); backdrop-filter: blur(12px);
        font-family: var(--font, Lato, sans-serif);
      }
      #hubCornerPill #cursorToggle {
        width: 48px; height: 100%; padding: 0; margin: 0;
        border: none; border-radius: 0; border-right: 1px solid rgba(255,255,255,.1);
        background: transparent; color: #64748b;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
      }
      #hubCornerPill #cursorToggle svg { width: 22px; height: 22px; display: block; }
      #hubCornerPill #cursorToggle:hover {
        color: #cbd5e1; background: rgba(255,255,255,.04);
      }
      #hubCornerPill #cursorToggle.on {
        color: #7dd3fc; background: rgba(125,211,252,.12);
      }
      body.hub-cursor-on #views iframe { pointer-events: none !important; }
      body.hub-cursor-on #bar, body.hub-cursor-on #navDrawer,
      body.hub-cursor-on #settingsPanel, body.hub-cursor-on #cmdPalette { pointer-events: none; }
    `;
    document.head.appendChild(s);
  }

  function ensureDom() {
    if (!document.getElementById('hubCursorHit')) {
      const hit = document.createElement('div');
      hit.id = 'hubCursorHit';
      document.body.appendChild(hit);
    }
    if (!document.getElementById('cursorTrail')) {
      const cv = document.createElement('canvas');
      cv.id = 'cursorTrail';
      cv.setAttribute('aria-hidden', 'true');
      document.body.appendChild(cv);
    }
    if (!document.getElementById('liveCursor')) {
      const el = document.createElement('div');
      el.id = 'liveCursor';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<div class="ring"></div><div class="crossH"></div><div class="crossV"></div><div class="dot"></div>';
      document.body.appendChild(el);
    }
    if (!document.getElementById('cursorDock')) {
      const dock = document.createElement('div');
      dock.id = 'cursorDock';
      dock.setAttribute('aria-live', 'polite');
      dock.innerHTML = `
        <img id="cursorThumb" alt="cursor screenshot" width="88" height="64" />
        <div id="cursorDockMain">
          <div id="cursorDockLbl">Cursor · pen · c rect · t text</div>
          <div id="cursorSummary" class="empty">Drag to paint a trail — release to capture. Press c for rectangle, t for text.</div>
          <div id="cursorMeta"></div>
          <div id="cursorCaptionRow" hidden>
            <textarea id="cursorCaption" rows="2" placeholder="Type a caption — save replaces the AI read"></textarea>
            <div id="cursorCaptionActs">
              <button type="button" id="cursorCaptionSave" title="Save caption (Enter)">save</button>
              <button type="button" id="cursorCaptionCancel" title="Cancel (Escape)">cancel</button>
            </div>
          </div>
        </div>
        <div id="cursorDockActs">
          <button type="button" id="cursorCopy" title="Copy summary">copy</button>
        </div>`;
      document.body.appendChild(dock);
    }
    let pill = document.getElementById('hubCornerPill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'hubCornerPill';
      document.body.appendChild(pill);
    }
    const CURSOR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l7.07 17 2.51-7.39L21 11.07 4 4z"/></svg>';
    let existingBtn = document.getElementById('cursorToggle');
    if (!existingBtn) {
      existingBtn = document.createElement('button');
      existingBtn.type = 'button';
      existingBtn.id = 'cursorToggle';
      pill.appendChild(existingBtn);
    } else if (existingBtn.parentElement !== pill) {
      pill.appendChild(existingBtn);
    }
    existingBtn.innerHTML = CURSOR_ICON;
    existingBtn.title = TOOL_TIP;
    existingBtn.setAttribute('aria-label', 'Cursor capture');
    existingBtn.setAttribute('aria-pressed', 'false');
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function normRect(x0, y0, x1, y1) {
    const x = Math.round(Math.min(x0, x1));
    const y = Math.round(Math.min(y0, y1));
    const w = Math.max(1, Math.round(Math.abs(x1 - x0)));
    const h = Math.max(1, Math.round(Math.abs(y1 - y0)));
    return { x, y, w, h };
  }

  function init(opts = {}) {
    ensureCss();
    ensureDom();

    const storageKey = opts.storageKey || 'hub-cursor-on';
    const endpoint = opts.endpoint || '/api/activity/cursor-context';
    const getContext = typeof opts.getContext === 'function' ? opts.getContext : () => ({});
    const getCaptureRoot = typeof opts.getCaptureRoot === 'function' ? opts.getCaptureRoot : () => document.body;
    const isUiChrome = typeof opts.isUiChrome === 'function' ? opts.isUiChrome : () => false;

    const hit = document.getElementById('hubCursorHit');
    const el = document.getElementById('liveCursor');
    const trailCv = document.getElementById('cursorTrail');
    const trailCtx = trailCv.getContext('2d');
    const dock = document.getElementById('cursorDock');
    const dockLbl = document.getElementById('cursorDockLbl');
    const summaryEl = document.getElementById('cursorSummary');
    const metaEl = document.getElementById('cursorMeta');
    const thumb = document.getElementById('cursorThumb');
    const btn = document.getElementById('cursorToggle');
    const capRow = document.getElementById('cursorCaptionRow');
    const capInput = document.getElementById('cursorCaption');
    btn.title = TOOL_TIP;

    let enabled = localStorage.getItem(storageKey) === '1';
    /** @type {'pen'|'rect'|'text'} */
    let tool = 'pen';
    let pinned = false;
    let stroking = false;
    let busy = false;
    let pendingCaption = '';
    /** @type {{ x: number, y: number } | null} */
    let textPin = null;
    let pos = { x: 0, y: 0 };
    let lastReq = 0;
    let lastSummary = '';
    let lastShotUrl = '';
    /** @type {{ t: number, x: number, y: number }[]} */
    let trail = [];
    let trailRaf = 0;
    /** @type {{ x0: number, y0: number, x1: number, y1: number } | null} */
    let draftRect = null;
    /** @type {{ x: number, y: number, w: number, h: number } | null} */
    let lastRect = null;

    function toolLabel() {
      if (tool === 'rect') return 'Cursor · rect · c pen · t text';
      if (tool === 'text') return 'Cursor · text · click to pin, type caption';
      return 'Cursor · pen · c rect · t text';
    }

    function emptyHint() {
      if (tool === 'rect') return 'Drag a rectangle — release to capture. Press c for pen, t for text.';
      if (tool === 'text') return 'Click to drop a text pin, type a caption — save replaces the AI read.';
      return 'Drag to paint a trail — release to capture. Press c for rectangle, t for text.';
    }

    function hideCaptionEditor() { if (capRow) capRow.hidden = true; }
    function showCaptionEditor() {
      if (!capRow) return;
      capRow.hidden = false;
      if (capInput) {
        capInput.value = pendingCaption || '';
        setTimeout(() => capInput.focus(), 0);
      }
    }

    function updateToolChrome() {
      if (dockLbl) dockLbl.textContent = toolLabel();
      btn.title = TOOL_TIP + (tool === 'rect' ? ' · tool: rect' : ' · tool: pen');
      if (summaryEl.classList.contains('empty') && !lastSummary) {
        summaryEl.textContent = emptyHint();
      }
    }

    function cancelDraft() {
      const wasDrawing = stroking || !!draftRect;
      stroking = false;
      draftRect = null;
      pinned = false;
      textPin = null;
      pendingCaption = '';
      hideCaptionEditor();
      el.classList.remove('pinned');
      if (wasDrawing && tool === 'pen') trail = [];
      if (trailRaf) { cancelAnimationFrame(trailRaf); trailRaf = 0; }
      drawTrail();
    }

    function setTool(next) {
      if (next !== 'pen' && next !== 'rect' && next !== 'text') return;
      if (tool === next) return;
      cancelDraft();
      tool = next;
      updateToolChrome();
      drawTrail();
    }

    function setEnabled(on) {
      enabled = on;
      localStorage.setItem(storageKey, on ? '1' : '0');
      document.body.classList.toggle('hub-cursor-on', on);
      hit.classList.toggle('on', on);
      el.classList.toggle('on', on);
      trailCv.classList.toggle('on', on);
      dock.classList.toggle('on', on);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? 'Turn cursor off (⌘U)' : TOOL_TIP;
      if (!on) {
        cancelDraft();
        el.classList.remove('busy');
        trail = [];
        lastRect = null;
        drawTrail();
      } else {
        sizeTrailCanvas();
        updateToolChrome();
        drawTrail();
        placeCursor(Math.round(window.innerWidth * 0.55), Math.round(window.innerHeight * 0.4));
      }
    }

    function sizeTrailCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (trailCv.width !== Math.round(w * dpr) || trailCv.height !== Math.round(h * dpr)) {
        trailCv.width = Math.round(w * dpr);
        trailCv.height = Math.round(h * dpr);
        trailCv.style.width = w + 'px';
        trailCv.style.height = h + 'px';
        trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    function pruneTrail(now = Date.now()) {
      const cut = now - TRAIL_MS;
      while (trail.length && trail[0].t < cut) trail.shift();
      while (trail.length > TRAIL_MAX) trail.shift();
    }

    function recordTrail(x, y, now = Date.now()) {
      pruneTrail(now);
      const last = trail[trail.length - 1];
      // Snappier: ~8ms coalesce / 32ms force-sample, 1.5px min distance
      if (last && now - last.t < 8 && Math.hypot(x - last.x, y - last.y) < TRAIL_MIN_DIST) {
        last.x = x; last.y = y; last.t = now;
      } else if (!last || Math.hypot(x - last.x, y - last.y) >= TRAIL_MIN_DIST || now - last.t >= 32) {
        trail.push({ t: now, x, y });
      } else {
        last.x = x; last.y = y; last.t = now;
      }
      pruneTrail(now);
      if (!trailRaf) trailRaf = requestAnimationFrame(() => { trailRaf = 0; drawTrail(); });
    }

    function drawRectShape(ctx, r, { fill = true, lineWidth = 1.75 } = {}) {
      if (!r || r.w < 1 || r.h < 1) return;
      if (fill) {
        ctx.fillStyle = 'rgba(125,211,252,.12)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      ctx.strokeStyle = 'rgba(125,211,252,.9)';
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([]);
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    }

    function activeRect() {
      if (draftRect) return normRect(draftRect.x0, draftRect.y0, draftRect.x1, draftRect.y1);
      return lastRect;
    }

    function drawTrail() {
      if (!enabled) {
        trailCtx.clearRect(0, 0, trailCv.width, trailCv.height);
        return;
      }
      sizeTrailCanvas();
      pruneTrail();
      const w = window.innerWidth;
      const h = window.innerHeight;
      trailCtx.clearRect(0, 0, w, h);

      const rect = activeRect();
      if (rect) drawRectShape(trailCtx, rect, { fill: true, lineWidth: draftRect ? 1.75 : 2 });

      if (trail.length >= 2) {
        const now = Date.now();
        trailCtx.lineCap = 'round';
        trailCtx.lineJoin = 'round';
        for (let i = 1; i < trail.length; i++) {
          const a = trail[i - 1];
          const b = trail[i];
          const life = 1 - (now - b.t) / TRAIL_MS;
          if (life <= 0) continue;
          trailCtx.beginPath();
          trailCtx.moveTo(a.x, a.y);
          trailCtx.lineTo(b.x, b.y);
          trailCtx.strokeStyle = `rgba(125,211,252,${(0.12 + life * 0.62).toFixed(3)})`;
          trailCtx.lineWidth = 1.6 + life * 2.8;
          trailCtx.stroke();
        }
        const tip = trail[trail.length - 1];
        if (tip) {
          const pulse = 0.35 + 0.35 * Math.sin(now / 180);
          trailCtx.beginPath();
          trailCtx.arc(tip.x, tip.y, 3.8, 0, Math.PI * 2);
          trailCtx.fillStyle = `rgba(251,191,36,${(0.45 + pulse * 0.35).toFixed(3)})`;
          trailCtx.fill();
        }
      }

      if ((trail.length || draftRect || textPin) && enabled) {
        trailRaf = requestAnimationFrame(() => { trailRaf = 0; drawTrail(); });
      }

      if (textPin) {
        trailCtx.beginPath();
        trailCtx.arc(textPin.x, textPin.y, 10, 0, Math.PI * 2);
        trailCtx.fillStyle = 'rgba(251,191,36,.92)';
        trailCtx.fill();
        trailCtx.fillStyle = '#05060a';
        trailCtx.font = '700 12px Lato, sans-serif';
        trailCtx.textAlign = 'center';
        trailCtx.textBaseline = 'middle';
        trailCtx.fillText('T', textPin.x, textPin.y + 0.5);
      }
    }

    function trailStats() {
      pruneTrail();
      if (!trail.length) {
        return { count: 0, spanMs: 0, distancePx: 0, path: null, samples: [] };
      }
      let dist = 0;
      for (let i = 1; i < trail.length; i++) {
        dist += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y);
      }
      const first = trail[0];
      const last = trail[trail.length - 1];
      const spanMs = Math.max(0, last.t - first.t);
      const step = Math.max(1, Math.floor((trail.length - 1) / 7));
      const pts = [];
      for (let i = 0; i < trail.length; i += step) pts.push(trail[i]);
      if (pts[pts.length - 1] !== last) pts.push(last);
      const path = pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' → ');
      const now = Date.now();
      const samples = pts.map((p) => ({
        agoMs: Math.max(0, now - p.t),
        x: Math.round(p.x),
        y: Math.round(p.y),
      }));
      return {
        count: trail.length,
        spanMs,
        distancePx: Math.round(dist),
        path,
        from: { x: Math.round(first.x), y: Math.round(first.y) },
        to: { x: Math.round(last.x), y: Math.round(last.y) },
        samples,
        windowMs: TRAIL_MS,
      };
    }

    function placeCursor(x, y, { paint = false } = {}) {
      pos = { x, y };
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      if (enabled && paint && tool === 'pen') recordTrail(x, y);
    }

    function pointContext(x, y) {
      // Temporarily poke through hit layer to read DOM under cursor
      hit.style.pointerEvents = 'none';
      const under = document.elementFromPoint(x, y);
      hit.style.pointerEvents = '';
      if (!under || under === el || el.contains(under) || dock.contains(under) || under === hit) {
        return { pointLabel: null, pointText: null };
      }
      // If over an iframe, try same-origin content under the cursor
      if (under.tagName === 'IFRAME') {
        try {
          const frameRect = under.getBoundingClientRect();
          const ix = x - frameRect.left;
          const iy = y - frameRect.top;
          const doc = under.contentDocument;
          const inner = doc?.elementFromPoint(ix, iy);
          if (inner) {
            const lbl = inner.closest?.('[id],.lbl,h1,h2,button,.tab')?.id
              || inner.closest?.('.lbl,h1,h2')?.textContent?.trim()
              || inner.id || inner.className?.toString?.().split(/\s+/)[0] || inner.tagName;
            let text = (inner.innerText || inner.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length > 180) text = text.slice(0, 180) + '…';
            if (text.length < 2) text = null;
            return {
              pointLabel: String(lbl || '').slice(0, 80) || null,
              pointText: text,
              pointFrame: under.src || null,
            };
          }
        } catch { /* cross-origin */ }
        return { pointLabel: 'iframe', pointText: under.src || null, pointFrame: under.src || null };
      }
      const lbl = under.closest?.('.lbl, #title, .brand, .tab')?.textContent?.trim()
        || under.id || under.className?.toString?.().split(/\s+/)[0] || under.tagName;
      let text = (under.innerText || under.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 180) text = text.slice(0, 180) + '…';
      if (text.length < 2) text = null;
      return { pointLabel: String(lbl || '').slice(0, 80) || null, pointText: text };
    }

    function rectPayload(r) {
      if (!r) return null;
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      return {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        nx: +(r.x / vw).toFixed(4),
        ny: +(r.y / vh).toFixed(4),
        nw: +(r.w / vw).toFixed(4),
        nh: +(r.h / vh).toFixed(4),
      };
    }

    function buildContext() {
      const pt = pointContext(pos.x, pos.y);
      const tr = trailStats();
      const extra = getContext() || {};
      const r = tool === 'rect' ? lastRect : null;
      const rect = rectPayload(r);
      const caption = (pendingCaption || '').trim();
      const pin = tool === 'text' ? textPin : null;
      return {
        ...extra,
        tool,
        pinned,
        caption: caption || null,
        textPin: pin ? { x: pin.x, y: pin.y } : null,
        textPinLine: pin ? `text pin ${pin.x},${pin.y}` : null,
        xy: `${Math.round(pos.x)},${Math.round(pos.y)}`,
        trail: tr.count ? {
          windowMs: tr.windowMs,
          count: tr.count,
          spanMs: tr.spanMs,
          distancePx: tr.distancePx,
          path: tr.path,
          from: tr.from,
          to: tr.to,
          samples: tr.samples,
        } : null,
        trailLine: tr.count
          ? `last ${Math.round(tr.spanMs / 100) / 10}s · ${tr.distancePx}px · ${tr.path}`
          : null,
        rect: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null,
        rectNorm: rect ? { x: rect.nx, y: rect.ny, w: rect.nw, h: rect.nh } : null,
        rectLine: rect ? `rect ${rect.x},${rect.y} ${rect.w}×${rect.h}` : null,
        ...pt,
      };
    }

    function mapPt(map, x, y, width, height) {
      if (!map) return { x: (x / window.innerWidth) * width, y: (y / window.innerHeight) * height };
      const lx = x - (map.originX || 0);
      const ly = y - (map.originY || 0);
      const fw = map.frameW || window.innerWidth;
      const fh = map.frameH || window.innerHeight;
      return { x: (lx / fw) * width, y: (ly / fh) * height };
    }

    function stampTrail(ctx, width, height, map) {
      const now = Date.now();
      pruneTrail(now);
      if (trail.length < 2) return;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const life = 1 - (now - b.t) / TRAIL_MS;
        if (life <= 0) continue;
        const pa = mapPt(map, a.x, a.y, width, height);
        const pb = mapPt(map, b.x, b.y, width, height);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.strokeStyle = `rgba(125,211,252,${(0.15 + life * 0.7).toFixed(3)})`;
        ctx.lineWidth = 1.8 + life * 3.2;
        ctx.stroke();
      }
      const tip = trail[trail.length - 1];
      const pt = mapPt(map, tip.x, tip.y, width, height);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(251,191,36,.9)';
      ctx.fill();
    }

    function stampRect(ctx, width, height, map, r) {
      if (!r) return;
      const tl = mapPt(map, r.x, r.y, width, height);
      const br = mapPt(map, r.x + r.w, r.y + r.h, width, height);
      const rx = Math.min(tl.x, br.x);
      const ry = Math.min(tl.y, br.y);
      const rw = Math.abs(br.x - tl.x);
      const rh = Math.abs(br.y - tl.y);
      ctx.fillStyle = 'rgba(125,211,252,.12)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = 'rgba(125,211,252,.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
    }

    function stampText(ctx, width, height, map, pin, caption) {
      if (!pin) return;
      const p = mapPt(map, pin.x, pin.y, width, height);
      const r = Math.max(11, width * 0.013);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(251,191,36,.95)';
      ctx.fill();
      ctx.fillStyle = '#05060a';
      ctx.font = `700 ${Math.round(r * 1.1)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('T', p.x, p.y + 1);
      const label = String(caption || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      if (label) {
        const fs = Math.max(13, Math.round(width * 0.016));
        ctx.font = `${fs}px sans-serif`;
        const tw = ctx.measureText(label).width;
        const bx = Math.min(Math.max(p.x + r + 8, 8), Math.max(8, width - tw - 20));
        const by = Math.min(Math.max(p.y - r - 12, 30), height - 12);
        ctx.fillStyle = 'rgba(5,6,10,.88)';
        ctx.fillRect(bx - 6, by - fs - 8, tw + 12, fs + 16);
        ctx.fillStyle = '#fbbf24';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, bx, by);
      }
    }

    // True screen grab (main display) from the server with the trail/rect/pins
    // stamped on top in client coords. This is the actual screen — not an
    // html2canvas re-render of one iframe. Null when unavailable (non-mac, no
    // display access) so the caller can fall back.
    async function grabScreen() {
      try {
        const res = await fetch('/api/activity/screen', { method: 'POST' });
        const j = await res.json();
        if (!res.ok || !j.dataUrl) return null;
        const img = new Image();
        await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = j.dataUrl; });
        if (!img.naturalWidth || !img.naturalHeight) return null;
        return img;
      } catch { return null; }
    }

    // Map viewport CSS px -> screen-image pixels. The grab covers the main display;
    // the hub viewport sits at (screenX, screenY) plus best-effort chrome compensation.
    function screenMap(img) {
      const dispW = window.screen.width || window.innerWidth;
      const dispH = window.screen.height || window.innerHeight;
      const sideChrome = Math.max(0, ((window.outerWidth || 0) - window.innerWidth) / 2);
      const topChrome = Math.max(0, ((window.outerHeight || 0) - window.innerHeight) - sideChrome);
      return {
        originX: -((window.screenX || 0) + sideChrome),
        originY: -((window.screenY || 0) + topChrome),
        frameW: dispW,
        frameH: dispH,
      };
    }

    function composeScreenShot(img) {
      const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      // mapPt maps (viewport px - origin) / frame * canvas px, so pass the
      // display-CSS-pixel frame; the canvas scale is handled by c.width/height.
      const map = screenMap(img);
      stampTrail(ctx, c.width, c.height, map);
      if (tool === 'rect' && lastRect) stampRect(ctx, c.width, c.height, map, lastRect);
      if (tool === 'text' && textPin) stampText(ctx, c.width, c.height, map, textPin, pendingCaption);
      return c.toDataURL('image/jpeg', 0.82);
    }

    async function captureShot() {
      // Preferred: the real screen with the mouse trail on top for context.
      const screen = await grabScreen();
      if (screen) {
        try { return composeScreenShot(screen); } catch (e) {
          console.warn('[hub-cursor] screen compose failed, falling back', e);
        }
      }
      const target = typeof opts.getCaptureTarget === 'function'
        ? opts.getCaptureTarget()
        : { root: getCaptureRoot() };
      const root = target?.root || document.body;
      const map = {
        originX: target?.originX || 0,
        originY: target?.originY || 0,
        frameW: target?.frameW || window.innerWidth,
        frameH: target?.frameH || window.innerHeight,
      };
      const scale = Math.min(1, 1100 / Math.max(root.clientWidth || map.frameW || window.innerWidth, 1));
      const hide = [el, dock, btn, hit];
      const prev = hide.map((n) => n.style.visibility);
      hide.forEach((n) => { n.style.visibility = 'hidden'; });
      try {
        if (typeof html2canvas === 'function') {
          const canvas = await html2canvas(root, {
            backgroundColor: '#05060a',
            scale,
            logging: false,
            useCORS: true,
            allowTaint: true,
            windowWidth: root.scrollWidth || root.clientWidth,
            windowHeight: Math.min(root.scrollHeight || root.clientHeight, 1800),
          });
          const c2 = canvas.getContext('2d');
          stampTrail(c2, canvas.width, canvas.height, map);
          if (tool === 'rect' && lastRect) stampRect(c2, canvas.width, canvas.height, map, lastRect);
          if (tool === 'text' && textPin) stampText(c2, canvas.width, canvas.height, map, textPin, pendingCaption);
          return canvas.toDataURL('image/jpeg', 0.72);
        }
      } catch (e) {
        console.warn('[hub-cursor] html2canvas failed', e);
      } finally {
        hide.forEach((n, i) => { n.style.visibility = prev[i]; });
      }

      // Fallback card
      const c = document.createElement('canvas');
      c.width = 720; c.height = 405;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#7dd3fc';
      ctx.font = '700 18px ' + (typeof HubClient !== 'undefined' && HubClient.uiFont ? HubClient.uiFont() : 'Lato, sans-serif');
      ctx.fillText('Valinor', 28, 40);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '14px ' + (typeof HubClient !== 'undefined' && HubClient.uiFont ? HubClient.uiFont() : 'Lato, sans-serif');
      const ctxInfo = buildContext();
      const lines = [
        ctxInfo.activeTab ? `tab ${ctxInfo.activeTab}` : null,
        ctxInfo.parked?.length ? `parked: ${ctxInfo.parked.join(', ')}` : null,
        ctxInfo.tool ? `tool ${ctxInfo.tool}` : null,
        ctxInfo.pointLabel ? `cursor → ${ctxInfo.pointLabel}` : `cursor @ ${ctxInfo.xy}`,
        ctxInfo.trailLine ? `trail ${ctxInfo.trailLine}` : null,
        ctxInfo.rectLine || null,
        ctxInfo.textPinLine || ctxInfo.caption || null,
        ctxInfo.pointText || null,
      ].filter(Boolean);
      let y = 78;
      for (const line of lines) {
        ctx.fillText(String(line).slice(0, 92), 28, y);
        y += 28;
      }
      stampTrail(ctx, c.width, c.height, null);
      if (tool === 'rect' && lastRect) stampRect(ctx, c.width, c.height, null, lastRect);
      if (tool === 'text' && textPin) stampText(ctx, c.width, c.height, null, textPin, pendingCaption);
      return c.toDataURL('image/jpeg', 0.85);
    }

    function showResult({ summary, words, screenshotUrl, screenshotPath, source, error, ingestId }) {
      lastSummary = summary || '';
      summaryEl.textContent = lastSummary || (error ? String(error) : 'No summary');
      summaryEl.classList.toggle('empty', !lastSummary);
      const bits = [];
      if (words != null) bits.push(`${words}w`);
      if (source === 'manual-caption') bits.push('your caption');
      else if (source) bits.push(source);
      bits.push(tool);
      const tr = trailStats();
      if (tr.count) bits.push(`trail ${Math.round(tr.spanMs / 100) / 10}s · ${tr.distancePx}px`);
      if (lastRect && tool === 'rect') bits.push(`rect ${lastRect.w}×${lastRect.h}`);
      if (textPin && tool === 'text') bits.push(`text ${textPin.x}×${textPin.y}`);
      const extra = getContext() || {};
      if (extra.activeTab) bits.push(String(extra.activeTab));
      if (extra.parked?.length) bits.push(`${extra.parked.length} parked`);
      if (ingestId) {
        bits.push(`<a href="/hub.html#ingest" title="Open in Ingest">ingest</a>`);
      } else if (screenshotPath) {
        bits.push(`<a href="${esc(screenshotUrl || ('/' + screenshotPath))}" target="_blank" rel="noopener">${esc(screenshotPath)}</a>`);
      }
      if (pinned) bits.push('pinned');
      metaEl.innerHTML = bits.join(' · ');
      if (screenshotUrl) {
        lastShotUrl = screenshotUrl;
        thumb.src = screenshotUrl;
        thumb.style.display = '';
      }
    }

    async function runCapture(reason) {
      if (!enabled || busy) return;
      busy = true;
      el.classList.add('busy');
      summaryEl.textContent = reason === 'pin' ? 'Pinned — summarizing…' : 'Summarizing…';
      summaryEl.classList.remove('empty');
      const reqId = ++lastReq;
      const context = buildContext();
      let image = null;
      try { image = await captureShot(); } catch { image = null; }
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image, context, caption: (pendingCaption || '').trim() || undefined }),
        });
        const j = await res.json();
        if (reqId !== lastReq) return;
        if (!res.ok) throw new Error(j.error || 'cursor-context failed');
        showResult(j);
        if ((pendingCaption || '').trim()) {
          pendingCaption = '';
          textPin = null;
          drawTrail();
        }
      } catch (e) {
        if (reqId !== lastReq) return;
        summaryEl.textContent = String(e.message || e);
        summaryEl.classList.remove('empty');
        metaEl.textContent = 'error';
      } finally {
        if (reqId === lastReq) {
          busy = false;
          el.classList.remove('busy');
        }
      }
    }

    hit.addEventListener('pointermove', (e) => {
      if (!enabled) return;
      // Crosshair follows immediately for aiming, including while drawing.
      placeCursor(e.clientX, e.clientY, { paint: stroking && tool === 'pen' });
      if (stroking && tool === 'rect' && draftRect) {
        draftRect.x1 = e.clientX;
        draftRect.y1 = e.clientY;
        if (!trailRaf) trailRaf = requestAnimationFrame(() => { trailRaf = 0; drawTrail(); });
      }
    }, { passive: true });

    hit.addEventListener('pointerdown', (e) => {
      if (!enabled || e.button !== 0) return;
      if (e.target.closest?.('#cursorDock, #hubCornerPill, #cursorToggle, #cbWrap')) return;
      if (isUiChrome(e.target)) return;
      if (tool === 'text') {
        textPin = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
        pinned = true;
        el.classList.add('pinned');
        placeCursor(e.clientX, e.clientY, { paint: false });
        drawTrail();
        showCaptionEditor();
        return;
      }
      stroking = true;
      pinned = true;
      el.classList.add('pinned');
      try { hit.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (tool === 'rect') {
        draftRect = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
        lastRect = null;
        placeCursor(e.clientX, e.clientY, { paint: false });
        drawTrail();
      } else {
        draftRect = null;
        placeCursor(e.clientX, e.clientY, { paint: true });
      }
    });

    hit.addEventListener('pointerup', (e) => {
      if (!enabled || tool === 'text' || !stroking || e.button !== 0) return;
      stroking = false;
      pinned = true;
      el.classList.add('pinned');
      placeCursor(e.clientX, e.clientY, { paint: tool === 'pen' });
      try { hit.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (tool === 'rect' && draftRect) {
        draftRect.x1 = e.clientX;
        draftRect.y1 = e.clientY;
        lastRect = normRect(draftRect.x0, draftRect.y0, draftRect.x1, draftRect.y1);
        draftRect = null;
        drawTrail();
      }
      void runCapture('pin');
    });

    hit.addEventListener('pointercancel', (e) => {
      if (!stroking) return;
      cancelDraft();
      try { hit.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });

    function toggle() {
      setEnabled(!enabled);
    }

    function isTypingTarget() {
      const a = document.activeElement;
      return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
    }

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        if (isTypingTarget()) return;
        e.preventDefault();
        toggle();
        return;
      }
      if (!enabled) return;
      if (isTypingTarget()) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (tool === 'text') setTool('rect');
        else setTool(tool === 'rect' ? 'pen' : 'rect');
        return;
      }
      if (k === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setTool(tool === 'text' ? 'pen' : 'text');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelDraft();
        if (!lastSummary) {
          summaryEl.textContent = emptyHint();
          summaryEl.classList.add('empty');
        }
      }
    });

    window.addEventListener('resize', () => {
      if (!enabled) return;
      sizeTrailCanvas();
      drawTrail();
    });

    document.getElementById('cursorCaptionSave').onclick = (e) => {
      e.stopPropagation();
      pendingCaption = (capInput?.value || '').trim();
      if (!pendingCaption) { capInput?.focus(); return; }
      hideCaptionEditor();
      void runCapture('caption');
    };
    document.getElementById('cursorCaptionCancel').onclick = (e) => {
      e.stopPropagation();
      pendingCaption = '';
      hideCaptionEditor();
    };
    capInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.getElementById('cursorCaptionSave').click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        document.getElementById('cursorCaptionCancel').click();
      }
    });

    document.getElementById('cursorCopy').onclick = async () => {
      if (!lastSummary) return;
      try {
        const tr = trailStats();
        const trailBit = tr.path ? `\ntrail(${Math.round(tr.spanMs / 100) / 10}s, ${tr.distancePx}px): ${tr.path}` : '';
        const rectBit = lastRect && tool === 'rect'
          ? `\nrect: ${lastRect.x},${lastRect.y} ${lastRect.w}×${lastRect.h}`
          : '';
        const extra = getContext() || {};
        const tabBit = extra.activeTab ? `\ntab: ${extra.activeTab}` : '';
        const parkedBit = extra.parked?.length ? `\nparked: ${extra.parked.join(', ')}` : '';
        await navigator.clipboard.writeText(
          lastSummary + tabBit + parkedBit + trailBit + rectBit +
          (lastShotUrl ? `\n${location.origin}${lastShotUrl.split('?')[0]}` : '')
        );
        const copyBtn = document.getElementById('cursorCopy');
        copyBtn.textContent = 'ok';
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 900);
      } catch {}
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      toggle();
    };

    // Keep dock/pill clickable above the hit layer
    dock.style.zIndex = '183';
    const pill = document.getElementById('hubCornerPill');
    if (pill) pill.style.zIndex = '184';
    else btn.style.zIndex = '184';
    dock.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    if (pill) pill.addEventListener('pointerdown', (e) => e.stopPropagation());

    updateToolChrome();
    setEnabled(enabled);

    return {
      isEnabled: () => enabled,
      setEnabled,
      toggle,
      getTool: () => tool,
      setTool,
      refreshContext() { /* reserved */ },
    };
  }

  global.HubCursor = { init };
})(typeof window !== 'undefined' ? window : globalThis);
