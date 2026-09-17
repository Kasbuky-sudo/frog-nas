'use strict';
/**
 * Every response transformation the game needs lives here, so that the files on
 * disk stay byte-identical to the source package (a hard requirement: see §0
 * "原始文件零修改").
 *
 * Three rewrites happen at serve time:
 *
 *   1. index.html  -- a one-line shim appended to <head> that puts the page in
 *      Route A. The page's own probe installs an in-page loopback engine unless
 *      the URL carries `?transport=ws`, so without this, opening
 *      http://nas:8980 would run a SECOND engine in the browser instead of
 *      talking to the server. The shim rewrites the URL before any other script
 *      runs, which is also why it is injected rather than done in a redirect:
 *      a redirect would change the URL the player sees and break ?log=1 etc.
 *
 *   2. gameConfig.json -- `serverList.offline.gameServer` is replaced with this
 *      deployment's own /ws endpoint. The scheme follows X-Forwarded-Proto so a
 *      TLS-terminating reverse proxy produces wss://.
 *
 *   3. All game responses get a CSP that pins them to 'self'. The bundle still
 *      ships ejoySDK/alipay channel code with absolute https:// URLs; the CSP is
 *      what guarantees those beacons cannot leave the LAN (see docs/network-audit.md).
 *
 * Nothing else is touched: launcher.js, the manifest, __probe.js and the engine
 * bundle are served verbatim, so the probe's scene fixes and the rights notice
 * behave exactly as in the source package.
 */
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eab': 'application/octet-stream',
  '.exml': 'text/xml; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.fnt': 'text/plain; charset=utf-8',
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * CSP for game pages. `'unsafe-inline'` is required: index.html carries an inline
 * boot script and inline styles, and the Egret runtime injects <style> elements.
 * `blob:` is needed for Egret's audio path (Utils.createObjectURL).
 * `connect-src` allows ws:/wss: because the WebSocket endpoint is same-origin in
 * the common case but a reverse proxy may put it behind a path.
 *
 * Deliberately absent: any host other than 'self'. That is the enforcement half of
 * docs/network-audit.md -- the game's own SDK code may still *try* to reach
 * ejoy.com or alipay, but the browser will refuse.
 */
function cspHeader() {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "base-uri 'self'",
    "form-action 'self'",
    // fnOS 桌面把应用以 iframe 嵌进桌面（desktop ui/config 的 type=iframe），
    // 而桌面在 :5666、应用在 :8980 —— 这是**跨源**嵌套。frame-ancestors 必须显式
    // 放行，否则桌面里点图标只会得到一片空白。X-Frame-Options 表达不了这种白名单
    // （它只有 DENY/SAMEORIGIN），所以那一项已从 commonHeaders 里移除。
    "frame-ancestors 'self' http: https:",
  ].join('; ');
}

/** Route A shim. Runs before __offline-engine.js / __probe.js are evaluated
 *  (they are the first two scripts in <head>, so this is prepended to <head>). */
const TRANSPORT_SHIM = `<script>
/* Route A: talk to the server-side engine instead of running one in this page.
   __probe.js skips its in-page loopback when the URL carries ?transport=ws, so the
   client's real WebSocket layer is used and the server owns the single save.
   replaceState (not a redirect) keeps the visible URL and any other query flags. */
(function () {
  try {
    var u = new URL(location.href);
    if (u.searchParams.get('transport') !== 'ws') {
      u.searchParams.set('transport', 'ws');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch (e) { /* very old browser: the game itself will not run anyway */ }
})();
</script>`;

/**
 * Orientation shim: keeps the game playable when the window is wider than the
 * design aspect, and when the window is resized/rotated AFTER the page loaded.
 *
 * WHY THIS IS NEEDED (measured, not assumed):
 *
 *   index.html chooses `data-scale-mode` ONCE, before Egret boots, from the
 *   window's aspect ratio:
 *     aspect >= 640/1136 -> fixedHeight  (stage height 1136, width follows)
 *     aspect <  640/1136 -> fixedWidth   (stage width 640, height follows)
 *
 *   That is correct for the aspect at load time, and wrong the moment the window
 *   changes shape -- nothing re-evaluates it. The game ships no
 *   orientationchange handling of its own (checked: only egret.web's internal
 *   resize path exists), and the attribute is never rewritten.
 *
 *   Measured on a 1180x700 window:
 *     - loaded in landscape            -> fixedHeight, stage 1916x1136. Fine:
 *       the whole 1136-tall design is present and the extra width is unused margin.
 *     - loaded in portrait, then rotated -> the stale fixedWidth yields a
 *       640x380 stage, so only the TOP THIRD of the design is on screen and every
 *       bottom control (商店 / 小屋 / 背包) is off-screen and unreachable.
 *
 * WHAT THIS DOES: on resize / orientationchange, recompute the same rule
 * index.html used, and -- only when it actually changed -- push it into the live
 * stage and ask Egret to relayout. Egret's ScaleMode is a settable property, so
 * this uses the engine's own mechanism rather than reimplementing layout.
 */
