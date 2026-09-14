// Shared movable layout tiles — one module, many pages.
// Wire with LayoutSplits.init({ side?, top?, narrow?, onResize? }).
(function (global) {
  const $ = (el) => (typeof el === 'string' ? document.getElementById(el) : el);

  function clamp(n, min, max) {
    return Math.round(Math.max(min, Math.min(max, n)));
  }

  function readCssPx(el, prop, fallback) {
    if (!el) return fallback;
    const n = parseFloat(getComputedStyle(el).getPropertyValue(prop));
    return Number.isFinite(n) ? n : fallback;
  }

  function bindDrag(handle, {
    narrow,
    bodyClass,
    onMove,
    onEnd,
    disabled,
  }) {
    let dragging = false;
    let pointerId = null;

    function move(e) {
      if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
      onMove(e);
    }
    function up(e) {
      if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
      dragging = false;
      pointerId = null;
      document.body.classList.remove(bodyClass);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      onEnd();
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (typeof disabled === 'function' ? disabled() : narrow?.matches) return;
      dragging = true;
      pointerId = e.pointerId;
      document.body.classList.add(bodyClass);
      try { handle.setPointerCapture(e.pointerId); } catch {}
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function bindSide(cfg, narrow) {
    const container = $(cfg.container);
    const handle = $(cfg.handle);
    if (!container || !handle) {
      console.warn('[LayoutSplits] side missing', { container: !!container, handle: !!handle, cfg });
      return null;
    }

    const buf = cfg.buffer ?? 50;
    const cssVar = cfg.cssVar || '--side-w';
    const key = cfg.storageKey;
    const def = cfg.default ?? 300;
    const scrollLockEl = cfg.scrollLock ? $(cfg.scrollLock) : null;
    let lockScroll = null;

    function bounds() {
      const w = container.clientWidth || container.parentElement?.clientWidth || window.innerWidth;
      return { min: buf, max: Math.max(buf, w - buf) };
    }

    function apply(w) {
      const { min, max } = bounds();
      w = clamp(w, min, max);
      container.style.setProperty(cssVar, w + 'px');
      return w;
    }

    const saved = key ? Number(localStorage.getItem(key)) : NaN;
    apply(saved >= buf ? saved : def);

    bindDrag(handle, {
      narrow,
      bodyClass: 'resizing-h',
      disabled: () => narrow.matches,
      onMove(e) {
        apply(e.clientX - container.getBoundingClientRect().left);
        if (scrollLockEl && lockScroll != null) scrollLockEl.scrollLeft = lockScroll;
      },
      onEnd() {
        lockScroll = null;
        if (scrollLockEl) scrollLockEl.style.scrollSnapType = '';
        if (key) localStorage.setItem(key, String(readCssPx(container, cssVar, def)));
      },
    });

    // lock side swipe scroll at pointerdown
    handle.addEventListener('pointerdown', () => {
      if (narrow.matches) return;
      lockScroll = scrollLockEl ? scrollLockEl.scrollLeft : null;
      if (scrollLockEl) scrollLockEl.style.scrollSnapType = 'none';
    });

    return {
      apply,
      clamp() { apply(readCssPx(container, cssVar, def)); },
    };
  }

  function bindTop(cfg, narrow) {
    const stack = $(cfg.stack);
    const scroll = $(cfg.scroll);
    const handle = $(cfg.handle);
    if (!stack || !scroll || !handle) {
      console.warn('[LayoutSplits] top missing', { stack: !!stack, scroll: !!scroll, handle: !!handle, cfg });
      return null;
    }

    const buf = cfg.buffer ?? 50;
    const cssVar = cfg.cssVar || '--top-h';
    const key = cfg.storageKey;
    const def = cfg.default ?? 300;

    function bounds() {
      const h = scroll.clientHeight;
      return { min: buf, max: Math.max(buf, h - buf) };
    }

    function apply(h) {
      const { min, max } = bounds();
      h = clamp(h, min, max);
      stack.style.setProperty(cssVar, h + 'px');
      // also set height directly so it wins even if var specificity fights
      stack.style.height = h + 'px';
      return h;
    }

    const saved = key ? Number(localStorage.getItem(key)) : NaN;
    if (saved >= buf) apply(saved);
    else {
      const natural = cfg.natural == null
        ? Math.min(def, stack.scrollHeight || def)
        : cfg.natural;
      apply(natural);
    }

    bindDrag(handle, {
      narrow,
      bodyClass: 'resizing-v',
      // top split stays usable on narrow — only side is disabled there
      disabled: () => false,
      onMove(e) {
        apply(e.clientY - scroll.getBoundingClientRect().top);
      },
      onEnd() {
        if (key) localStorage.setItem(key, String(readCssPx(stack, cssVar, stack.offsetHeight || def)));
      },
    });

    return {
      apply,
      clamp() { apply(readCssPx(stack, cssVar, stack.offsetHeight || def)); },
    };
  }

  function init(opts = {}) {
    const narrow = window.matchMedia(opts.narrow || '(max-width: 900px)');
    const side = opts.side ? bindSide(opts.side, narrow) : null;
    const top = opts.top ? bindTop(opts.top, narrow) : null;

    function clampAll() {
      side?.clamp();
      top?.clamp();
      if (typeof opts.onResize === 'function') opts.onResize();
    }

    window.addEventListener('resize', clampAll);
    console.log('[LayoutSplits] ready', {
      side: !!side,
      top: !!top,
      narrow: narrow.matches,
    });
    return { side, top, clamp: clampAll };
  }

  global.LayoutSplits = { init };
})(typeof window !== 'undefined' ? window : globalThis);
