// Cynos Annotate overlay — injected into the tools-managed browser page.
//
// Codex-style visual review, page-first interaction:
//   1. The page stays fully interactive by default. A prominent "开始标注"
//      button enters annotation mode; "完成" leaves it at any time.
//   2. Annotation mode (region default): drag a rectangle, type a comment.
//      Element mode: click an HTML element for selector-level context.
//   3. Bottom bar holds the overall context + "一起发送" (send all) which
//      serializes every note through window.__cynosAnnotateEvent.
//
// Session semantics (v4):
//   - Screenshots are captured at NOTE-CREATION time: the overlay hides its
//     shapes, awaits the note-added binding (server screenshots the region /
//     element), then restores the UI. Crops are always what the user saw.
//   - SPA navigation (URL change) auto-stashes the current page's notes into
//     stashedPages and clears them from the page — no stale boxes. Stashed
//     pages ride along in the next submit payload.
//   - Submit does NOT tear the overlay down. Notes are cleared, the panel
//     stays, and the user can keep annotating; the host forwards further
//     submits to the conversation automatically. "✕" closes the overlay for
//     good; "取消" just clears unsent notes.
//
// Everything renders inside a shadow root (style-isolated from the page).
// Public API on window.__cynosAnnotate:
//   { install, state, teardown, restoreStash, version }.
// This file is imported with a `?raw` suffix and evaluated via page.evaluate.