const ORIENTATION_SHIM = `<script>
(function () {
  var DESIGN = 640 / 1136;

  /* Same rule index.html applies at boot, so there is one definition of it. */
  function wantedMode() {
    var aspect = window.innerWidth / Math.max(1, window.innerHeight);
    return (aspect < DESIGN - 0.002) ? 'fixedWidth' : 'fixedHeight';
  }

  function apply() {
    try {
      if (!window.egret || !egret.MainContext || !egret.MainContext.instance) return;
      var stage = egret.MainContext.instance.stage;
      if (!stage) return;
      var want = wantedMode();
      if (stage.scaleMode === want) return;
      var el = document.querySelector('.egret-player');
      if (el) el.setAttribute('data-scale-mode', want);
      stage.scaleMode = want;
      /* Ask Egret to recompute the canvas geometry for the new mode. */
      window.dispatchEvent(new Event('resize'));
    } catch (e) {
      /* A layout tweak must never be able to break the game. */
      try { console.warn('[orientation] ' + e); } catch (e2) {}
    }
  }

  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; apply(); }, 120);
  }

  window.addEventListener('resize', schedule, false);
  window.addEventListener('orientationchange', schedule, false);
  /* Also once shortly after boot, in case the window changed shape between the
     page's own check and Egret's first layout. */
  setTimeout(apply, 1500);
})();
</script>`;



/**
 * Point the in-game 公告 button at the settings page, and make sure that button
 * is always reachable.
 *
 * WHAT THE BUTTON ACTUALLY IS (traced, not guessed): the right-hand courtyard
 * column is Menu.exml; its 公告 entry is the `ticketDetailBtn` property, whose
 * handler opens `TicketDetailController` -> `TicketDetailView`. That view renders
 * the ANNOUNCEMENT LIST from `NoticeModel.getNotices()`.
 *
 * WHY THE PANEL IS ALWAYS EMPTY HERE: the list is filled by
 * `BaseChannel.getAnnInfo()` -> `EjoySDK ... jsInvokeLua('ann', 'getAnnounceMent')`,
 * i.e. the Ejoy NATIVE bridge, which is a no-op stub in a browser. The offline
 * engine has no announcement source at all: it contains no "anns" field, never
 * mentions 公告, and its only publicity handler returns `{id_list: []}`. So the
 * button leads to a permanently empty panel -- not a missing feature that could
 * come back, but one whose data source no longer exists.
 *
 * WHAT THIS DOES
 *   1. Intercepts that one controller and navigates to /admin instead of showing
 *      an empty panel. If the notice list is ever non-empty the real panel opens
 *      untouched, so the original feature is preserved rather than deleted.
 *   2. Keeps the button visible and tappable. The game hides it (along with
 *      shop/house/mail) while the tutorial guide is running, which would leave a
 *      brand-new player with no way into settings -- and this button is now the
 *      ONLY in-game entry, since the separate floating settings ball was removed.
 *
 * WHY PLAIN NAVIGATION, NOT window.open: opening a new tab requires a trusted
 * user gesture, and a popup blocker silently returns null for anything else
 * (measured: the tap that reaches this code from Egret's synthetic event is
 * rejected). Navigating the current tab is never blocked. The cost is leaving the
 * game page, which is fine because the game lives on the server and resumes where
 * it left off -- /admin has a "返回游戏" button for the way back.
 *
 * The interception uses the same seam __probe.js uses for TravelMapController
 * (wrapping PageManage.addViewControl and matching __class__, since the class is
 * not a page global).
 */
