// slideout.js — the shared slide-out drawer used across the hub.
// One source of truth for the CHROME + BEHAVIOR of a right-edge drawer: a vertical handle,
// hover-the-edge-to-peek, click/hotkey to pin, slide-in panel. Pages supply their own body
// content (WRITING voice tuning, EXECUTE email loops, …). Change the look/feel here and every
// drawer in the hub updates. Zero deps; styles derive from each page's --accent/--line/--ink
// with fallbacks so it looks right in any tab's theme.
(function () {
  if (window.Slideout) return;

  var CSS = [
    '.slideout-edge{position:fixed;top:0;right:0;bottom:0;width:14px;z-index:29;}',
    '.slideout-handle{position:fixed;top:50%;right:0;z-index:30;transform:translateY(-50%);',
    '  writing-mode:vertical-rl;padding:14px 6px;font:700 10.5px Lato,system-ui,sans-serif;letter-spacing:.18em;',
    '  color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);',
    '  border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-right:none;',
    '  border-radius:6px 0 0 6px;cursor:pointer;user-select:none;}',
    '.slideout-handle:hover{background:color-mix(in srgb,var(--accent) 20%,transparent);}',
    '.slideout-panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,92vw);z-index:40;',
    '  background:var(--bg-card,var(--panel,var(--card,#12141d)));border-left:1px solid var(--line);',
    '  box-shadow:-8px 0 30px rgba(0,0,0,.28);transform:translateX(100%);transition:transform .22s ease;',
    '  display:flex;flex-direction:column;}',
    '.slideout-panel.open{transform:translateX(0);}',
    '.slideout-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;',
    '  border-bottom:1px solid var(--line);}',
    '.slideout-title{font:700 13px Lato,system-ui,sans-serif;letter-spacing:.14em;color:var(--accent);}',
    '.slideout-close{background:none;border:none;color:var(--accent);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;}',
    '.slideout-body{flex:1;overflow-y:auto;padding:14px 18px;}',
    '.slideout-grip{position:absolute;left:-6px;top:0;bottom:0;width:12px;cursor:ew-resize;touch-action:none;z-index:2;}',
    '.slideout-grip::after{content:"";position:absolute;left:5px;top:0;bottom:0;width:2px;border-radius:2px;background:transparent;transition:background .15s;}',
    '.slideout-grip:hover::after,.slideout-grip.dragging::after{background:var(--accent);}',
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('slideout-css')) return;
    var s = document.createElement('style');
    s.id = 'slideout-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Attach open/close/pin/hover behavior to a panel (existing or freshly built).
  // opts: { panel, handle, edge, openers:[], closers:[], hotkey, onOpen,
  //         resizable: <localStorage key> — adds a left-edge resize grip with
  //         persisted width (280–640px), same pattern as the Plan panel grip. }
  // Hotkeys: ⌥R (Option-R) toggles every right drawer — the mirror of ⌥E for the
  // left capture drawer. A per-drawer ⌘ hotkey still works as a legacy alias.
  // Neither fires while typing. ⌘I is reserved for theme toggle everywhere.
  // Focus: pinning via click/keyboard moves focus into the panel (first
  // [data-autofocus] or input/button); hover-peeks never steal focus.
  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
    return false;
  }
  function wire(opts) {
    var panel = opts.panel;
    var pinned = false;      // a click / hotkey pins it open; hover is a transient peek
    var closeT = null;
    function isOpen() { return panel.classList.contains('open'); }
    function focusFirst() {
      try {
        var t = panel.querySelector('[data-autofocus]') ||
          panel.querySelector('input, textarea, select, button');
        if (t && typeof t.focus === 'function') t.focus({ preventScroll: true });
      } catch (e) {}
    }
    function open(pin) {
      if (pin) pinned = true;
      clearTimeout(closeT);
      if (!isOpen()) {
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
        if (opts.onOpen) { try { opts.onOpen(); } catch (e) { /* content hook is best-effort */ } }
        // Keyboard/click pins move focus in (post-transition); hover peeks never do.
        if (pin) setTimeout(focusFirst, 240);
      }
    }
    function close() {
      var ae = null;
      try { ae = document.activeElement; } catch (e) {}
      if (ae && panel.contains(ae)) { try { ae.blur(); } catch (e) {} }
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      pinned = false;
    }
    function toggle() { (isOpen() && pinned) ? close() : open(true); }
    function hoverOpen() { clearTimeout(closeT); open(false); }

    if (opts.edge) opts.edge.addEventListener('mouseenter', hoverOpen);
    if (opts.handle) opts.handle.addEventListener('mouseenter', hoverOpen);
    panel.addEventListener('mouseenter', function () { clearTimeout(closeT); });
    panel.addEventListener('mouseleave', function () {
      if (pinned) return;
      clearTimeout(closeT);
      closeT = setTimeout(function () { if (!pinned) close(); }, 220);
    });
    (opts.openers || []).forEach(function (el) { if (el) el.addEventListener('click', function () { toggle(); }); });
    (opts.closers || []).forEach(function (el) { if (el) el.addEventListener('click', close); });
    // Optional persisted resize grip (right drawers only) — same feel as Plan's panel.
    var grip = opts.grip || null;
    if (opts.resizable && !grip) {
      grip = document.createElement('div');
      grip.className = 'slideout-grip';
      grip.title = 'drag to resize';
      panel.insertBefore(grip, panel.firstChild);
    }
    if (grip && opts.resizable) {
      try {
        var savedW = Number(localStorage.getItem(opts.resizable) || 0);
        if (savedW >= 280 && savedW <= 640) panel.style.width = savedW + 'px';
      } catch (e) {}
      grip.addEventListener('mousedown', function (e) {
        e.preventDefault();
        grip.classList.add('dragging');
        var move = function (ev) {
          var w = Math.min(640, Math.max(280, window.innerWidth - ev.clientX));
          panel.style.width = w + 'px';
        };
        var up = function () {
          grip.classList.remove('dragging');
          try {
            var w = parseFloat(panel.style.width) || 0;
            if (w >= 280 && w <= 640) localStorage.setItem(opts.resizable, String(Math.round(w)));
          } catch (err) {}
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }
    if (opts.hotkey || true) {
      addEventListener('keydown', function (e) {
        // ⌥R pins the right drawer (mirror of ⌥E for capture). Uses e.code because
        // macOS Option-R is a dead key (®) — key value varies, code doesn't.
        var isOptR = !!e.altKey && !e.metaKey && !e.ctrlKey &&
          (e.code === 'KeyR' || String(e.key || '').toLowerCase() === 'r');
        if (isOptR) {
          if (isTypingTarget(e.target)) return;
          e.preventDefault(); toggle(); return;
        }
        if (opts.hotkey && (e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === opts.hotkey.toLowerCase()) {
          if (isTypingTarget(e.target)) return;
          e.preventDefault(); toggle();
        }
        else if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); }
      });
    }
    return { panel: panel, open: open, close: close, toggle: toggle, isOpen: isOpen };
  }

  // Wire behavior onto markup a page already has. Adds the shared classes if missing.
  function attach(opts) {
    injectCSS();
    if (opts.panel) opts.panel.classList.add('slideout-panel');
    if (opts.handle) opts.handle.classList.add('slideout-handle');
    if (opts.edge) opts.edge.classList.add('slideout-edge');
    return wire(opts);
  }

  // Build a whole drawer (edge + handle + panel with head/body) and mount it.
  // opts: { title, hotkey, mount, bodyHTML, onOpen, resizable } → returns controls + { body, head, handle }.
  // Pass resizable: '<localStorage key>' for a persisted resize grip.
  function create(opts) {
    injectCSS();
    opts = opts || {};
    var label = opts.title || 'Panel';
    var edge = document.createElement('div'); edge.className = 'slideout-edge'; edge.setAttribute('aria-hidden', 'true');
    var handle = document.createElement('div'); handle.className = 'slideout-handle'; handle.textContent = label;
    handle.title = label + ' (⌥R)' + ' — or hover the right edge';
    var panel = document.createElement('div'); panel.className = 'slideout-panel'; panel.setAttribute('aria-hidden', 'true');
    var head = document.createElement('div'); head.className = 'slideout-head';
    var title = document.createElement('div'); title.className = 'slideout-title'; title.textContent = label;
    var closeBtn = document.createElement('button'); closeBtn.className = 'slideout-close'; closeBtn.type = 'button'; closeBtn.textContent = '✕'; closeBtn.title = 'Close';
    head.appendChild(title); head.appendChild(closeBtn);
    var body = document.createElement('div'); body.className = 'slideout-body';
    if (opts.bodyHTML != null) body.innerHTML = opts.bodyHTML;
    panel.appendChild(head); panel.appendChild(body);
    var mount = opts.mount || document.body;
    mount.appendChild(edge); mount.appendChild(handle); mount.appendChild(panel);
    var ctl = wire({ panel: panel, handle: handle, edge: edge, openers: [handle], closers: [closeBtn], hotkey: opts.hotkey, onOpen: opts.onOpen, resizable: opts.resizable });
    ctl.body = body; ctl.head = head; ctl.handle = handle; ctl.edge = edge;
    return ctl;
  }

  window.Slideout = { attach: attach, create: create };
})();
