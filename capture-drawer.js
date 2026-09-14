// capture-drawer.js — the GLOBAL capture drawer: a left-edge slide-out drawer on every
// main tab (EXECUTE, WRITING, …). Hover the far-left edge to peek, click the CAPTURE
// handle or press ⌥E (Option-E) to pin. ⌘I is reserved for theme toggle everywhere.
// Filter by source chips + text search, then click-to-send
// a capture into Execute (new backlog task with snapshotted context), Writing (new
// inbox idea), or the Plan chat (draft text, ready to send). Click a title for a
// full-height preview slide-out (no new tab). Zero deps; styles derive from each
// page's CSS vars with fallbacks.
// Include once per page: <script src="capture-drawer.js"></script> + CaptureDrawer.attach()
// (IngestDrawer.attach() still works as an alias).
(function () {
  if (window.IngestDrawer) return;

  var CSS = [
    '.ingest-edge{position:fixed;top:0;left:0;bottom:0;width:14px;z-index:29;}',
    '.ingest-handle{position:fixed;top:50%;left:0;z-index:30;transform:translateY(-50%);',
    '  writing-mode:vertical-rl;padding:14px 6px;font:700 10.5px Lato,system-ui,sans-serif;letter-spacing:.18em;',
    '  color:var(--accent,#7dd3fc);background:color-mix(in srgb,var(--accent,#7dd3fc) 12%,transparent);',
    '  border:1px solid color-mix(in srgb,var(--accent,#7dd3fc) 30%,transparent);border-left:none;',
    '  border-radius:0 6px 6px 0;cursor:pointer;user-select:none;-webkit-user-select:none;}',
    '.ingest-handle:hover{background:color-mix(in srgb,var(--accent,#7dd3fc) 20%,transparent);}',
    '.ingest-panel{position:fixed;top:0;left:0;bottom:0;width:min(400px,92vw);z-index:40;',
    '  background:var(--bg-card,var(--panel,var(--card,#12141d)));border-right:1px solid var(--line,#1e293b);',
    '  box-shadow:8px 0 30px rgba(0,0,0,.28);transform:translateX(-100%);transition:transform .22s ease;',
    '  display:flex;flex-direction:column;}',
    '.ingest-panel.open{transform:translateX(0);}',
    '.ingest-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:16px 18px 12px;',
    '  border-bottom:1px solid var(--line,#1e293b);}',
    '.ingest-title{font:700 13px Lato,system-ui,sans-serif;letter-spacing:.14em;color:var(--accent,#7dd3fc);flex:1;min-width:0;}',
    '.ingest-pull{border:1px solid var(--line,#1e293b);background:transparent;color:var(--ink,#e2e8f0);',
    '  border-radius:6px;font:600 11px Lato,system-ui,sans-serif;padding:5px 10px;cursor:pointer;font-family:inherit;white-space:nowrap;}',
    '.ingest-pull:hover:not(:disabled){border-color:var(--accent,#7dd3fc);color:var(--accent,#7dd3fc);}',
    '.ingest-pull:disabled{opacity:.6;cursor:default;}',
    '.ingest-pull-msg{flex:1 1 100%;font-size:11px;color:var(--faint,#64748b);line-height:1.4;}',
    '.ingest-pull-msg:empty{display:none;}',
    '.ingest-pull-msg.err{color:#f87171;}',
    '.ingest-close{background:none;border:none;color:var(--accent,#7dd3fc);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;}',
    '.ingest-filter{padding:12px 18px 6px;border-bottom:1px solid var(--line,#1e293b);}',
    '.ingest-search{width:100%;padding:8px 10px;font:13px Lato,system-ui,sans-serif;',
    '  color:var(--ink,#e2e8f0);background:var(--bg-card,var(--panel,#0b1120));',
    '  border:1px solid var(--line,#1e293b);border-radius:7px;outline:none;}',
    '.ingest-search:focus{border-color:var(--accent,#7dd3fc);}',
    '.ingest-chips{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0 8px;}',
    '.ingest-chip{border:1px solid var(--line,#1e293b);background:transparent;color:var(--dim,#94a3b8);',
    '  border-radius:20px;font:600 11px Lato,system-ui,sans-serif;padding:4px 11px;cursor:pointer;font-family:inherit;}',
    '.ingest-chip.on{border-color:var(--accent,#7dd3fc);color:var(--accent,#7dd3fc);}',
    '.ingest-list{flex:1;overflow-y:auto;padding:12px 18px 24px;display:flex;flex-direction:column;gap:9px;}',
    '.ingest-empty{font-size:12px;color:var(--faint,#64748b);text-align:center;padding:18px 6px;line-height:1.6;}',
    '.ingest-item{border:1px solid var(--line,#1e293b);border-radius:9px;padding:10px 12px;',
    '  background:var(--bg-card,var(--card,#0f172a));}',
    '.ingest-item.has-img{display:flex;gap:10px;}',
    '.it-thumb{width:60px;height:60px;object-fit:cover;border-radius:7px;flex:none;background:var(--chip-bg,rgba(255,255,255,.04));}',
    '.it-body{flex:1;min-width:0;}',
    '.ingest-item .it-top{display:flex;align-items:baseline;gap:8px;}',
    '.ingest-item .it-title{font-size:13px;font-weight:650;color:var(--ink,#e2e8f0);flex:1;min-width:0;',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ingest-item a.it-title{cursor:pointer;text-decoration:none;}',
    '.ingest-item a.it-title:hover{color:var(--accent,#7dd3fc);}',
    '.ingest-item .it-src{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--accent,#7dd3fc);',
    '  border:1px solid var(--line,#1e293b);border-radius:4px;padding:2px 6px;white-space:nowrap;}',
    '.ingest-item .it-prev{font-size:12px;color:var(--dim,#94a3b8);line-height:1.5;margin-top:5px;',
    '  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}',
    '.ingest-item .it-when{font-size:10.5px;color:var(--faint,#64748b);margin-top:5px;}',
    '.ingest-item .it-row{display:flex;gap:7px;margin-top:8px;}',
    '.ingest-item .it-err{font-size:11px;color:#f87171;margin-top:6px;}',
    '.ingest-item .it-err:empty{display:none;}',
    '.ingest-btn{border:1px solid var(--line,#1e293b);background:transparent;color:var(--ink,#e2e8f0);',
    '  border-radius:6px;font:600 11px Lato,system-ui,sans-serif;padding:5px 10px;cursor:pointer;font-family:inherit;}',
    '.ingest-btn:hover:not(:disabled){border-color:var(--accent,#7dd3fc);color:var(--accent,#7dd3fc);}',
    '.ingest-btn:disabled{opacity:.6;cursor:default;}',
    '.ingest-btn.sent{border-color:var(--accent,#7dd3fc);color:var(--accent,#7dd3fc);}',
    '.ingest-preview{position:fixed;top:0;bottom:0;left:min(400px,92vw);width:min(560px,calc(100vw - min(400px,92vw) - 32px));z-index:41;',
    '  background:var(--bg-card,var(--panel,var(--card,#12141d)));border-right:1px solid var(--line,#1e293b);',
    '  box-shadow:8px 0 30px rgba(0,0,0,.28);display:flex;flex-direction:column;',
    '  transform:translateX(-16px);opacity:0;pointer-events:none;transition:transform .2s ease,opacity .2s ease;}',
    '.ingest-preview.open{transform:none;opacity:1;pointer-events:auto;}',
    '.ingest-prev-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--line,#1e293b);}',
    '.ingest-prev-title{font:700 14px Lato,system-ui,sans-serif;color:var(--ink,#e2e8f0);flex:1;min-width:0;line-height:1.4;}',
    '.ingest-prev-meta{font-size:11px;color:var(--faint,#64748b);margin-top:4px;}',
    '.ingest-prev-x{background:none;border:none;color:var(--accent,#7dd3fc);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;}',
    '.ingest-prev-open{font-size:15px;color:var(--dim,#94a3b8);text-decoration:none;white-space:nowrap;padding-top:1px;}',
    '.ingest-prev-open:hover{color:var(--accent,#7dd3fc);}',
    '.ingest-prev-body{flex:1;overflow-y:auto;padding:14px 18px 24px;font-size:13px;line-height:1.6;color:var(--ink,#e2e8f0);}',
    '.ingest-prev-body img{max-width:100%;border-radius:8px;margin:8px 0;}',
    '.ingest-prev-body h1,.ingest-prev-body h2,.ingest-prev-body h3{font-size:13.5px;margin:14px 0 6px;color:var(--ink,#e2e8f0);}',
    '.ingest-prev-body p{margin:8px 0;}',
    '.ingest-prev-body ul{margin:8px 0;padding-left:20px;}',
    '.ingest-prev-body li{margin:3px 0;}',
    '.ingest-prev-body blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--accent,#7dd3fc);color:var(--dim,#94a3b8);}',
    '.ingest-prev-body hr{border:none;border-top:1px solid var(--line,#1e293b);margin:12px 0;}',
    '.ingest-prev-shot{width:100%;border-radius:10px;margin:4px 0 8px;}',
    '.ingest-chat{display:flex;flex-direction:column;padding:2px 0 8px;}',
    '.ingest-chat-sub{text-align:center;font-size:11px;color:var(--faint,#64748b);margin:0 0 6px;}',
    '.ingest-chat-day{align-self:center;font-size:10.5px;color:var(--faint,#64748b);',
    '  border:1px solid var(--line,#1e293b);border-radius:12px;padding:2px 11px;margin:12px 0 4px;}',
    '.ingest-bub{max-width:85%;padding:7px 11px;border-radius:17px;line-height:1.45;font-size:13px;',
    '  overflow-wrap:anywhere;margin-top:2px;color:var(--ink,#e2e8f0);}',
    '.ingest-bub.grp{margin-top:9px;}',
    '.ingest-bub.me{align-self:flex-end;background:#007aff;color:#fff;border-bottom-right-radius:6px;}',
    '.ingest-bub.them{align-self:flex-start;background:rgba(127,127,127,.20);border-bottom-left-radius:6px;}',
    '.ingest-bub .who{font-size:10.5px;font-weight:700;opacity:.65;margin-bottom:2px;}',
    '.ingest-bub.me .who{display:none;}',
    '.ingest-bub .ts{display:block;font-size:9.5px;opacity:.6;margin-top:2px;text-align:right;}',
    '.ingest-bub img.cimg,.ingest-bub video.cvid{max-width:210px;width:100%;border-radius:11px;margin:5px 0;display:block;}',
    '.ingest-bub audio.caud{width:200px;margin-top:6px;}',
    '.ingest-bub .filepill{font-size:11.5px;opacity:.85;margin-top:4px;}',
    '.ingest-prev-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center;padding:12px 18px;border-top:1px solid var(--line,#1e293b);}',
    '.ingest-prev-out{margin:12px 0 4px;padding:12px;border:1px solid var(--line,#1e293b);border-radius:8px;}',
    '.ingest-prev-out textarea{width:100%;min-height:64px;box-sizing:border-box;background:var(--bg-card,var(--panel,#0b1120));color:var(--ink,#e2e8f0);border:1px solid var(--line,#1e293b);border-radius:7px;padding:8px 10px;font:13px Lato,system-ui,sans-serif;margin:8px 0;}',
    '.ingest-prev-why{font-size:12px;color:var(--dim,#94a3b8);line-height:1.5;}',
    '.ingest-prev-msg{font-size:11.5px;color:var(--accent,#7dd3fc);}',
    '@media (max-width:700px){.ingest-preview{left:0;width:100vw;}}',
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('ingest-drawer-css')) return;
    var s = document.createElement('style');
    s.id = 'ingest-drawer-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function timeAgo(v) {
    var t = v ? Date.parse(v) : NaN;
    if (!Number.isFinite(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
    return false;
  }

  function attach() {
    injectCSS();

    var edge = document.createElement('div');
    edge.className = 'ingest-edge';
    edge.setAttribute('aria-hidden', 'true');
    var handle = document.createElement('div');
    handle.className = 'ingest-handle';
    handle.textContent = 'CAPTURE';
    handle.title = 'Capture (⌥E) — or hover the left edge';
    var panel = document.createElement('div');
    panel.className = 'ingest-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML =
      '<div class="ingest-head"><div class="ingest-title">CAPTURE</div>' +
      '<button type="button" class="ingest-pull" title="Notes, screenshots, email, iMessage (Photos stays pick-first)">Pull from all</button>' +
      '<button type="button" class="ingest-close" title="Close">✕</button>' +
      '<div class="ingest-pull-msg"></div></div>' +
      '<div class="ingest-filter"><input type="text" class="ingest-search" placeholder="Filter captures…" />' +
      '<div class="ingest-chips"></div></div>' +
      '<div class="ingest-list"><div class="ingest-empty">loading…</div></div>';
    document.body.appendChild(edge);
    document.body.appendChild(handle);
    document.body.appendChild(panel);
    // full-height preview slide-out, docked to the drawer's right edge
    var preview = document.createElement('div');
    preview.className = 'ingest-preview';
    preview.setAttribute('aria-hidden', 'true');
    document.body.appendChild(preview);
    var previewId = null;
    preview.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closePreview(); }
    });

    var closeBtn = panel.querySelector('.ingest-close');
    var pullBtn = panel.querySelector('.ingest-pull');
    var pullMsg = panel.querySelector('.ingest-pull-msg');
    var search = panel.querySelector('.ingest-search');
    var chips = panel.querySelector('.ingest-chips');
    var list = panel.querySelector('.ingest-list');

    var items = [];
    var activeSource = 'all';
    var query = '';
    var pinned = false;
    var closeT = null;
    var loading = null;   // in-flight /api/ingest promise (dedupes open + poll overlap)
    var sentMap = {};     // "id>dest" -> true, so refresh keeps ✓ states
    var pollT = null;

    function isOpen() { return panel.classList.contains('open'); }
    function open(pin) {
      if (pin) pinned = true;
      clearTimeout(closeT);
      if (!isOpen()) {
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
        // Pinning via click/keyboard moves focus to search (post-transition);
        // hover peeks never steal focus.
        if (pin) setTimeout(function () { try { search.focus({ preventScroll: true }); } catch (e) {} }, 240);
      }
      load(); // every open revalidates — new captures land here live
      startPoll();
    }
    function close() {
      var ae = null;
      try { ae = document.activeElement; } catch (e) {}
      if (ae && panel.contains(ae)) { try { ae.blur(); } catch (err) {} }
      closePreview();
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      pinned = false;
    }
    function toggle() { (isOpen() && pinned) ? close() : open(true); }

    edge.addEventListener('mouseenter', function () { clearTimeout(closeT); open(false); });
    handle.addEventListener('mouseenter', function () { clearTimeout(closeT); open(false); });
    handle.addEventListener('click', toggle);
    closeBtn.addEventListener('click', close);
    pullBtn.addEventListener('click', async function () {
      pullBtn.disabled = true;
      pullMsg.classList.remove('err');
      pullMsg.textContent = 'Pulling notes, screenshots, email, iMessage…';
      try {
        var r = await fetch('/api/ingest/pull-all', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || ('pull-all ' + r.status));
        var bits = [];
        if (j.notes && j.notes.ok) bits.push('notes +' + (j.notes.imported || 0));
        if (j.screenshots && j.screenshots.ok) bits.push('screenshots +' + (j.screenshots.imported || 0));
        if (j.email && j.email.ok) bits.push('email +' + (j.email.imported || 0));
        if (j.imessage && j.imessage.ok) bits.push('imessage ' + (j.imessage.rewritten || 0) + ' chats');
        ['notes', 'screenshots', 'email', 'imessage'].forEach(function (k) {
          if (j[k] && !j[k].ok) bits.push(k + ': ' + j[k].error);
        });
        pullMsg.textContent = bits.join(' · ') || 'nothing new';
        await load();
      } catch (e) {
        pullMsg.classList.add('err');
        pullMsg.textContent = String((e && e.message) || e);
      } finally {
        pullBtn.disabled = false;
      }
    });
    panel.addEventListener('mouseenter', function () { clearTimeout(closeT); });
    panel.addEventListener('mouseleave', function () {
      if (pinned || previewOpen()) return;
      clearTimeout(closeT);
      closeT = setTimeout(function () { if (!pinned && !previewOpen()) close(); }, 220);
    });
    addEventListener('keydown', function (e) {
      // ⌥E (Option-E) pins the capture drawer. ⌘I is reserved for theme toggle.
      var isOptE = !!e.altKey && !e.metaKey && !e.ctrlKey &&
        (e.code === 'KeyE' || String(e.key || '').toLowerCase() === 'e');
      if (isOptE) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && previewOpen()) {
        e.stopPropagation();
        closePreview();
      } else if (e.key === 'Escape' && isOpen()) {
        e.stopPropagation();
        close();
      }
    });

    async function load() {
      if (loading) { try { await loading; } catch (e) {} return; }
      var keepScroll = list.scrollTop;
      var first = !items.length;
      if (first) list.innerHTML = '<div class="ingest-empty">loading…</div>';
      loading = (async function () {
        var r = await fetch('/api/ingest');
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        items = Array.isArray(j.items) ? j.items : [];
        renderChips();
        render();
        list.scrollTop = keepScroll;
      })();
      try { await loading; }
      catch (e) {
        if (first) list.innerHTML = '<div class="ingest-empty">' + esc(String((e && e.message) || e)) + '</div>';
      }
      finally { loading = null; }
    }
    // poll while the drawer is open so new captures appear live; idle otherwise
    function startPoll() {
      if (pollT) return;
      pollT = setInterval(function () {
        if (!isOpen() || document.hidden) return;
        load();
      }, 15000);
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && isOpen()) load();
    });

    function sources() {
      var seen = {};
      var out = [];
      items.forEach(function (it) {
        var s = String(it.source || 'voice');
        if (!seen[s]) { seen[s] = true; out.push(s); }
      });
      out.sort();
      return out;
    }

    function renderChips() {
      chips.innerHTML = '';
      ['all'].concat(sources()).forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ingest-chip' + (activeSource === s ? ' on' : '');
        b.textContent = s === 'all' ? 'All' : s;
        b.onclick = function () { activeSource = s; renderChips(); render(); };
        chips.appendChild(b);
      });
    }

    function filtered() {
      var q = query.trim().toLowerCase();
      return items.filter(function (it) {
        if (activeSource !== 'all' && String(it.source || 'voice') !== activeSource) return false;
        if (q && (String(it.title || '') + ' ' + String(it.preview || '')).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }

    function render() {
      var rows = filtered();
      list.innerHTML = '';
      if (!rows.length) {
        list.innerHTML = '<div class="ingest-empty">' +
          (items.length ? 'Nothing matches this filter.' : 'No captures yet.') + '</div>';
        return;
      }
      rows.slice(0, 80).forEach(function (it) {
        var el = document.createElement('div');
        el.className = 'ingest-item' + (it.image ? ' has-img' : '');
        if (it.image) {
          var thumb = document.createElement('img');
          thumb.className = 'it-thumb';
          thumb.alt = '';
          thumb.loading = 'lazy';
          thumb.src = '/api/ingest/media?id=' + encodeURIComponent(it.id);
          el.appendChild(thumb);
        }
        var body = document.createElement('div');
        body.className = 'it-body';
        el.appendChild(body);
        var title = document.createElement('a');
        title.className = 'it-title';
        title.textContent = it.title || it.id;
        title.href = '#';
        title.title = 'Preview the full capture';
        title.onclick = function (e) { e.preventDefault(); openPreview(it.id); };
        var top = document.createElement('div');
        top.className = 'it-top';
        top.appendChild(title);
        var badge = document.createElement('span');
        badge.className = 'it-src';
        badge.textContent = it.source || 'voice';
        top.appendChild(badge);
        body.appendChild(top);
        if (it.preview) {
          var prev = document.createElement('div');
          prev.className = 'it-prev';
          prev.textContent = it.preview;
          body.appendChild(prev);
        }
        var when = document.createElement('div');
        when.className = 'it-when';
        when.textContent = timeAgo(it.created);
        body.appendChild(when);
        var row = document.createElement('div');
        row.className = 'it-row';
        var toExec = document.createElement('button');
        toExec.type = 'button';
        toExec.className = 'ingest-btn';
        toExec.textContent = '→ Execute';
        toExec.title = 'Create a backlog task from this capture';
        toExec.onclick = function () { sendToExecute(it, toExec, errEl); };
        if (sentMap[String(it.id) + '>execute']) preSent(toExec, 'in Execute');
        var toWrite = document.createElement('button');
        toWrite.type = 'button';
        toWrite.className = 'ingest-btn';
        toWrite.textContent = '→ Writing';
        toWrite.title = 'Route this capture into Writing as an inbox idea';
        toWrite.onclick = function () { sendToWriting(it, toWrite, errEl); };
        if (sentMap[String(it.id) + '>writing']) preSent(toWrite, 'in Writing');
        var toAgent = document.createElement('button');
        toAgent.type = 'button';
        toAgent.className = 'ingest-btn';
        toAgent.textContent = 'To Plan →';
        toAgent.title = 'Drop this capture into Plan, ready to send';
        toAgent.onclick = function () { sendToAgent(it, toAgent, errEl); };
        if (sentMap[String(it.id) + '>agent']) preSent(toAgent, 'in Plan');
        row.appendChild(toExec);
        row.appendChild(toWrite);
        row.appendChild(toAgent);
        body.appendChild(row);
        var errEl = document.createElement('div');
        errEl.className = 'it-err';
        body.appendChild(errEl);
        list.appendChild(el);
      });
      if (rows.length > 80) {
        var cap = document.createElement('div');
        cap.className = 'ingest-empty';
        cap.textContent = 'Showing 80 of ' + rows.length + ' — refine the filter to see more.';
        list.appendChild(cap);
      }
    }

    function markSent(btn, label, it, dest) {
      btn.disabled = true;
      btn.classList.add('sent');
      btn.textContent = '✓ ' + label;
      if (it && dest) sentMap[String(it.id) + '>' + dest] = true;
    }
    function preSent(btn, label) {
      btn.disabled = true;
      btn.classList.add('sent');
      btn.textContent = '✓ ' + label;
    }

    function notify(dest, id) {
      try {
        document.dispatchEvent(new CustomEvent('ingestdrawer:sent', { detail: { dest: dest, id: id } }));
      } catch (e) { /* older webviews — ignore */ }
      // Best-effort live refresh on pages that expose a board loader.
      try { if (typeof window.load === 'function' && dest === 'execute') window.load(); } catch (e) {}
    }

    async function sendToExecute(it, btn, errEl) {
      errEl.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        var r = await fetch('/api/execute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceIngestId: it.id }),
        });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        markSent(btn, 'in Execute', it, 'execute');
        notify('execute', it.id);
      } catch (e) {
        errEl.textContent = String((e && e.message) || e);
        btn.disabled = false;
        btn.textContent = '→ Execute';
      }
    }

    async function sendToWriting(it, btn, errEl) {
      errEl.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        var r = await fetch('/api/writing/route', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ingestId: it.id }),
        });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        markSent(btn, 'in Writing', it, 'writing');
        notify('writing', it.id);
      } catch (e) {
        errEl.textContent = String((e && e.message) || e);
        btn.disabled = false;
        btn.textContent = '→ Writing';
      }
    }

    // Relevant context only: strip the storage wrapper (frontmatter ids/dates/tags,
    // title heading, image refs to files the agent can't see, rules) and the
    // machine-exhaust "Raw capture" section (mouse telemetry, filenames, or text
    // that duplicates the body). Falls back to the raw section when the body is
    // empty after cleaning.
    function cleanCaptureText(md, title) {
      var t = String(md || '');
      t = t.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
      var parts = t.split(/^[ \t]*#{1,6}[ \t]*Raw capture[ \t]*$/m);
      var raw = parts.slice(1).join('\n');
      function plain(s) {
        var out = [];
        String(s || '').split('\n').forEach(function (ln) {
          var l = ln.replace(/[ \t]+$/, '');
          if (/^\s*!\[.*?\]\(.*?\)\s*$/.test(l)) return; // image ref, not visible to the agent
          if (/^\s*-{3,}\s*$/.test(l)) return;           // horizontal rule
          l = l.replace(/^\s{0,3}#{1,6}\s+/, '');        // heading -> text
          l = l.replace(/^\s*>\s?/, '');                 // quote -> text
          l = l.replace(/\*\*([^*]+)\*\*/g, '$1');       // bold -> text
          if (!l.trim()) { out.push(''); return; }
          out.push(l);
        });
        return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
      }
      var body = plain(parts[0] || '');
      // body opens with the title heading — the draft already carries the title
      if (title) {
        var first = body.split('\n')[0] || '';
        if (first.trim().toLowerCase() === String(title).trim().toLowerCase()) {
          body = body.split('\n').slice(1).join('\n').replace(/^\n+/, '');
        }
      }
      if (body.trim().length >= 40) return body;
      var fallback = plain(raw);
      return fallback || body;
    }

    // To Plan — drop the full capture into the Plan chat, ready to send.
    // Same handoff the Writing drawer uses: localStorage + plan.html consumes it.
    // If the capture has an image, fetch + downscale it and ride it along as
    // `live-chat-image` so the Plan turn carries the actual picture, not just text.
    // Already on Plan? Fill #chatIn in place instead of navigating.
    function downscaleImage(blob) {
      return new Promise(function (resolve) {
        var url = null;
        try { url = URL.createObjectURL(blob); } catch (e) { resolve(null); return; }
        var img = new Image();
        img.onload = function () {
          try {
            var max = 1024, w = img.naturalWidth || 1, h = img.naturalHeight || 1;
            var s = Math.min(1, max / Math.max(w, h));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(w * s));
            c.height = Math.max(1, Math.round(h * s));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', 0.8));
          } catch (e) { resolve(null); }
          try { URL.revokeObjectURL(url); } catch (e2) {}
        };
        img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} resolve(null); };
        img.src = url;
      });
    }
    async function sendToAgent(it, btn, errEl) {
      errEl.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        var r = await fetch('/api/ingest/item?id=' + encodeURIComponent(it.id));
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        var md = String(j.markdown || j.body || it.preview || '').trim();
        if (!md) throw new Error('Capture is empty.');
        var context = cleanCaptureText(md, it.title || '');
        if (context.length > 4000) context = context.slice(0, 4000) + '\n…(truncated)';
        var draft = '[from Ingest · ' + (it.source || 'voice') + '] ' + (it.title || it.id) + ' (id: ' + it.id + ')\n\n' + context;
        // attach the capture image itself when there is one (best effort — text still sends)
        var imageData = null;
        if (j.imageUrl) {
          try {
            var ir = await fetch(j.imageUrl);
            if (ir.ok) imageData = await downscaleImage(await ir.blob());
          } catch (e) {}
        }
        if (imageData) draft += '\n📎 image attached';
        var handoff = function () {
          try {
            localStorage.setItem('live-chat-draft',
              JSON.stringify({ text: draft, ts: Date.now() }));
            if (imageData) {
              localStorage.setItem('live-chat-image',
                JSON.stringify({ dataUrl: imageData, ts: Date.now() }));
            } else {
              localStorage.removeItem('live-chat-image');
            }
          } catch (e) {}
        };
        if (/live\.html$/.test(location.pathname)) {
          handoff();
          // same-tab: storage events don't fire locally, so consume directly
          if (typeof window.consumeChatDraft === 'function') window.consumeChatDraft();
          else {
            var inp = document.querySelector('#chatIn');
            if (!inp) throw new Error('Plan chat not found on this page.');
            inp.value = draft;
            inp.focus();
          }
          markSent(btn, 'in Plan', it, 'agent');
          notify('agent', it.id);
        } else {
          handoff();
          markSent(btn, 'in Plan', it, 'agent');
          location.href = '/plan.html';
        }
      } catch (e) {
        errEl.textContent = String((e && e.message) || e);
        btn.disabled = false;
        btn.textContent = 'To Plan →';
      }
    }

    var searchT = null;
    search.addEventListener('input', function () {
      clearTimeout(searchT);
      searchT = setTimeout(function () { query = search.value; render(); }, 120);
    });
    // Don't let drawer keystrokes trigger page-level nav shortcuts (but let Esc bubble to close).
    panel.addEventListener('keydown', function (e) { if (e.key !== 'Escape') e.stopPropagation(); });

    // ---- full-height preview: the whole capture, no new tab ----
    function previewOpen() { return preview.classList.contains('open'); }
    function closePreview() {
      previewId = null;
      preview.classList.remove('open');
      preview.setAttribute('aria-hidden', 'true');
      // peek mode: mouse is already off the drawer (it's on the preview), so
      // re-arm the auto-close now that the preview is gone
      if (!pinned && isOpen() && !panel.matches(':hover') &&
          !handle.matches(':hover') && !edge.matches(':hover')) {
        clearTimeout(closeT);
        closeT = setTimeout(function () { if (!pinned && !previewOpen()) close(); }, 220);
      }
    }
    function wirePrevClose() {
      var x = preview.querySelector('.ingest-prev-x');
      if (x) x.onclick = closePreview;
    }
    // tiny markdown -> html (headings, lists, quotes, bold, images)
    function mdHtml(md, imageBaseId) {
      var lines = String(md == null ? '' : md).replace(/^---[\s\S]*?---\n/, '').split('\n');
      var html = '', inList = false;
      function mediaUrl(src) {
        var s = String(src || '').trim();
        if (/^https?:\/\//i.test(s) || s.indexOf('/api/') === 0) return s;
        if (imageBaseId) return '/api/ingest/media?id=' + encodeURIComponent(imageBaseId);
        return s;
      }
      function inline(s) {
        return esc(s)
          .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_, alt, src) {
            return '<img alt="' + esc(alt) + '" src="' + esc(mediaUrl(src)) + '" />';
          })
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      }
      lines.forEach(function (raw) {
        var l = raw.replace(/\s+$/, '');
        var imgOnly = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(l);
        if (imgOnly) {
          if (inList) { html += '</ul>'; inList = false; }
          if (imageBaseId) return; // the dedicated shot above covers it
          html += '<img alt="' + esc(imgOnly[1]) + '" src="' + esc(mediaUrl(imgOnly[2])) + '" />';
          return;
        }
        if (/^- /.test(l)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(l.slice(2)) + '</li>'; return; }
        if (inList) { html += '</ul>'; inList = false; }
        if (/^### /.test(l)) html += '<h3>' + inline(l.slice(4)) + '</h3>';
        else if (/^## /.test(l)) html += '<h2>' + inline(l.slice(3)) + '</h2>';
        else if (/^# /.test(l)) html += '<h1>' + inline(l.slice(2)) + '</h1>';
        else if (/^> /.test(l)) html += '<blockquote>' + inline(l.slice(2)) + '</blockquote>';
        else if (/^---$/.test(l)) html += '<hr>';
        else if (l.trim()) html += '<p>' + inline(l) + '</p>';
      });
      if (inList) html += '</ul>';
      return html;
    }
    // iMessage digest -> chat bubbles. Mirrors the ingest page renderer; the
    // preview head already shows the title, so only the message-count line tops it.
    // Media lines: image `![](url)`, video `clapper + [label](url)`,
    // audio `speaker + [label](url)`, file `clip + label`.
    var CHAT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var CHAT_VID = new RegExp('^\\u{1F3AC} \\[(.+?)\\]\\((\\/api[^)]+)\\)$');
    var CHAT_AUD = new RegExp('^\\u{1F50A} \\[(.+?)\\]\\((\\/api[^)]+)\\)$');
    var CHAT_FILE = new RegExp('^\\u{1F4CE} (.+)$');
    function chatShortTime(t) {
      var m = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(t || '');
      if (!m) return t || '';
      return Number(m[1]) + ':' + m[2] + ' ' + m[3].toUpperCase();
    }
    function chatDayLabel(t) {
      var m = /(\d{1,2})\/(\d{1,2})/.exec(t || '');
      if (!m) return t || '';
      return (CHAT_MON[Number(m[1]) - 1] || m[1]) + ' ' + Number(m[2]);
    }
    function chatHtml(md) {
      var body = String(md == null ? '' : md).replace(/^---[\s\S]*?---\n/, '');
      var msgs = [];
      var mLine = /^\[(.+?)\]\s+(.*?):(.*)$/;
      var mImg = /^!\[([^\]]*)\]\((\/api\/[^)]+)\)$/;
      body.split('\n').forEach(function (raw) {
        var l = raw.replace(/\s+$/, '');
        if (/^#\s+/.test(l)) return;
        var m = mLine.exec(l);
        if (m) { msgs.push({ time: m[1].trim(), who: m[2].trim(), text: (m[3] || '').trim(), atts: [] }); return; }
        if (!msgs.length || !l) return;
        var last = msgs[msgs.length - 1];
        var im = mImg.exec(l);
        if (im) { last.atts.push({ t: 'img', url: im[2], label: im[1] }); return; }
        var v = CHAT_VID.exec(l);
        if (v) { last.atts.push({ t: 'vid', url: v[2], label: v[1] }); return; }
        var a = CHAT_AUD.exec(l);
        if (a) { last.atts.push({ t: 'aud', url: a[2], label: a[1] }); return; }
        var f = CHAT_FILE.exec(l);
        if (f) { last.atts.push({ t: 'file', url: null, label: f[1] }); return; }
        last.text += (last.text ? '\n' : '') + l;
      });
      var html = '<div class="ingest-chat"><div class="ingest-chat-sub">iMessage · ' + msgs.length +
        ' message' + (msgs.length === 1 ? '' : 's') + '</div>';
      var lastDay = null, lastWho = null;
      msgs.forEach(function (g) {
        var day = (g.time || '').split(',')[0];
        if (day && day !== lastDay) {
          html += '<div class="ingest-chat-day">' + esc(chatDayLabel(g.time)) + '</div>';
          lastDay = day; lastWho = null;
        }
        var mine = /^me$/i.test(g.who);
        var grouped = lastWho === (mine ? 'me' : g.who);
        html += '<div class="ingest-bub ' + (mine ? 'me' : 'them') + (grouped ? '' : ' grp') + '">';
        if (!mine && !grouped) html += '<div class="who">' + esc(g.who) + '</div>';
        if (g.text) html += '<div class="txt">' + esc(g.text).replace(/\n/g, '<br>') + '</div>';
        g.atts.forEach(function (at) {
          if (at.t === 'img') html += '<img class="cimg" alt="' + esc(at.label || 'image') + '" src="' + esc(at.url) + '" loading="lazy" />';
          else if (at.t === 'vid') html += '<video class="cvid" controls preload="metadata" src="' + esc(at.url) + '"></video>';
          else if (at.t === 'aud') html += '<audio class="caud" controls preload="metadata" src="' + esc(at.url) + '"></audio>';
          else html += '<div class="filepill">\u{1F4CE} ' + esc(at.label) + '</div>';
        });
        html += '<span class="ts">' + esc(chatShortTime(g.time)) + '</span></div>';
        lastWho = mine ? 'me' : g.who;
      });
      return html + '</div>';
    }
    function openPreview(id) {
      previewId = id;
      preview.classList.add('open');
      preview.setAttribute('aria-hidden', 'false');
      preview.innerHTML = '<div class="ingest-prev-body"><div class="ingest-empty">loading…</div></div>';
      fetch('/api/ingest/item?id=' + encodeURIComponent(id))
        .then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
        })
        .then(function (res) {
          if (previewId !== id) return;
          if (!res.ok) throw new Error((res.j && res.j.error) || ('HTTP ' + res.status));
          renderPreview(id, res.j);
        })
        .catch(function (e) {
          if (previewId !== id) return;
          preview.innerHTML =
            '<div class="ingest-prev-head"><div class="ingest-prev-title">Preview failed</div>' +
            '<button type="button" class="ingest-prev-x" title="Close preview">✕</button></div>' +
            '<div class="ingest-prev-body"><div class="ingest-empty">' + esc(String((e && e.message) || e)) + '</div></div>';
          wirePrevClose();
        });
    }
    function renderPreview(id, j) {
      var meta = (j && j.meta) || {};
      var title = meta.title || id;
      var it = { id: id, title: title, source: meta.source };
      var when = [meta.created || '', meta.source || ''].filter(function (s) { return s; }).join(' · ');
      var shot = j.imageUrl
        ? '<img class="ingest-prev-shot" alt="screenshot" src="' + esc(j.imageUrl) + '" />' : '';
      var isChat = meta.source === 'imessage';
      preview.innerHTML =
        '<div class="ingest-prev-head"><div style="flex:1;min-width:0;">' +
          '<div class="ingest-prev-title">' + esc(title) + '</div>' +
          (when ? '<div class="ingest-prev-meta">' + esc(when) + '</div>' : '') +
        '</div>' +
        '<a class="ingest-prev-open" href="/capture.html?id=' + encodeURIComponent(id) + '" target="_blank" rel="noopener" title="Open the full page">↗</a>' +
        '<button type="button" class="ingest-prev-x" title="Close preview">✕</button></div>' +
        '<div class="ingest-prev-body">' + shot + (isChat ? chatHtml(j.markdown || '') : mdHtml(j.markdown || '', j.imageUrl ? id : null)) +
          '<div class="ingest-prev-out" hidden></div></div>' +
        '<div class="ingest-prev-actions">' +
          '<button type="button" class="ingest-btn" data-act="exec">→ Execute</button>' +
          '<button type="button" class="ingest-btn" data-act="write">→ Writing</button>' +
          '<button type="button" class="ingest-btn" data-act="agent">To Plan →</button>' +
          '<button type="button" class="ingest-btn" data-act="enh">Enhance</button>' +
          '<button type="button" class="ingest-btn" data-act="del">Delete</button>' +
          '<span class="ingest-prev-msg"></span></div>' +
        '<div class="it-err" style="padding:0 18px 12px;"></div>';
      wirePrevClose();
      var msg = preview.querySelector('.ingest-prev-msg');
      var errEl = preview.querySelector('.it-err');
      function act(sel) { return preview.querySelector('[data-act="' + sel + '"]'); }
      if (sentMap[id + '>execute']) preSent(act('exec'), 'in Execute');
      if (sentMap[id + '>writing']) preSent(act('write'), 'in Writing');
      if (sentMap[id + '>agent']) preSent(act('agent'), 'in Plan');
      act('exec').onclick = function () { sendToExecute(it, act('exec'), errEl); };
      act('write').onclick = function () { sendToWriting(it, act('write'), errEl); };
      act('agent').onclick = function () { sendToAgent(it, act('agent'), errEl); };
      act('enh').onclick = function () {
        previewEnhance(id, title, act('enh'), preview.querySelector('.ingest-prev-out'));
      };
      act('del').onclick = function () { previewDelete(id, title, act('del'), msg); };
    }
    async function previewEnhance(id, title, btn, mount) {
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = 'Enhancing…';
      try {
        var r = await fetch('/api/ingest/enhance?id=' + encodeURIComponent(id), { method: 'POST' });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        mount.hidden = false;
        mount.innerHTML =
          (j.why ? '<div class="ingest-prev-why">' + esc(j.why) + '</div>' : '') +
          '<textarea>' + esc(j.outcome || '') + '</textarea>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<button type="button" class="ingest-btn">Add to backlog</button>' +
            '<span class="ingest-prev-msg"></span></div>';
        var ta = mount.querySelector('textarea');
        var add = mount.querySelector('button');
        var m2 = mount.querySelector('.ingest-prev-msg');
        add.onclick = async function () {
          add.disabled = true;
          try {
            var r2 = await fetch('/api/execute', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: title, outcome: ta.value, sourceIngestId: id }),
            });
            var j2 = await r2.json().catch(function () { return {}; });
            if (!r2.ok) throw new Error(j2.error || ('HTTP ' + r2.status));
            m2.textContent = '→ in Execute backlog';
            notify('execute', id);
          } catch (e) { m2.textContent = String((e && e.message) || e); add.disabled = false; }
        };
        if (ta) ta.focus();
      } catch (e) {
        mount.hidden = false;
        mount.innerHTML = '<div class="ingest-prev-why" style="color:#f87171">' +
          esc(String((e && e.message) || e)) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    }
    async function previewDelete(id, title, btn, msg) {
      if (!confirm('Delete "' + title + '"?')) return;
      btn.disabled = true;
      try {
        var r = await fetch('/api/ingest/item?id=' + encodeURIComponent(id), { method: 'DELETE' });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        closePreview();
        load();
      } catch (e) {
        msg.textContent = String((e && e.message) || e);
        btn.disabled = false;
      }
    }

    return {
      open: open, close: close, toggle: toggle,
      isOpen: isOpen, refresh: function () { load(); },
    };
  }

  window.IngestDrawer = window.CaptureDrawer = { attach: attach };
})();