const SETTINGS_ENTRY_SHIM = `<script>
(function () {
  function noticesAreEmpty() {
    try {
      var M = window.core && core.ModelManage && core.ModelManage.getInstance();
      if (!M || !window.NoticeModel) return true;      /* unknown -> treat as empty */
      var m = M.getModel(NoticeModel);
      if (!m || typeof m.getNotices !== 'function') return true;
      var list = m.getNotices();
      return !list || list.length === 0;
    } catch (e) {
      return true;
    }
  }

  /* Re-assert the button's visibility. The guide hides it during the tutorial by
     flipping visible/includeInLayout/touchEnabled, so all three are restored.
     Runs on a slow timer and only writes when something is actually off, so the
     steady-state cost is three property reads. */
  function keepButtonReachable() {
    try {
      var stage = window.egret && egret.MainContext && egret.MainContext.instance
        && egret.MainContext.instance.stage;
      if (!stage) return;
      var v = null;
      (function walk(n, d) {
        if (!n || d > 8 || v) return;
        var src = '';
        try { src = String(n.constructor); } catch (e) {}
        if (src.indexOf('MainOut.exml') >= 0) { v = n; return; }
        (n.$children || []).forEach(function (c) { walk(c, d + 1); });
      })(stage, 0);
      if (!v || !v.ticketDetailBtn) return;
      var b = v.ticketDetailBtn;
      if (!b.visible) b.visible = true;
      if (!b.includeInLayout) b.includeInLayout = true;
      if (!b.touchEnabled) b.touchEnabled = true;
    } catch (e) { /* a UI tweak must never break the game */ }
  }

  function install() {
    if (!window.core || !core.PageManage || !core.PageManage.getInstance) return false;
    var pg = core.PageManage.getInstance();
    if (pg && pg.addViewControl && !pg.__settingsEntry) {
      pg.__settingsEntry = true;
      var oAdd = pg.addViewControl;
      pg.addViewControl = function (cls, layer) {
        /* The name lives on __class__ (double underscore on BOTH sides), which is
           what __probe.js reads for the same purpose. Plain __class is a
           different, unset property, and the minified constructor source is only
           "function t(){return e.call(this)||this}" -- identical for every
           controller -- so neither can identify it. */
        var name = '';
        try { name = (cls && cls.prototype && cls.prototype.__class__) || ''; } catch (e) {}
        if (name === 'TicketDetailController' && noticesAreEmpty()) {
          location.href = '/admin';
          return null;                    /* do not open the empty panel */
        }
        return oAdd.apply(this, arguments);
      };
    }
    if (!window.__settingsEntryTimer) {
      window.__settingsEntryTimer = setInterval(keepButtonReachable, 1500);
      keepButtonReachable();
    }
    return true;
  }

  /* core appears only after the game scripts run, so retry briefly. */
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (install() || tries > 100) clearInterval(iv);
  }, 100);
})();
</script>`;

/**
 * Menu shim: relabel the settings entry, drop the three event activities that are
 * unreachable in this build, and put a save-editor entry in the freed slot.
 *
 * THE PROBLEM WITH RENAMING: the menu plaque's Chinese caption is painted INTO the
 * 84x88 bitmap (`MainOut/.../btn_*`), not drawn as a text field -- the object tree
 * under `ticketDetailBtn` contains only an Image and an armature, no `eui.Label`.
 * There is nothing to re-text, so the caption is covered by a small DOM overlay
 * positioned over that plaque. The overlay follows the LIVE plaque rect (read from
 * the display tree each tick), so it stays correct across resize, rotation and the
 * menu's scroll, all of which move the button.
 *
 * WHY THE OVERLAY IS SAFE: it is `pointer-events: none`, so it can never swallow a
 * tap -- the plaque underneath keeps receiving every touch exactly as before. It is
 * hidden whenever the plaque itself is hidden, so it cannot outlive the button.
 *
 * WHAT REPLACES THEM: ONE of the freed plaques is KEPT VISIBLE (so its wood art
 * stays) and repurposed as 编辑, which opens the save editor the probe already
 * ships -- the 存档编辑 ball's panel -- by clicking that ball. Reusing the existing
 * editor rather than reimplementing it, and reusing the plaque rather than drawing
 * a lookalike in CSS.
 *
 * FINAL MENU: 总结 / 日历 / 编辑 / 扭蛋机 / 推送设置 / 商店 / 小屋
 */