(function () {
  "use strict";

  var VERSION = 4;
  var MAX_NOTES = 100;
  var MIN_REGION_SIZE = 4;
  var TEXT_LIMITS = { selector: 1000, comment: 2000, textPreview: 300, attrValue: 200, attrCount: 40, styleCount: 30 };

  if (window.__cynosAnnotate) {
    try { window.__cynosAnnotate.teardown(); } catch (e) { /* ignore */ }
  }

  // ---------- UI strings (zh default; install({ uiLang: "en" }) switches) ----------
  var STRINGS = {
    zh: {
      title: "标注",
      start: "开始标注",
      stop: "完成标注",
      startTitle: "进入标注模式：在页面上拖出区域或点击元素",
      stopTitle: "退出标注模式，恢复正常操作页面（已添加的批注保留）",
      hide: "收起",
      hideTitle: "收起面板（Esc 切换）",
      close: "✕",
      closeTitle: "关闭标注并移除页面组件（之后需重新运行 /annotate）",
      pill: "标注",
      pillTitle: "打开标注面板",
      region: "▭ 区域",
      regionTitle: "拖出矩形区域并输入批注",
      element: "⚙ 元素",
      elementTitle: "点击 HTML 元素进行标注（附带选择器上下文）",
      contextLabel: "整体需求（要让 agent 修什么？）",
      contextPh: "例如：修复定价卡片的间距",
      clear: "清空",
      clearTitle: "清空未发送的批注（组件保留，可继续标注）",
      cancel: "取消",
      sendAll: "一起发送",
      footHint: "Esc 收起 · Ctrl+Enter 发送 · 切换页面会自动暂存本页批注",
      hintIdle: "点击「开始标注」后在页面上拖出矩形区域（或切换到元素模式点击元素）。",
      hintOn: "在页面上拖拽一个矩形区域，然后输入批注。",
      hintElement: "标注中——点击任意元素添加批注。",
      popPh: "这个区域要改什么？",
      del: "删除",
      save: "保存",
      popHint: "Enter 保存 · Shift+Enter 换行 · Esc 取消",
      limitToast: "已达批注上限（" + MAX_NOTES + "）",
      regionLabel: "区域",
      commentPh: "这个区域的批注",
      centerPrefix: "元素：",
      elemPh: "这里要改什么？",
      parentBtn: "↑父元素",
      parentTitle: "把这条批注移到父元素",
      removeNote: "删除此批注",
      removeRegion: "删除此区域",
      regionClickEdit: "点击编辑",
      elementBadge: "（元素）",
      scrollTitle: "点击滚动到视野",
      sentToast: "已发送 {N} 条批注 ✓ 可继续标注、切换页面，再次发送会自动送达",
      stashToast: "已暂存本页 {N} 条批注（随下一次发送一起提交）",
      clearedToast: "已清空未发送的批注",
      dropPage: "丢弃此页的暂存批注",
    },
    en: {
      title: "Annotate",
      start: "Start annotating",
      stop: "Done annotating",
      startTitle: "Enter annotation mode: drag regions or click elements on the page",
      stopTitle: "Leave annotation mode and interact with the page normally (notes are kept)",
      hide: "Hide",
      hideTitle: "Hide panel (Esc toggles)",
      close: "✕",
      closeTitle: "Close annotate and remove the overlay (rerun /annotate to start again)",
      pill: "Annotate",
      pillTitle: "Open the annotation panel",
      region: "▭ Region",
      regionTitle: "Drag a rectangle, then type a comment",
      element: "⚙ Element",
      elementTitle: "Click an HTML element to annotate it (adds selector context for the agent)",
      contextLabel: "Overall context (what should the agent fix?)",
      contextPh: "e.g. Fix spacing on the pricing cards",
      clear: "Clear",
      clearTitle: "Clear unsent notes (overlay stays, keep annotating)",
      cancel: "Cancel",
      sendAll: "Send all",
      footHint: "Esc hide · Ctrl+Enter send · switching pages auto-stashes this page's notes",
      hintIdle: "Click「Start annotating」, then drag a rectangle on the page (or switch to element mode).",
      hintOn: "Drag a rectangle on the page, then type a comment.",
      hintElement: "Annotating — click any element to add a note.",
      popPh: "What should change in this area?",
      del: "Delete",
      save: "Save",
      popHint: "Enter save · Shift+Enter newline · Esc cancel",
      limitToast: "Note limit reached (" + MAX_NOTES + ")",
      regionLabel: "Region",
      commentPh: "Comment for this region",
      centerPrefix: "element: ",
      elemPh: "What should change here?",
      parentBtn: "↑parent",
      parentTitle: "Re-target this note to the parent element",
      removeNote: "Remove note",
      removeRegion: "Remove region",
      regionClickEdit: "click to edit",
      elementBadge: " (element)",
      scrollTitle: "Click to scroll into view",
      sentToast: "Sent {N} note(s) ✓ keep annotating or switch pages — the next send is delivered too",
      stashToast: "Stashed {N} note(s) from this page (included in the next send)",
      clearedToast: "Cleared unsent notes",
      dropPage: "Drop this stashed page",
    },
  };
  var LANG = "zh";
  function t(k) { return (STRINGS[LANG] && STRINGS[LANG][k]) || STRINGS.zh[k] || k; }

  // ---------- state ----------
  var host = null, root = null, shadow = null;
  var els = {};
  var regions = [];        // { n, doc:{x,y,w,h}, comment, center }
  var elements = [];       // { n, el, comment, data }
  var stashedPages = [];   // { url, title, notes: serialized[] } — pages left via SPA navigation
  var lastUrl = null;      // navigation detection (sweep compares location.href)
  var lastTitle = "";
  var nextNoteId = 1;
  var mode = "region";     // "region" | "element" (active annotation kind)
  var annotating = false;  // Codex-style toggle: page is interactive when false
  var sweepTimer = null;
  var drag = null;         // { startX, startY }
  var popover = null;      // open comment editor
  var hoverEl = null;
  var noteLimitToastUntil = 0;
  var lastActivity = Date.now(); // any interaction extends the server-side deadline

  function teardown() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", scheduleUpdate, true);
    window.removeEventListener("scroll", scheduleUpdate, true);
    window.removeEventListener("pagehide", onPageHide);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; root = null; shadow = null; els = {};
    regions = []; elements = []; stashedPages = [];
    drag = null; popover = null; hoverEl = null;
    try { delete window.__cynosAnnotate; } catch (e) { window.__cynosAnnotate = undefined; }
  }

  // ---------- host binding ----------
  // Single event channel to the host. Fire-and-forget for most events;
  // "note-added" awaits the returned promise so the server can screenshot
  // before the overlay shapes are shown again.
  function sendEvent(payload) {
    var send = window.__cynosAnnotateEvent;
    if (typeof send === "function") {
      try { return send(payload); } catch (e) { return null; }
    }
    return null;
  }

  // Hide shapes (boxes/badges), let the host capture the crop, then restore.
  function captureNoteSnapshot(note) {
    var prev = els.shapes ? els.shapes.style.display : "";
    if (els.shapes) els.shapes.style.display = "none";
    var p = sendEvent({ type: "note-added", url: location.href, title: document.title, note: note });
    var done = (p && typeof p.then === "function")
      ? Promise.race([p, new Promise(function (res) { setTimeout(res, 4000); })])
      : Promise.resolve();
    return done.then(
      function () { if (els.shapes) els.shapes.style.display = prev; },
      function () { if (els.shapes) els.shapes.style.display = prev; }
    );
  }

  // ---------- helpers ----------
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, "\\$1");
  }

  function nthOfType(el) {
    var tag = el.tagName, i = 0, node = el;
    while ((node = node.previousElementSibling)) if (node.tagName === tag) i++;
    return i;
  }

  function segFor(el, withNth) {
    var s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + cssEscape(el.id);
    var cls = Array.prototype.slice.call(el.classList || []).slice(0, 3).map(cssEscape);
    if (cls.length) s += "." + cls.join(".");
    if (withNth) s += ":nth-of-type(" + (nthOfType(el) + 1) + ")";
    return s;
  }

  function buildSelector(el) {
    var candidates = [];
    if (el.id) candidates.push("#" + cssEscape(el.id));
    var dt = el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy"));
    if (dt) candidates.push("[data-testid=" + JSON.stringify(dt) + "]");

    var chain = [];
    var node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      chain.unshift(node);
      if (node === document.documentElement) break;
      node = node.parentElement; depth++;
    }
    for (var i = 0; i < chain.length; i++) {
      var parts = [];
      for (var j = i; j < chain.length; j++) parts.push(segFor(chain[j], j > i));
      candidates.push(parts.join(" > "));
    }
    for (var k = 0; k < candidates.length; k++) {
      try {
        var matches = document.querySelectorAll(candidates[k]);
        if (matches.length === 1 && matches[0] === el) return candidates[k];
      } catch (e) { /* invalid selector, skip */ }
    }
    var full = [];
    for (var m = 0; m < chain.length; m++) full.push(segFor(chain[m], true));
    return full.join(" > ");
  }

  function nthFor(el, selector) {
    try {
      var all = document.querySelectorAll(selector);
      return Array.prototype.indexOf.call(all, el);
    } catch (e) { return 0; }
  }

  function compactLengths(s) {
    var v = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft];
    var px = v.map(function (x) { return String(x || "0px").replace(/px$/, ""); });
    var uniq = px.filter(function (x, i) { return px.indexOf(x) === i; });
    return uniq.length === 1 ? uniq[0] : (px[0] === px[2] && px[1] === px[3] ? px[0] + " " + px[1] : px.join(" "));
  }

  function implicitRole(el) {
    var t = el.tagName.toLowerCase();
    if (t === "button") return "button";
    if (t === "a" && el.getAttribute("href") != null) return "link";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "img") return "img";
    if (t === "table") return "table";
    if (t === "ul" || t === "ol") return "list";
    if (t === "li") return "listitem";
    if (t === "label") return "label";
    if (t === "form") return "form";
    if (/^h[1-6]$/.test(t)) return "heading";
    if (t === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    if (t === "nav") return "navigation";
    if (t === "main") return "main";
    if (t === "header") return "banner";
    if (t === "footer") return "contentinfo";
    if (t === "aside") return "complementary";
    return null;
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var data = {
      selector: buildSelector(el),
      nth: 0,
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: Array.prototype.slice.call(el.classList || []).slice(0, 10),
      textPreview: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, TEXT_LIMITS.textPreview) || undefined,
      comment: undefined,
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
        docX: Math.round(rect.x + window.scrollX), docY: Math.round(rect.y + window.scrollY),
      },
      box: null,
      styles: {},
      attributes: {},
      a11y: {},
    };
    data.nth = nthFor(el, data.selector);

    var cs = null;
    try { cs = getComputedStyle(el); } catch (e) { /* svg/odd nodes */ }
    if (cs) {
      data.box = {
        padding: compactLengths({ paddingTop: cs.paddingTop, paddingRight: cs.paddingRight, paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft }),
        border: compactLengths({ paddingTop: cs.borderTopWidth, paddingRight: cs.borderRightWidth, paddingBottom: cs.borderBottomWidth, paddingLeft: cs.borderLeftWidth }),
        margin: compactLengths({ paddingTop: cs.marginTop, paddingRight: cs.marginRight, paddingBottom: cs.marginBottom, paddingLeft: cs.marginLeft }),
      };
      var styleKeys = ["display", "position", "overflow", "zIndex", "opacity", "color", "backgroundColor",
        "fontFamily", "fontSize", "fontWeight", "lineHeight", "textAlign", "borderRadius", "boxShadow"];
      for (var i = 0; i < styleKeys.length; i++) {
        var v = cs[styleKeys[i]];
        if (v) data.styles[styleKeys[i]] = String(v).slice(0, TEXT_LIMITS.attrValue);
      }
    }

    try {
      var attrs = el.attributes;
      for (var a = 0; a < attrs.length && a < TEXT_LIMITS.attrCount; a++) {
        data.attributes[attrs[a].name] = String(attrs[a].value).slice(0, TEXT_LIMITS.attrValue);
      }
    } catch (e) { /* ignore */ }

    var role = el.getAttribute && el.getAttribute("role") || implicitRole(el);
    if (role) data.a11y.role = role;
    var name = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title")))
      || data.textPreview;
    if (name) data.a11y.name = String(name).slice(0, 120);
    var focusable = false;
    try {
      var ti = el.getAttribute && el.getAttribute("tabindex");
      focusable = (ti != null && ti !== "-1") || (el.matches && el.matches("a[href],button,input,select,textarea,[contenteditable]"));
    } catch (e) { /* ignore */ }
    if (focusable) data.a11y.focusable = true;
    if (el.disabled === true || (el.getAttribute && el.getAttribute("aria-disabled") === "true")) data.a11y.disabled = true;
    var stateAttrs = ["aria-expanded", "aria-pressed", "aria-checked", "aria-selected", "aria-invalid", "required"];
    for (var st = 0; st < stateAttrs.length; st++) {
      var sv = el.getAttribute && el.getAttribute(stateAttrs[st]);
      if (sv != null) data.a11y[stateAttrs[st]] = sv;
    }
    return data;
  }

  // Lightweight element context for the center of a drawn region.
  function describeCenter(clientX, clientY) {
    var el = null;
    try {
      var top = document.elementFromPoint(clientX, clientY);
      el = top && !isOwnUi(top) ? top : null;
    } catch (e) { el = null; }
    if (!el) return null;
    var d = describe(el);
    return {
      selector: d.selector, nth: d.nth, tag: d.tag, id: d.id,
      classes: d.classes, textPreview: d.textPreview,
    };
  }

  function totalNotes() { return regions.length + elements.length; }
  function stashedNotesCount() {
    return stashedPages.reduce(function (s, p) { return s + p.notes.length; }, 0);
  }
  function pendingCount() { return totalNotes() + stashedNotesCount(); }

  function markActivity() { lastActivity = Date.now(); }

  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.style.display = "block";
    setTimeout(function () { els.toast.style.display = "none"; }, 2600);
  }

  function noteLimitReached() {
    if (pendingCount() >= MAX_NOTES) {
      if (Date.now() > noteLimitToastUntil) {
        noteLimitToastUntil = Date.now() + 2500;
        toast(t("limitToast"));
      }
      return true;
    }
    return false;
  }

  function isOwnUi(node) {
    var p = node;
    while (p) { if (p === host) return true; p = p.parentNode || p.host || null; }
    return false;
  }

  // ---------- rendering ----------
  var CSS_TEXT = [
    ":host { all: initial; }",
    "* { box-sizing: border-box; font: 12px/1.45 -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }",
    "#ca-layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }",
    "#ca-layer.picking.region-mode { cursor: crosshair; }",
    "#ca-highlight { position: absolute; display: none; border: 2px solid #f59e0b; background: rgba(245,158,11,.12); border-radius: 2px; }",
    "#ca-highlight .ca-tag { position: absolute; top: -18px; left: -2px; background: #f59e0b; color: #111; padding: 1px 6px; border-radius: 3px 3px 0 0; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }",
    ".ca-rubber { position: absolute; display: none; border: 1.5px dashed #2563eb; background: rgba(37,99,235,.12); }",
    ".ca-region { position: absolute; border: 1.5px solid #2563eb; background: rgba(37,99,235,.06); border-radius: 2px; pointer-events: auto; cursor: pointer; }",
    ".ca-badge { position: absolute; transform: translate(0, -50%); min-width: 18px; height: 18px; border-radius: 9px; background: #2563eb; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; padding: 0 5px; box-shadow: 0 1px 3px rgba(0,0,0,.4); pointer-events: auto; border: 1px solid #fff; }",
    ".ca-badge.element { transform: translate(-50%, -50%); cursor: pointer; }",
    ".ca-badge.missing { background: #9ca3af; }",
    ".ca-pop { position: absolute; width: 240px; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 8px; pointer-events: auto; }",
    ".ca-pop textarea { width: 100%; min-height: 44px; background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 5px 7px; resize: vertical; }",
    ".ca-pop .ca-pop-btns { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }",
    ".ca-pop .ca-hintk { color: #6b7280; font-size: 10px; margin-top: 4px; }",
    "#ca-panel { position: fixed; top: 12px; right: 12px; width: 300px; max-height: calc(100vh - 24px); display: flex; flex-direction: column; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.5); pointer-events: auto; }",
    "#ca-panel.hidden { display: none; }",
    ".ca-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #374151; }",
    ".ca-head .ca-title { font-weight: 700; font-size: 12px; flex: 1; }",
    ".ca-head .ca-count { background: #2563eb; border-radius: 8px; padding: 0 7px; font-size: 11px; font-weight: 700; }",
    ".ca-btn { background: #374151; color: #e5e7eb; border: 0; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 11px; }",
    ".ca-btn:hover { background: #4b5563; }",
    ".ca-btn.primary { background: #2563eb; font-weight: 700; }",
    ".ca-btn.primary:hover { background: #1d4ed8; }",
    ".ca-btn.start { background: #059669; font-weight: 700; padding: 7px 10px; font-size: 12.5px; width: 100%; }",
    ".ca-btn.start:hover { background: #047857; }",
    ".ca-btn.stop { background: #b45309; font-weight: 700; padding: 7px 10px; font-size: 12.5px; width: 100%; }",
    ".ca-btn.stop:hover { background: #92400e; }",
    ".ca-btn.active { background: #2563eb; }",
    ".ca-mode { display: flex; gap: 6px; padding: 8px 10px 0; }",
    ".ca-mode .ca-btn { flex: 1; }",
    ".ca-toggle { padding: 8px 10px 0; }",
    ".ca-body { overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; min-height: 40px; }",
    ".ca-context { padding: 8px 10px 0; }",
    ".ca-context textarea { width: 100%; min-height: 34px; background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 5px 7px; resize: vertical; }",
    ".ca-context .ca-label { color: #9ca3af; font-size: 11px; margin-bottom: 2px; display: block; }",
    ".ca-stash-row { display: flex; align-items: center; gap: 6px; background: #0f172a; border: 1px dashed #374151; border-radius: 6px; padding: 4px 6px; }",
    ".ca-stash-row .ca-stash-label { flex: 1; color: #93c5fd; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".ca-note { background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 6px 8px; }",
    ".ca-note .ca-note-head { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }",
    ".ca-note .ca-note-head .ca-num { background: #2563eb; color: #fff; border-radius: 8px; min-width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; padding: 0 5px; }",
    ".ca-note .ca-note-head .ca-sel { flex: 1; color: #93c5fd; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }",
    ".ca-note textarea { width: 100%; min-height: 28px; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 4px 6px; resize: vertical; font-size: 12px; }",
    ".ca-note .ca-meta { color: #6b7280; font-size: 10.5px; margin-top: 3px; }",
    ".ca-sendbar { border-top: 1px solid #374151; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }",
    ".ca-sendbar .ca-send-row { display: flex; gap: 6px; align-items: center; }",
    ".ca-sendbar .ca-hint { flex: 1; color: #6b7280; font-size: 10px; }",
    ".ca-sendall { flex: 1; background: #2563eb; color: #fff; font-weight: 700; font-size: 13px; border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; }",
    ".ca-sendall:hover { background: #1d4ed8; }",
    "#ca-pill { position: fixed; bottom: 14px; right: 14px; z-index: 2147483646; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer; pointer-events: auto; box-shadow: 0 6px 18px rgba(0,0,0,.45); display: none; }",
    "#ca-pill .ca-pill-count { color: #93c5fd; }",
    "#ca-toast { position: fixed; bottom: 52px; left: 50%; transform: translateX(-50%); background: #111827; color: #fbbf24; border: 1px solid #374151; padding: 6px 12px; border-radius: 8px; display: none; pointer-events: auto; max-width: 80vw; }",
  ].join("\n");

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildUi() {
    host = document.createElement("div");
    host.id = "cynos-annotate-host";
    root = document.createElement("div");
    root.id = "ca-layer";
    shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);
    shadow.appendChild(root);
    document.documentElement.appendChild(host);

    els.highlight = el("div");
    els.highlight.id = "ca-highlight";
    els.highlight.appendChild(el("div", "ca-tag"));
    root.appendChild(els.highlight);

    els.rubber = el("div", "ca-rubber");
    root.appendChild(els.rubber);

    els.shapes = el("div");
    root.appendChild(els.shapes);
    els.badges = [];

    els.toast = el("div");
    els.toast.id = "ca-toast";
    root.appendChild(els.toast);

    var panel = el("div");
    panel.id = "ca-panel";
    root.appendChild(panel);
    els.panel = panel;

    var head = el("div", "ca-head");
    head.appendChild(el("span", "ca-title", t("title")));
    els.count = el("span", "ca-count", "0");
    head.appendChild(els.count);
    var hideBtn = el("button", "ca-btn", t("hide"));
    hideBtn.title = t("hideTitle");
    hideBtn.addEventListener("click", function () { setPanelHidden(true); });
    head.appendChild(hideBtn);
    var closeBtn = el("button", "ca-btn", t("close"));
    closeBtn.title = t("closeTitle");
    closeBtn.addEventListener("click", closeAll);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // Primary trigger: page stays interactive until this is pressed.
    var toggleWrap = el("div", "ca-toggle");
    els.toggleBtn = el("button", "ca-btn start", t("start"));
    els.toggleBtn.title = t("startTitle");
    els.toggleBtn.addEventListener("click", toggleAnnotating);
    toggleWrap.appendChild(els.toggleBtn);
    panel.appendChild(toggleWrap);

    els.modeRow = el("div", "ca-mode");
    els.regionBtn = el("button", "ca-btn active", t("region"));
    els.regionBtn.title = t("regionTitle");
    els.regionBtn.addEventListener("click", function () { setMode("region"); });
    els.modeRow.appendChild(els.regionBtn);
    els.elementBtn = el("button", "ca-btn", t("element"));
    els.elementBtn.title = t("elementTitle");
    els.elementBtn.addEventListener("click", function () { setMode("element"); });
    els.modeRow.appendChild(els.elementBtn);
    panel.appendChild(els.modeRow);

    var body = el("div", "ca-body");
    panel.appendChild(body);
    els.body = body;
    els.cards = el("div");
    els.cards.style.display = "flex";
    els.cards.style.flexDirection = "column";
    els.cards.style.gap = "8px";
    body.appendChild(els.cards);

    // Bottom bar: overall context + send-all.
    var sendbar = el("div", "ca-sendbar");
    var ctxWrap = el("div", "ca-context");
    ctxWrap.style.padding = "0";
    ctxWrap.appendChild(el("span", "ca-label", t("contextLabel")));
    els.context = document.createElement("textarea");
    els.context.placeholder = t("contextPh");
    ctxWrap.appendChild(els.context);
    sendbar.appendChild(ctxWrap);
    var sendRow = el("div", "ca-send-row");
    var clearBtn = el("button", "ca-btn", t("clear"));
    clearBtn.title = t("clearTitle");
    clearBtn.addEventListener("click", function () {
      regions = []; elements = []; stashedPages = []; els.context.value = "";
      sendEvent({ type: "page-stash", pages: stashedPages });
      renderCards(); updateShapes();
    });
    sendRow.appendChild(clearBtn);
    var cancelBtn = el("button", "ca-btn", t("cancel"));
    cancelBtn.title = t("clearTitle");
    cancelBtn.addEventListener("click", cancel);
    sendRow.appendChild(cancelBtn);
    els.sendAllBtn = el("button", "ca-sendall", t("sendAll") + " (0)");
    els.sendAllBtn.addEventListener("click", submit);
    sendRow.appendChild(els.sendAllBtn);
    sendbar.appendChild(sendRow);
    sendbar.appendChild(el("div", "ca-hint", t("footHint")));
    panel.appendChild(sendbar);

    // Collapsed pill to bring the panel back.
    els.pill = el("button");
    els.pill.id = "ca-pill";
    els.pill.title = t("pillTitle");
    els.pill.addEventListener("click", function () { setPanelHidden(false); });
    root.appendChild(els.pill);

    renderCards();
    setMode("region");
    setAnnotating(false);
  }

  function setPanelHidden(hidden) {
    els.panel.classList.toggle("hidden", hidden);
    els.pill.style.display = hidden ? "block" : "none";
    updatePill();
  }

  function updatePill() {
    if (!els.pill) return;
    els.pill.textContent = "";
    els.pill.appendChild(document.createTextNode(t("pill") + " "));
    var c = el("span", "ca-pill-count", "(" + pendingCount() + ")");
    els.pill.appendChild(c);
  }

  // Codex-style trigger: page is interactive until the user starts annotating.
  function toggleAnnotating() { setAnnotating(!annotating); }

  function setAnnotating(on) {
    annotating = on;
    closePopover(false);
    els.toggleBtn.textContent = on ? t("stop") : t("start");
    els.toggleBtn.title = on ? t("stopTitle") : t("startTitle");
    els.toggleBtn.classList.toggle("stop", on);
    els.toggleBtn.classList.toggle("start", !on);
    els.modeRow.style.display = on ? "flex" : "none";
    root.classList.toggle("picking", on);
    root.classList.toggle("region-mode", on && mode === "region");
    if (!on) { hoverEl = null; els.highlight.style.display = "none"; }
    renderCards();
  }

  function setMode(next) {
    closePopover(false);
    mode = next;
    els.regionBtn.classList.toggle("active", mode === "region");
    els.elementBtn.classList.toggle("active", mode === "element");
    root.classList.toggle("region-mode", annotating && mode === "region");
    if (mode !== "element") { hoverEl = null; els.highlight.style.display = "none"; }
    renderCards();
  }

  // ---------- shapes (regions + element badges) ----------
  function updateShapes() {
    while (els.shapes.firstChild) els.shapes.removeChild(els.shapes.firstChild);
    els.badges = [];
    regions.forEach(function (r) { addRegionShape(r); });
    elements.forEach(function (e) { addElementBadge(e); });
    positionShapes();
    updatePill();
  }

  function addRegionShape(r) {
    var box = el("div", "ca-region");
    box.title = r.comment ? "#" + r.n + ": " + r.comment : "#" + r.n + " — " + t("regionClickEdit");
    box.addEventListener("click", function (ev) {
      ev.stopPropagation();
      openPopover(r, box);
    });
    els.shapes.appendChild(box);
    var badge = el("div", "ca-badge", String(r.n));
    badge.addEventListener("click", function (ev) { ev.stopPropagation(); openPopover(r, box); });
    els.shapes.appendChild(badge);
    els.badges.push({ kind: "region", note: r, box: box, badge: badge });
  }

  function addElementBadge(e) {
    var badge = el("div", "ca-badge element", String(e.n));
    badge.title = e.comment ? "#" + e.n + ": " + e.comment : "#" + e.n + t("elementBadge");
    badge.addEventListener("click", function (ev) {
      ev.stopPropagation();
      try {
        e.el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (err) { /* ignore */ }
    });
    els.shapes.appendChild(badge);
    els.badges.push({ kind: "element", note: e, badge: badge });
  }

  function positionShapes() {
    var sx = window.scrollX, sy = window.scrollY;
    for (var i = 0; i < els.badges.length; i++) {
      var b = els.badges[i];
      if (b.kind === "region") {
        b.box.style.left = (b.note.doc.x - sx) + "px";
        b.box.style.top = (b.note.doc.y - sy) + "px";
        b.box.style.width = b.note.doc.w + "px";
        b.box.style.height = b.note.doc.h + "px";
        b.badge.style.left = (b.note.doc.x - sx) + "px";
        b.badge.style.top = (b.note.doc.y - sy) + "px";
      } else {
        var rect = null;
        try { rect = b.note.el.isConnected ? b.note.el.getBoundingClientRect() : null; } catch (e) { rect = null; }
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          b.badge.classList.add("missing");
          b.badge.style.left = "-100px"; b.badge.style.top = "-100px";
          continue;
        }
        b.badge.classList.remove("missing");
        b.badge.style.left = (rect.left + Math.min(rect.width / 2, 24)) + "px";
        b.badge.style.top = rect.top + "px";
      }
    }
    if (els.highlight.style.display !== "none") {
      var r = null;
      try { r = hoverEl && hoverEl.isConnected ? hoverEl.getBoundingClientRect() : null; } catch (e) { r = null; }
      if (r) placeHighlight(r); else els.highlight.style.display = "none";
    }
  }

  function placeHighlight(rect) {
    var hl = els.highlight;
    hl.style.display = "block";
    hl.style.left = rect.left + "px";
    hl.style.top = rect.top + "px";
    hl.style.width = rect.width + "px";
    hl.style.height = rect.height + "px";
    hl.firstChild.textContent = hoverEl && hoverEl.tagName
      ? hoverEl.tagName.toLowerCase() + (hoverEl.id ? "#" + hoverEl.id : "") + (hoverEl.classList.length ? "." + Array.prototype.join.call(hoverEl.classList, ".") : "")
      : "";
  }

  // ---------- comment popover ----------
  function closePopover(save) {
    if (!popover) return;
    var p = popover;
    popover = null;
    if (save && p.textarea) p.onSave(p.textarea.value);
    if (p.node.parentNode) p.node.parentNode.removeChild(p.node);
  }

  function openPopover(note, anchorBox) {
    closePopover(false);
    markActivity();
    var node = el("div", "ca-pop");
    var ta = document.createElement("textarea");
    ta.value = note.comment || "";
    ta.placeholder = t("popPh");
    node.appendChild(ta);
    var btns = el("div", "ca-pop-btns");
    var delBtn = el("button", "ca-btn", t("del"));
    delBtn.addEventListener("click", function () {
      regions = regions.filter(function (x) { return x !== note; });
      closePopover(false);
      renderCards(); updateShapes();
    });
    btns.appendChild(delBtn);
    var cancelBtn = el("button", "ca-btn", t("cancel"));
    cancelBtn.addEventListener("click", function () { closePopover(false); });
    btns.appendChild(cancelBtn);
    var okBtn = el("button", "ca-btn primary", t("save"));
    okBtn.addEventListener("click", function () { closePopover(true); });
    btns.appendChild(okBtn);
    node.appendChild(btns);
    node.appendChild(el("div", "ca-hintk", t("popHint")));
    root.appendChild(node);

    var boxRect = anchorBox.getBoundingClientRect();
    var left = Math.min(Math.max(8, boxRect.left), window.innerWidth - 256);
    var top = boxRect.top + boxRect.height + 6;
    if (top + 140 > window.innerHeight) top = Math.max(8, boxRect.top - 146);
    node.style.left = left + "px";
    node.style.top = top + "px";

    popover = {
      node: node,
      textarea: ta,
      note: note,
      onSave: function (value) {
        note.comment = String(value || "").slice(0, TEXT_LIMITS.comment);
        renderCards();
      },
    };
    ta.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); closePopover(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closePopover(false); }
    });
    ta.focus();
  }

  // ---------- picking ----------
  function onPointerDown(e) {
    markActivity();
    if (!annotating || mode !== "region") return;
    if (isOwnUi(e.target) || e.button !== 0) return;
    if (popover && !popover.node.contains(e.target)) closePopover(true);
    closePopover(false);
    drag = { startX: e.clientX, startY: e.clientY };
    els.rubber.style.display = "block";
    els.rubber.style.left = e.clientX + "px";
    els.rubber.style.top = e.clientY + "px";
    els.rubber.style.width = "0px";
    els.rubber.style.height = "0px";
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    if (!annotating) return;
    markActivity();
    if (mode === "element") {
      if (isOwnUi(e.target)) { els.highlight.style.display = "none"; hoverEl = null; return; }
      hoverEl = e.target;
      try { placeHighlight(hoverEl.getBoundingClientRect()); } catch (err) { els.highlight.style.display = "none"; }
      return;
    }
    if (drag) {
      var x = Math.min(drag.startX, e.clientX);
      var y = Math.min(drag.startY, e.clientY);
      var w = Math.abs(e.clientX - drag.startX);
      var h = Math.abs(e.clientY - drag.startY);
      els.rubber.style.left = x + "px";
      els.rubber.style.top = y + "px";
      els.rubber.style.width = w + "px";
      els.rubber.style.height = h + "px";
    }
  }

  function onPointerUp(e) {
    markActivity();
    if (!annotating || mode !== "region" || !drag) return;
    var startX = drag.startX, startY = drag.startY;
    drag = null;
    els.rubber.style.display = "none";
    var x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
    var w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
    if (w < MIN_REGION_SIZE || h < MIN_REGION_SIZE) return;
    if (noteLimitReached()) return;

    var region = {
      n: nextNoteId++,
      doc: {
        x: Math.round(x + window.scrollX), y: Math.round(y + window.scrollY),
        w: Math.round(w), h: Math.round(h),
      },
      comment: "",
      center: describeCenter(x + w / 2, y + h / 2),
    };
    regions.push(region);
    renderCards();
    updateShapes();
    var shape = els.badges.find(function (b) { return b.kind === "region" && b.note === region; });
    // Screenshot the crop first (host hides shapes while capturing), then edit.
    captureNoteSnapshot(serializeRegionNote(region)).then(function () {
      var liveShape = els.badges.find(function (b) { return b.kind === "region" && b.note === region; });
      if (liveShape) openPopover(region, liveShape.box);
    });
  }

  function onClickCapture(e) {
    if (!annotating || mode !== "element") return;
    if (isOwnUi(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.target && e.target.nodeType === 1) addElementNote(e.target);
  }

  // ---------- element notes ----------
  function addElementNote(target) {
    if (noteLimitReached()) return;
    var note = { n: nextNoteId++, el: target, comment: "", data: describe(target) };
    elements.push(note);
    renderCards();
    updateShapes();
    captureNoteSnapshot(serializeElementNote(note, true));
  }

  // ---------- serialization ----------
  function serializeRegionNote(r) {
    return {
      n: r.n,
      kind: "region",
      comment: r.comment ? r.comment.slice(0, TEXT_LIMITS.comment) : undefined,
      rect: {
        x: 0, y: 0, width: r.doc.w, height: r.doc.h,
        docX: r.doc.x, docY: r.doc.y, docWidth: r.doc.w, docHeight: r.doc.h,
      },
      center: r.center || undefined,
    };
  }

  // live=true re-describes connected elements (submit time, current page);
  // live=false uses the data captured at creation (stash/pagehide time).
  function serializeElementNote(eNote, live) {
    var d = eNote.data;
    var removed;
    if (live) {
      var liveData = null;
      try { liveData = eNote.el && eNote.el.isConnected ? describe(eNote.el) : null; } catch (err) { liveData = null; }
      if (liveData) d = liveData;
      else removed = true;
    }
    return {
      n: eNote.n,
      kind: "element",
      selector: d.selector,
      nth: d.nth,
      tag: d.tag,
      id: d.id,
      classes: d.classes,
      textPreview: d.textPreview,
      comment: eNote.comment ? eNote.comment.slice(0, TEXT_LIMITS.comment) : undefined,
      removed: removed || undefined,
      rect: d.rect,
      box: d.box,
      styles: d.styles,
      attributes: d.attributes,
      a11y: d.a11y,
    };
  }

  function serializeCurrentNotes(live) {
    var out = [];
    regions.forEach(function (r) { out.push(serializeRegionNote(r)); });
    elements.forEach(function (eNote) { out.push(serializeElementNote(eNote, live)); });
    out.sort(function (a, b) { return a.n - b.n; });
    return out;
  }

  // ---------- page switching (SPA) ----------
  function stashCurrentPage() {
    var prevUrl = lastUrl, prevTitle = lastTitle;
    lastUrl = location.href;
    lastTitle = document.title;
    closePopover(false);
    els.rubber.style.display = "none";
    var notes = serializeCurrentNotes(false);
    regions = []; elements = [];
    if (notes.length > 0) {
      stashedPages.push({ url: String(prevUrl || ""), title: String(prevTitle || ""), notes: notes });
      sendEvent({ type: "page-stash", pages: stashedPages });
      toast(t("stashToast").replace("{N}", String(notes.length)));
    }
    renderCards();
    updateShapes();
  }

  // Best-effort: flush notes to the host before a hard navigation unloads us.
  function onPageHide() {
    var pages = stashedPages.map(function (p) { return { url: p.url, title: p.title, notes: p.notes }; });
    var notes = serializeCurrentNotes(false);
    if (notes.length > 0) pages.push({ url: String(lastUrl || location.href), title: String(lastTitle || document.title), notes: notes });
    var any = pages.some(function (p) { return p.notes.length > 0; });
    if (any) sendEvent({ type: "page-stash", pages: pages });
  }

  // ---------- cards ----------
  function describeMeta(d) {
    var parts = [];
    if (d.rect && d.rect.width != null) parts.push(d.rect.width + "×" + d.rect.height);
    if (d.box && d.box.padding && d.box.padding !== "0") parts.push("pad " + d.box.padding);
    if (d.a11y && d.a11y.role) parts.push("role=" + d.a11y.role);
    return parts.join(" · ") || null;
  }

  function stashRow(page, index) {
    var row = el("div", "ca-stash-row");
    var path = String(page.url || "").replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
    var label = el("span", "ca-stash-label", "📄 " + page.notes.length + " · " + path);
    label.title = (page.title ? page.title + "\n" : "") + page.url;
    row.appendChild(label);
    var del = el("button", "ca-btn", "×");
    del.title = t("dropPage");
    del.addEventListener("click", function () {
      stashedPages.splice(index, 1);
      sendEvent({ type: "page-stash", pages: stashedPages });
      renderCards();
    });
    row.appendChild(del);
    return row;
  }

  function renderCards() {
    if (!els.cards) return;
    markActivity();
    els.cards.innerHTML = "";
    stashedPages.forEach(function (p, i) {
      els.cards.appendChild(stashRow(p, i));
    });
    var total = totalNotes();
    if (total === 0 && stashedPages.length === 0) {
      var hintText = !annotating ? t("hintIdle") : (mode === "region" ? t("hintOn") : t("hintElement"));
      els.cards.appendChild(el("div", "ca-meta", hintText));
    }
    regions.forEach(function (r) {
      els.cards.appendChild(regionRow(r));
    });
    elements.forEach(function (eNote) {
      els.cards.appendChild(elementRow(eNote));
    });
    els.count.textContent = String(pendingCount());
    if (els.sendAllBtn) els.sendAllBtn.textContent = t("sendAll") + " (" + pendingCount() + ")";
    updatePill();
    if (els.body) els.body.scrollTop = els.body.scrollHeight;
  }

  function regionRow(r) {
    var card = el("div", "ca-note");
    var head = el("div", "ca-note-head");
    head.appendChild(el("span", "ca-num", String(r.n)));
    var label = el("span", "ca-sel", t("regionLabel") + " " + r.doc.w + "×" + r.doc.h + (r.center ? " · " + r.center.tag : ""));
    label.title = t("regionClickEdit");
    label.addEventListener("click", function () {
      var shape = els.badges.find(function (b) { return b.kind === "region" && b.note === r; });
      try {
        window.scrollTo({ top: Math.max(0, r.doc.y - 80), behavior: "smooth" });
      } catch (e) { /* ignore */ }
      if (shape) setTimeout(function () { openPopover(r, shape.box); }, 250);
    });
    head.appendChild(label);
    var delBtn = el("button", "ca-btn", "×");
    delBtn.title = t("removeRegion");
    delBtn.addEventListener("click", function () {
      regions = regions.filter(function (x) { return x !== r; });
      renderCards(); updateShapes();
    });
    head.appendChild(delBtn);
    card.appendChild(head);
    var ta = document.createElement("textarea");
    ta.placeholder = t("commentPh");
    ta.value = r.comment || "";
    ta.addEventListener("input", function () { r.comment = ta.value; });
    card.appendChild(ta);
    if (r.center && r.center.selector) {
      card.appendChild(el("div", "ca-meta", t("centerPrefix") + r.center.selector.slice(0, 80)));
    }
    return card;
  }

  function elementRow(eNote) {
    var card = el("div", "ca-note");
    var head = el("div", "ca-note-head");
    head.appendChild(el("span", "ca-num", String(eNote.n)));
    var sel = el("span", "ca-sel", eNote.data.selector);
    sel.title = eNote.data.selector + " — " + t("scrollTitle");
    sel.addEventListener("click", function () {
      try { eNote.el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { /* ignore */ }
    });
    head.appendChild(sel);
    var parentBtn = el("button", "ca-btn", t("parentBtn"));
    parentBtn.title = t("parentTitle");
    parentBtn.addEventListener("click", function () {
      if (eNote.el && eNote.el.parentElement && eNote.el.parentElement !== document.documentElement) {
        eNote.el = eNote.el.parentElement;
        eNote.data = describe(eNote.el);
        renderCards(); updateShapes();
        captureNoteSnapshot(serializeElementNote(eNote, true));
      }
    });
    head.appendChild(parentBtn);
    var delBtn = el("button", "ca-btn", "×");
    delBtn.title = t("removeNote");
    delBtn.addEventListener("click", function () {
      elements = elements.filter(function (x) { return x !== eNote; });
      renderCards(); updateShapes();
    });
    head.appendChild(delBtn);
    card.appendChild(head);
    var ta = document.createElement("textarea");
    ta.placeholder = t("elemPh");
    ta.value = eNote.comment || "";
    ta.addEventListener("input", function () { eNote.comment = ta.value; });
    card.appendChild(ta);
    var meta = describeMeta(eNote.data);
    if (meta) card.appendChild(el("div", "ca-meta", meta));
    return card;
  }

  // ---------- keyboard ----------
  function onKeyDown(e) {
    if (isOwnUi(e.target)) return;
    markActivity();
    if (e.key === "Escape") {
      if (popover) { closePopover(false); return; }
      if (annotating) { setAnnotating(false); return; }
      setPanelHidden(!els.panel.classList.contains("hidden"));
    } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  // ---------- submit / cancel / close ----------
  function serialize() {
    var pages = stashedPages.map(function (p) {
      return { url: p.url, title: p.title || undefined, notes: p.notes };
    });
    pages.push({ url: location.href, title: document.title, notes: serializeCurrentNotes(true) });
    var flat = [];
    pages.forEach(function (p) {
      for (var i = 0; i < p.notes.length; i++) flat.push(p.notes[i]);
    });
    return {
      type: "submit",
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      context: els.context ? els.context.value.slice(0, TEXT_LIMITS.comment) : "",
      cancelled: false,
      pages: pages,
      notes: flat,
    };
  }

  function resetRound() {
    stashedPages = []; regions = []; elements = [];
    closePopover(false);
    if (els.context) els.context.value = "";
    renderCards();
    updateShapes();
  }

  // Submit does not tear the overlay down: notes are cleared, the panel stays,
  // and the host delivers further rounds automatically.
  function submit() {
    var count = pendingCount();
    if (count === 0) return;
    var payload = serialize();
    sendEvent(payload);
    resetRound();
    toast(t("sentToast").replace("{N}", String(count)));
  }

  function cancel() {
    sendEvent({ type: "cancel" });
    resetRound();
    toast(t("clearedToast"));
  }

  function closeAll() {
    sendEvent({ type: "close" });
    teardown();
  }

  // ---------- install ----------
  function install(opts) {
    LANG = opts && opts.uiLang === "en" ? "en" : "zh";
    lastUrl = location.href;
    lastTitle = document.title;
    buildUi();
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", scheduleUpdate, true);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("pagehide", onPageHide);
    sweepTimer = setInterval(function () {
      if (lastUrl !== null && location.href !== lastUrl) stashCurrentPage();
      positionShapes();
    }, 250);
  }

  var rafPending = false;
  function scheduleUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; positionShapes(); });
  }

  window.__cynosAnnotate = {
    version: VERSION,
    install: install,
    teardown: teardown,
    // Restore stashed pages held server-side (e.g. after a hard navigation
    // wiped a previous overlay before its notes were submitted).
    restoreStash: function (pages) {
      if (!Array.isArray(pages)) return;
      stashedPages = pages
        .filter(function (p) { return p && typeof p === "object" && Array.isArray(p.notes); })
        .map(function (p) {
          return { url: String(p.url || ""), title: String(p.title || ""), notes: p.notes };
        });
      renderCards();
      updateShapes();
    },
    state: function () {
      return {
        version: VERSION,
        count: totalNotes(),
        pages: stashedPages.length,
        total: pendingCount(),
        annotating: annotating,
        mode: mode,
        lastActivity: lastActivity,
        url: location.href,
      };
    },
  };
})();