const MENU_SHIM = `<script>
(function () {
  /* Plaque art, sampled from the game's own bitmap: this light-brown caption ink. */
  var CAPTION_INK = '#a1844c';

  /* The two event plaques to hide outright. */
  var HIDE = ['btnSpringCard', 'btnPartyCake'];
  /* The plaque REPURPOSED as 编辑 -- kept visible so its art remains. */
  var EDITOR_PROP = 'btnGreetCard';
  /* The settings entry: relabelled 公告 -> 推送设置. */
  var SETTINGS_PROP = 'ticketDetailBtn';
  var CAPTION_TEXT = '推送设置';
  var EDITOR_TEXT = '编辑';

  var label = null;      /* DOM overlay covering the settings plaque's caption */
  var editor = null;     /* DOM overlay for the save-editor plaque */
  var editorHit = null;  /* transparent DOM hit area for the editor plaque */

  function mainOut() {
    try {
      var stage = window.egret && egret.MainContext && egret.MainContext.instance
        && egret.MainContext.instance.stage;
      if (!stage) return null;
      var found = null;
      (function walk(n, d) {
        if (!n || d > 8 || found) return;
        var src = '';
        try { src = String(n.constructor); } catch (e) {}
        if (src.indexOf('MainOut.exml') >= 0) { found = n; return; }
        (n.$children || []).forEach(function (c) { walk(c, d + 1); });
      })(stage, 0);
      return found;
    } catch (e) {
      return null;
    }
  }

  /* Design coordinates -> CSS pixels, so the overlays land on the plaque. */
  function scaleFactor() {
    try {
      var cv = document.querySelector('canvas').getBoundingClientRect();
      var stage = egret.MainContext.instance.stage;
      if (!cv.height || !stage.stageHeight) return null;
      return { k: cv.height / stage.stageHeight, left: cv.left, top: cv.top };
    } catch (e) {
      return null;
    }
  }

  function rectOf(obj, sc) {
    var g = obj.localToGlobal(0, 0);
    return {
      left: sc.left + g.x * sc.k,
      top: sc.top + g.y * sc.k,
      width: obj.width * sc.k,
      height: obj.height * sc.k,
    };
  }

  /* The settings caption is a BAND over the lower part of the plaque, not bare
     text: the old 公告 caption is baked into the bitmap, so text on top of it would
     overlap into noise. The band repaints that strip in the plaque's own wood colour
     and writes the new caption on it. pointer-events:none keeps the plaque
     receiving taps exactly as before -- its handler already goes to /admin. */
  function ensureLabel() {
    if (label) return label;
    label = document.createElement('div');
    label.id = '__menu_settings_label';
    label.textContent = CAPTION_TEXT;
    label.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:99990',
      'display:none', 'box-sizing:border-box',
      'text-align:center', 'white-space:nowrap', 'overflow:hidden',
      'background:linear-gradient(180deg,#efce87 0%,#e9c370 100%)',
      'border-radius:0 0 11px 11px',
      'font-family:"PingFang SC","Microsoft YaHei","Heiti SC",sans-serif',
      'font-weight:600', 'color:' + CAPTION_INK,
      'line-height:1',
    ].join(';');
    document.body.appendChild(label);
    return label;
  }

  function ensureEditor() {
    if (editor) return editor;
    /* A COVER over the repurposed plaque. It must be opaque, not transparent:
       the plaque's own icon and caption are baked into its bitmap, so putting a
       label on top would leave the old 做贺卡 art showing through and both texts
       would overlap into noise. This repaints the plaque in the game's own wood
       colours and draws a simple glyph above the new caption, so the entry reads
       as one coherent button.

       It also swallows the tap, because the plaque underneath still has its
       original TOUCH_TAP listener (which would open the 做贺卡 activity). */
    editorHit = document.createElement('div');
    editorHit.id = '__menu_editor';
    editorHit.title = '打开存档编辑器';
    editorHit.style.cssText = [
      'position:fixed', 'z-index:99995', 'display:none', 'cursor:pointer',
      'box-sizing:border-box', 'touch-action:manipulation',
      /* the plaque's own palette: pale wood fill, olive rim, rounded like the art */
      'background:linear-gradient(160deg,#f0d089 0%,#ecc573 45%,#e2ba66 100%)',
      'border:3px solid #6b7a52', 'border-radius:14px',
      'box-shadow:0 2px 5px rgba(60,50,30,.30), inset 0 0 0 2px rgba(255,255,255,.55)',
      'display:none', 'flex-direction:column', 'align-items:center',
      'justify-content:center', 'gap:2px',
      'font-family:"PingFang SC","Microsoft YaHei","Heiti SC",sans-serif',
      'color:' + CAPTION_INK, 'font-weight:600', 'line-height:1',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');
    /* A pencil glyph, drawn with CSS so no asset is needed. */
    var glyph = document.createElement('div');
    glyph.textContent = '\\u270E';
    glyph.style.cssText = 'font-size:1.5em;opacity:.85;line-height:1';
    editorHit.appendChild(glyph);
    var cap = document.createElement('div');
    cap.textContent = EDITOR_TEXT;
    editorHit.appendChild(cap);

    /* ---- tap plumbing --------------------------------------------------------
       The cover has two jobs: keep the tap off the plaque underneath (its original
       TOUCH_TAP listener would open the 做贺卡 activity), and run the toggle.

       The first version only got the first half right, which is why this button was
       dead on a phone. It preventDefault()ed touchstart/touchend and left the
       toggle on the click listener -- but a touch whose start or end is
       default-prevented never gets a synthesized click. Desktop was unaffected
       (mousedown/mouseup do not gate click), so it tested fine there and did
       nothing at all on a touch screen.

       So touch now activates from touchend directly, and click stays for
       mouse/keyboard. Two things that would otherwise bite:

         1. touchstart must NOT preventDefault any more. Keeping the event away from
            the game only needs stopPropagation (the game's listener is above this
            element); cancelling the gesture is what killed the click, and it also
            stopped the menu from scrolling when a drag began on the button.
         2. Since nothing cancels the gesture now, browsers will synthesize a click
            after touchend again. A short window after touchend ignores it, or one
            tap would toggle twice and look like it did nothing. touchend stays the
            authoritative path, so a real second tap inside that window still works.

       Mouse and pointer events keep the old preventDefault(): they do not gate
       click, and leaving them alone limits the change to the touch path. */
    var swallow = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    };
    /* Suppression without cancelling: keeps the event from reaching the game's
       listener while leaving the gesture's default behaviour (scrolling, and the
       follow-up compat click) intact. */
    var contain = function (e) {
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    };

    ['pointerdown', 'pointerup', 'mousedown', 'mouseup']
      .forEach(function (t) {
        editorHit.addEventListener(t, swallow, { capture: true, passive: false });
      });

    /* A touch counts as a tap on THIS button only if it stayed put: a drag that
       happens to start here is the menu scrolling, and must not open the editor. */
    var TAP_SLOP = 12;                 /* px */
    var TAP_MS = 700;
    var CLICK_AFTER_TOUCH_MS = 700;
    var tapStart = null;
    var touchAt = 0;

    editorHit.addEventListener('touchstart', function (e) {
      contain(e);
      var t = e.changedTouches && e.changedTouches[0];
      tapStart = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
    }, { capture: true, passive: true });

    editorHit.addEventListener('touchcancel', function () {
      tapStart = null;               /* the browser took the gesture over */
    }, { capture: true, passive: true });

    editorHit.addEventListener('touchend', function (e) {
      contain(e);
      var t = e.changedTouches && e.changedTouches[0];
      var start = tapStart;
      tapStart = null;
      if (!start || !t) return;
      var moved = Math.max(
        Math.abs(t.clientX - start.x), Math.abs(t.clientY - start.y));
      if (moved > TAP_SLOP || Date.now() - start.at > TAP_MS) return;
      touchAt = Date.now();
      activate();
    }, { capture: true, passive: true });

    editorHit.addEventListener('click', function (e) {
      swallow(e);
      if (Date.now() - touchAt < CLICK_AFTER_TOUCH_MS) return;   /* touchend ran it */
      activate();
    }, true);
    document.body.appendChild(editorHit);
    editor = editorHit;
    return editor;
  }

  /* Toggle the save editor that the probe already ships -- the SAME panel its
     存档编辑 ball controls, so there is one editor rather than two.
     The probe's own onclick is already exactly the behaviour wanted: it reads the
     panel's current state, flips it, and on open also clears the status line. So it
     is CALLED, not reimplemented -- an earlier version forced display=block after
     calling it, which defeated the toggle and made the panel impossible to close
     from this button.
     One wrinkle: the probe ignores a call while its drag-suppress flag is pending
     (set when the ball itself is dragged); that call only clears the flag. So if the
     state did not change, the call was issued once more. */
  function toggleSaveEditor() {
    var ball = document.getElementById('__save_ball');
    var panel = document.getElementById('__save_panel');
    if (!ball || !panel || typeof ball.onclick !== 'function') return false;
    var before = panel.style.display;
    ball.onclick();
    if (panel.style.display === before) ball.onclick();
    /* The probe places the panel beside its ball, which is now hidden. Centre it
       instead, so it does not open pinned to an invisible anchor in a corner. */
    if (panel.style.display === 'block') centrePanel(panel);
    return true;
  }

  /* Open/close the save editor. Retries briefly, because the probe installs its
     ball a little after boot and this button can be tapped before that happens.
     Shared by the touch and click paths -- on a phone the click event never
     arrives (see the tap plumbing in ensureEditor), so this must not live in a
     click handler. */
  function activate() {
    if (toggleSaveEditor()) { sync(); return; }
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (toggleSaveEditor()) { clearInterval(iv); sync(); }
      else if (tries > 40) clearInterval(iv);
    }, 100);
  }

  function centrePanel(panel) {
    try {
      var w = panel.offsetWidth || 214;
      var h = panel.offsetHeight || 300;
      panel.style.left = Math.round(Math.max(8, (window.innerWidth - w) / 2)) + 'px';
      panel.style.top = Math.round(Math.max(8, (window.innerHeight - h) / 2)) + 'px';
    } catch (e) { /* positioning is cosmetic; never break the toggle for it */ }
  }

  /* Hide the probe's ball but keep the element, because its onclick is the panel's
     controller. Using visibility:hidden would leave a gap; the ball is
     position:fixed so display:none has no layout side effects. Re-asserted each
     pass in case the probe's own resize handler restores it. */
  function hideSaveBall() {
    var ball = document.getElementById('__save_ball');
    if (ball && ball.style.display !== 'none') ball.style.display = 'none';
  }

  function sync() {
    var v = mainOut();
    if (!v) { hideAll(); return; }
    var sc = scaleFactor();
    if (!sc) { hideAll(); return; }

    /* 0. hide the probe's own 存档编辑 ball: the 编辑 plaque replaces it, and two
          entries for one panel is exactly the redundancy that was reported. The ball
          element is KEPT in the DOM (hidden), because toggleSaveEditor() drives the
          panel through its onclick -- removing it would break 编辑. */
    hideSaveBall();

    /* 1. hide the two event activities, re-asserting because the game recomputes
          their visibility on its own schedule (updateSpringCard / updatePartyCake). */
    for (var i = 0; i < HIDE.length; i++) {
      var o = v[HIDE[i]];
      if (!o) continue;
      if (o.visible) o.visible = false;
      if (o.includeInLayout) o.includeInLayout = false;
    }

    /* 2. KEEP the repurposed plaque visible (the game hides it when the event it
          belongs to is closed, and it must stay for the 编辑 entry). */
    var ed = v[EDITOR_PROP];
    if (ed) {
      if (!ed.visible) ed.visible = true;
      if (!ed.includeInLayout) ed.includeInLayout = true;
      if (!ed.touchEnabled) ed.touchEnabled = true;
    }

    /* 2. caption band over the settings plaque's own caption strip (see
          ensureLabel). The band is sized from the plaque so it always covers the
          baked-in text regardless of scale. */
    var settings = v[SETTINGS_PROP];
    var lb = ensureLabel();
    if (settings && settings.visible && settings.includeInLayout !== false) {
      var r = rectOf(settings, sc);
      var bandH = Math.max(14, Math.round(r.height * 0.30));
      lb.style.display = 'block';
      lb.style.left = Math.round(r.left + r.width * 0.06) + 'px';
      lb.style.top = Math.round(r.top + r.height * 0.62) + 'px';
      lb.style.width = Math.round(r.width * 0.88) + 'px';
      lb.style.height = bandH + 'px';
      lb.style.fontSize = Math.max(9, Math.round(bandH * 0.52)) + 'px';
      lb.style.paddingTop = Math.round(bandH * 0.22) + 'px';
    } else {
      lb.style.display = 'none';
    }

    /* 3. the 编辑 cover, sized to the WHOLE plaque so it hides the original icon
          and caption (both are baked into the bitmap). Its geometry comes from the
          plaque's rect; the plaque's own visible flag stays true, and the cover is
          opaque because it replaces the art entirely.
          The cover also mirrors the panel's open/closed state, the way the probe's
          own ball scales down while the editor is open -- so it is visible from the
          button itself whether a second tap will close it. */
    var cover = ensureEditor();
    if (ed) {
      var sr = rectOf(ed, sc);
      cover.style.display = 'flex';
      cover.style.left = Math.round(sr.left) + 'px';
      cover.style.top = Math.round(sr.top) + 'px';
      cover.style.width = Math.round(sr.width) + 'px';
      cover.style.height = Math.round(sr.height) + 'px';
      var panelOpen = false;
      try {
        var pnl = document.getElementById('__save_panel');
        panelOpen = !!(pnl && pnl.style.display === 'block');
      } catch (e) { /* the panel may not exist yet */ }
      /* Pressed feedback is deliberately strong: the player has to be able to tell
         from the button itself whether a second tap will close the editor. A subtle
         inset shadow measured as "no visible difference" in a screenshot, so the
         open state darkens the plaque AND lowers the glyph/caption opacity. */
      cover.style.filter = panelOpen ? 'brightness(.86) saturate(.9)' : 'none';
      cover.style.boxShadow = panelOpen
        ? 'inset 0 3px 7px rgba(50,40,20,.55), inset 0 0 0 2px rgba(255,255,255,.25)'
        : '0 2px 5px rgba(60,50,30,.30), inset 0 0 0 2px rgba(255,255,255,.55)';
      cover.style.transform = panelOpen ? 'translateY(1px)' : 'none';
      for (var ci = 0; ci < cover.children.length; ci++) {
        cover.children[ci].style.opacity = panelOpen ? '0.55' : '0.85';
      }
      cover.setAttribute('aria-pressed', panelOpen ? 'true' : 'false');
      cover.title = panelOpen ? '关闭存档编辑器' : '打开存档编辑器';
      cover.style.fontSize = Math.max(10, Math.round(sr.height * 0.20)) + 'px';
    } else {
      cover.style.display = 'none';
    }
  }

  function hideAll() {
    if (label) label.style.display = 'none';
    if (editor) editor.style.display = 'none';
  }

  /* Re-assert on a timer: the game recomputes these flags itself, and the menu
     scrolls. Cheap -- a handful of property reads when nothing changed. */
  function start() {
    if (window.__menuShimTimer) return;
    window.__menuShimTimer = setInterval(sync, 900);
    window.addEventListener('resize', sync, false);
    sync();
  }

  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (mainOut() || tries > 100) { clearInterval(iv); start(); }
  }, 100);
})();
</script>`;

/**
 * Put every shim immediately after <head> so they precede the game's own scripts.
 * Falls back to prepending to the document if there is no <head> (there always is).
 */function injectTransportShim(html) {
  const m = /<head[^>]*>/i.exec(html);
  // Transport first: it must run before __probe.js decides on the in-page engine.
  const shims = '\n' + TRANSPORT_SHIM + '\n' + ORIENTATION_SHIM + '\n'
    + SETTINGS_ENTRY_SHIM + '\n' + MENU_SHIM;
  if (!m) return shims + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + shims + html.slice(at);
}

/**
 * Add the NAS / Docker port credit to the startup rights notice, AT SERVE TIME.
 *
 * The notice itself is plain markup inside vendor/game/index.html, and that file
 * is never modified on disk (see §0 of the brief and docs/decisions.md), so the
 * extra line is spliced into the response instead.
 *
 * This only ever ADDS a line. It does not remove or reword anything: the
 * Hit-Point copyright, the Balticx attribution and the non-commercial statement
 * are all preserved verbatim, and the overlay still has to be dismissed by hand
 * on every launch. The port author is credited as the author of THIS layer only --
 * neither the game nor the offline engine is his work.
 *
 * Injection is defensive: if the expected markup is not found the HTML is
 * returned unchanged, so a future source package cannot break the page here.
 */
const PORT_CREDIT_NAME = 'Kasbuky';
const PORT_CREDIT_TEXT = 'NAS / Docker 移植：' + PORT_CREDIT_NAME;

function injectPortCredit(html) {
  const line = '<p class="__sign">' + PORT_CREDIT_TEXT + '</p>';
  if (html.includes(PORT_CREDIT_TEXT)) return html;      // already applied

  // Preferred anchor: immediately after the original sign-off, so both credits
  // read together at the end of the notice.
  const signRe = /(<p class="__sign">[^<]*<\/p>)/;
  const m = signRe.exec(html);
  if (m) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + '\n\n            ' + line + html.slice(at);
  }

  // Fallback anchor: just before the dismiss button, if the sign-off changed shape.
  const btnRe = /(<button id="__notice_ok")/;
  const b = btnRe.exec(html);
  if (b) {
    return html.slice(0, b.index) + line + '\n            ' + html.slice(b.index);
  }

  return html;      // notice not found: leave the page exactly as it was
}

/**
 * Rewrite gameConfig.json's server list to point at this deployment.
 *
 * @param {string} raw     original file contents
 * @param {object} opts
 * @param {string} opts.host            the Host header (or X-Forwarded-Host)
 * @param {string} [opts.proto]         'http' | 'https'
 * @param {string} [opts.wsPath]        defaults to '/ws'
 * @returns {string} JSON text; on any parse failure the original is returned so a
 *                   malformed config can never take the game down.
 */
function rewriteGameConfig(raw, opts) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error('[static] gameConfig.json is not valid JSON, serving as-is: ' + e.message);
    return raw;
  }
  const proto = opts.proto === 'https' ? 'wss' : 'ws';
  const host = opts.host || '127.0.0.1';
  const wsPath = opts.wsPath || '/ws';
  const url = proto + '://' + host + wsPath;

  if (!cfg.serverList || typeof cfg.serverList !== 'object') cfg.serverList = {};
  if (!cfg.serverList.offline || typeof cfg.serverList.offline !== 'object') {
    cfg.serverList.offline = {};
  }
  cfg.serverList.offline.gameServer = [url];

  return JSON.stringify(cfg, null, 4);
}

/** Host for the WebSocket URL: prefer what the proxy says the client used. */
function requestHost(req) {
  const fwd = req.headers['x-forwarded-host'];
  const host = (Array.isArray(fwd) ? fwd[0] : fwd) || req.headers.host || '127.0.0.1';
  return String(host).split(',')[0].trim();
}

function requestProto(req) {
  const fwd = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd) || req.protocol || 'http';
  return String(proto).split(',')[0].trim().toLowerCase();
}

/**
 * Files served from vendor/game (i.e. not under /resource/) that must never be
 * cached, because they are rewritten per request or carry the boot flags.
 */
const NO_CACHE = new Set(['index.html', 'gameConfig.json']);

class StaticServer {
  /**
   * @param {object} opts
   * @param {string} opts.gameDir      vendor/game
   * @param {string} opts.resourceDir  vendor/resource
   * @param {string} [opts.wsPath]
   */
  constructor(opts) {
    this.gameDir = opts.gameDir;
    this.resourceDir = opts.resourceDir;
    this.wsPath = opts.wsPath || '/ws';
    // The pristine gameConfig, guaranteed to be the source package's copy even if
    // the served one is ever touched. Populated by fetch-source; falls back to the
    // resource tree so a hand-made vendor/ still works.
    this.configPaths = [
      path.join(this.resourceDir, 'China', 'config', 'gameConfig.json'),
    ];
    this.configOriginal = null;
  }

  /** Resolve a URL path to a file inside `root`, refusing traversal. */
  resolve(root, urlPath) {
    const decoded = decodeURIComponent(urlPath);
    if (decoded.indexOf('\0') !== -1) return null;
    const rel = decoded.replace(/^\/+/, '');
    const full = path.resolve(root, rel);
    const rootResolved = path.resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
    return full;
  }

  gameFile(urlPath) {
    return this.resolve(this.gameDir, urlPath);
  }

  resourceFile(urlPath) {
    // /resource/China/... -> vendor/resource/China/...
    return this.resolve(this.resourceDir, urlPath.replace(/^\/resource\/?/, ''));
  }

  /** The gameConfig to rewrite: prefer the pristine copy taken by fetch-source. */
  readOriginalConfig() {
    if (this.configOriginal) return this.configOriginal;
    for (const p of this.configPaths) {
      try {
        this.configOriginal = fs.readFileSync(p, 'utf8');
        return this.configOriginal;
      } catch (e) { /* try the next candidate */ }
    }
    return null;
  }

  setOriginalConfig(text) { this.configOriginal = text; }

  commonHeaders(res) {
    res.setHeader('Content-Security-Policy', cspHeader());
    // The game is same-origin; nothing should leak a referrer to an outside host.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 刻意不发 X-Frame-Options：fnOS 桌面把应用嵌进 iframe 时是跨源的
    // （桌面 :5666 / 应用 :8980），SAMEORIGIN 会让「页内打开」变成白屏。
    // 允许的祖先改由 CSP 的 frame-ancestors 声明（见 cspHeader）。
  }

  /** Serve vendor/game/index.html with the Route A shim injected. */
  serveIndex(req, res) {
    const file = path.join(this.gameDir, 'index.html');
    let html;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch (e) {
      res.status(500).type('text/plain').send('index.html not found in vendor/game — run scripts/fetch-source.js');
      return;
    }
    this.commonHeaders(res);
    res.setHeader('Content-Type', MIME['.html']);
    res.setHeader('Cache-Control', 'no-cache');
    // The port credit is added to the rights notice too, so the overlay names all
    // three parties: Hit-Point (copyright), Balticx (offline build), Kasbuky (port).
    res.send(injectPortCredit(injectTransportShim(html)));
  }

  /** Serve gameConfig.json with this deployment's WS endpoint. */
  serveGameConfig(req, res) {
    const raw = this.readOriginalConfig();
    if (raw === null) {
      res.status(404).type('text/plain').send('gameConfig.json not found in vendor/resource/China/config');
      return;
    }
    this.commonHeaders(res);
    res.setHeader('Content-Type', MIME['.json']);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewriteGameConfig(raw, {
      host: requestHost(req),
      proto: requestProto(req),
      wsPath: this.wsPath,
    }));
  }

  /** Serve one static file from vendor/game or vendor/resource. */
  serveFile(req, res, file, { immutable } = {}) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    if (!st.isFile()) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    this.commonHeaders(res);
    res.setHeader('Content-Type', contentType(file));
    res.setHeader('Content-Length', String(st.size));
    const name = path.basename(file).toLowerCase();
    if (NO_CACHE.has(name)) res.setHeader('Cache-Control', 'no-cache');
    else if (immutable) res.setHeader('Cache-Control', 'public, max-age=86400');
    else res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  }
}

module.exports = {
  StaticServer, MIME, contentType, cspHeader, injectTransportShim,
  rewriteGameConfig, requestHost, requestProto,
  TRANSPORT_SHIM, ORIENTATION_SHIM, SETTINGS_ENTRY_SHIM, MENU_SHIM,
  injectPortCredit, PORT_CREDIT_NAME, PORT_CREDIT_TEXT,
};
