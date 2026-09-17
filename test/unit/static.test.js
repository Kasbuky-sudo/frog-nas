'use strict';
/**
 * gameConfig.json rewriting: the server list must point at this deployment, and
 * ws vs wss must follow the proxy headers.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const nodePath = require('path');

const { rewriteGameConfig, injectTransportShim, cspHeader, requestHost, requestProto,
  StaticServer,
  TRANSPORT_SHIM, ORIENTATION_SHIM, SETTINGS_ENTRY_SHIM, MENU_SHIM,
  injectPortCredit, PORT_CREDIT_NAME } = require('../../src/static');

const ORIGINAL = JSON.stringify({
  description: 'OFFLINE single-player build',
  useNode: 'offline',
  channelType: 1,
  showGM: false,
  serverList: {
    offline: {
      description: 'OFFLINE LOCAL ENGINE',
      gameServer: ['ws://127.0.0.1:8080'],
      platformID: 'ONE',
      serverName: 'offline',
      channelID: 'P10528',
      maintain: '',
    },
  },
});

function parse(text) {
  return JSON.parse(text);
}

test('rewrite: the server list points at the request host and /ws', () => {
  const out = parse(rewriteGameConfig(ORIGINAL, { host: 'nas.local:8980', proto: 'http' }));
  assert.deepEqual(out.serverList.offline.gameServer, ['ws://nas.local:8980/ws']);
});

test('rewrite: https becomes wss', () => {
  const out = parse(rewriteGameConfig(ORIGINAL, { host: 'frog.example.com', proto: 'https' }));
  assert.deepEqual(out.serverList.offline.gameServer, ['wss://frog.example.com/ws']);
});

test('rewrite: every other field is preserved byte-for-byte in value', () => {
  const before = parse(ORIGINAL);
  const after = parse(rewriteGameConfig(ORIGINAL, { host: 'h', proto: 'http' }));
  assert.equal(after.useNode, before.useNode);
  assert.equal(after.channelType, before.channelType);
  assert.equal(after.showGM, before.showGM);
  assert.equal(after.serverList.offline.channelID, before.serverList.offline.channelID);
  assert.equal(after.serverList.offline.platformID, before.serverList.offline.platformID);
  assert.equal(after.serverList.offline.serverName, before.serverList.offline.serverName);
  assert.equal(after.description, before.description);
});

test('rewrite: a custom ws path is honoured', () => {
  const out = parse(rewriteGameConfig(ORIGINAL, { host: 'h:1', proto: 'http', wsPath: '/socket' }));
  assert.deepEqual(out.serverList.offline.gameServer, ['ws://h:1/socket']);
});

test('rewrite: unparseable input is returned unchanged (never breaks the game)', () => {
  const broken = '{ this is not json';
  assert.equal(rewriteGameConfig(broken, { host: 'h', proto: 'http' }), broken);
});

test('rewrite: missing serverList is created rather than throwing', () => {
  const out = parse(rewriteGameConfig('{}', { host: 'h:2', proto: 'http' }));
  assert.deepEqual(out.serverList.offline.gameServer, ['ws://h:2/ws']);
});

test('rewrite: IPv6 host with brackets survives', () => {
  const out = parse(rewriteGameConfig(ORIGINAL, { host: '[fd00::1]:8980', proto: 'http' }));
  assert.deepEqual(out.serverList.offline.gameServer, ['ws://[fd00::1]:8980/ws']);
});

test('host: X-Forwarded-Host wins over Host, taking the first of a list', () => {
  assert.equal(requestHost({ headers: { host: 'a:1', 'x-forwarded-host': 'b:2' } }), 'b:2');
  assert.equal(requestHost({ headers: { host: 'a:1', 'x-forwarded-host': 'b:2, c:3' } }), 'b:2');
  assert.equal(requestHost({ headers: { host: 'a:1' } }), 'a:1');
  assert.equal(requestHost({ headers: {} }), '127.0.0.1');
});

test('proto: X-Forwarded-Proto wins, normalised to lower case', () => {
  assert.equal(requestProto({ headers: { 'x-forwarded-proto': 'HTTPS' }, protocol: 'http' }), 'https');
  assert.equal(requestProto({ headers: { 'x-forwarded-proto': 'https, http' }, protocol: 'http' }), 'https');
  assert.equal(requestProto({ headers: {}, protocol: 'http' }), 'http');
});

test('shim: injected inside <head> and before every game script', () => {
  const html = '<!DOCTYPE HTML>\n<html>\n<head>\n    <meta charset="utf-8">\n' +
    '    <script src="__offline-engine.js"></script>\n    <script src="__probe.js"></script>\n</head><body></body></html>';
  const out = injectTransportShim(html);
  const shimAt = out.indexOf('replaceState');
  assert.ok(shimAt > 0, 'shim present');
  assert.ok(shimAt < out.indexOf('__offline-engine.js'),
    'shim must run before the engine bundle, or the probe would install its loopback first');
  assert.ok(out.indexOf('<head>') < shimAt);
  // The shim must set ?transport=ws, which is exactly the flag __probe.js checks.
  assert.match(out, /searchParams\.set\('transport', 'ws'\)/);
});

test('shim: it uses replaceState, not a redirect (the URL must not change)', () => {
  assert.match(TRANSPORT_SHIM, /history\.replaceState/);
  assert.doesNotMatch(TRANSPORT_SHIM, /location\.(href|replace|assign)\s*=/);
});

test('shim: the rights notice is left untouched', () => {
  const html = '<html><head></head><body><div id="__notice">Hit-Point Balticx</div></body></html>';
  const out = injectTransportShim(html);
  assert.ok(out.includes('id="__notice"'));
  assert.ok(out.includes('Hit-Point'));
  assert.ok(out.includes('Balticx'));
});

test('csp: pins every resource class to self, with no third-party host', () => {
  const csp = cspHeader();
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.match(csp, /object-src 'none'/);
  // No host other than self may appear anywhere in the policy.
  const withoutSelf = csp.replace(/'self'/g, '');
  assert.doesNotMatch(withoutSelf, /https?:\/\//, 'no absolute origins in the CSP');
  assert.doesNotMatch(withoutSelf, /\*/, 'no wildcard hosts');
});

// ------------------------------------------------------------- fnOS iframe 嵌入
// fnOS 桌面的应用入口（desktop ui/config 的 type=iframe）把应用嵌进桌面的 iframe 里。
// 桌面跑在 :5666、应用跑在 :8980 —— 端口不同即**跨源**，所以这是跨源嵌套。
// 只要响应里带 X-Frame-Options: SAMEORIGIN，浏览器就会拒绝渲染这个 iframe，
// 桌面里点图标只会得到一片空白（而「新标签页打开」却是好的，最容易被漏掉）。
// 因此这里钉住两条：不再发 X-Frame-Options，且 CSP 明确放行 frame-ancestors。

function headerSink() {
  const headers = {};
  return { headers, setHeader(k, v) { headers[String(k).toLowerCase()] = v; } };
}

test('iframe: 不发 X-Frame-Options，且 CSP 放行 frame-ancestors', () => {
  const res = headerSink();
  StaticServer.prototype.commonHeaders(res);

  assert.equal(res.headers['x-frame-options'], undefined,
    'X-Frame-Options 只有 DENY/SAMEORIGIN，会把 fnOS 的跨源 iframe 嵌进拦掉');
  assert.match(res.headers['content-security-policy'],
    /frame-ancestors 'self' http: https:/,
    'CSP 必须显式放行 frame-ancestors，否则页内打开是白屏');

  // 顺手钉住没被误删的另外两个头。
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

// ---------------------------------------------------------------- orientation
// The shipped index.html picks data-scale-mode ONCE from the aspect ratio and
// never revisits it. Rotating a device (or resizing a window) after load therefore
// used to leave a stale mode behind: a portrait-loaded page rotated to landscape
// kept fixedWidth and produced a 640x380 stage, showing only the top third of the
// 1136-tall design with every bottom control off-screen. The shim re-applies the
// rule on resize; these tests pin the shim's presence and its rule.

test('orientation: the shim is injected too, and after the transport shim', () => {
  const html = '<html><head><meta charset="utf-8"><script src="__probe.js"></script></head><body></body></html>';
  const out = injectTransportShim(html);
  assert.ok(out.includes('orientationchange'), 'listens for orientationchange');
  assert.ok(out.includes("addEventListener('resize'"), 'listens for resize');
  // Transport must be settled first: the probe reads ?transport=ws when it runs.
  assert.ok(out.indexOf("searchParams.set('transport', 'ws')") < out.indexOf('orientationchange'),
    'transport shim precedes the orientation shim');
  // Both must precede every real game script. Match the script TAG rather than the
  // bare filename: the transport shim's own comment mentions __probe.js, so a
  // substring search would find the comment and invert the comparison.
  const probeTag = out.indexOf('<script src="__probe.js"');
  assert.ok(probeTag > 0, 'the fixture still has the probe script tag');
  assert.ok(out.indexOf('orientationchange') < probeTag, 'orientation shim precedes the probe script');
  assert.ok(out.indexOf('wantedMode') < probeTag, 'the whole orientation shim precedes it');
});

test('orientation: the shim uses the same aspect rule index.html uses', () => {
  // Same constants and same threshold, so there is one definition of the rule.
  assert.match(ORIENTATION_SHIM, /640 \/ 1136/);
  assert.match(ORIENTATION_SHIM, /< DESIGN - 0\.002/);
  assert.match(ORIENTATION_SHIM, /'fixedWidth' : 'fixedHeight'/);
});

test('orientation: the shim drives Egret rather than reimplementing layout', () => {
  // It must set the engine's own ScaleMode and let Egret relayout.
  assert.match(ORIENTATION_SHIM, /stage\.scaleMode = want/);
  assert.match(ORIENTATION_SHIM, /dispatchEvent\(new Event\('resize'\)\)/);
  // And it must update the attribute the page reads, so a later fullscreen
  // toggle cannot restore the stale value.
  assert.match(ORIENTATION_SHIM, /setAttribute\('data-scale-mode', want\)/);
});

test('orientation: a failure inside the shim cannot break the game', () => {
  assert.match(ORIENTATION_SHIM, /try \{/);
  assert.match(ORIENTATION_SHIM, /catch \(e\)/);
  // It must no-op until Egret exists rather than throwing during early script order.
  assert.match(ORIENTATION_SHIM, /if \(!window\.egret/);
});

test('orientation: resizing is debounced (no layout storm)', () => {
  assert.match(ORIENTATION_SHIM, /clearTimeout\(timer\)/);
  assert.match(ORIENTATION_SHIM, /setTimeout\(function \(\) \{ timer = null; apply\(\); \}, 120\)/);
});

// ------------------------------------------------------- injected shim hygiene
// Every shim is a template literal that becomes inline <script> content. A stray
// backtick or ${ inside one would either terminate the literal (a parse error in
// the server module, caught below) or silently interpolate at build time.
test('shims: each one is valid standalone JavaScript', () => {
  const vm = require('node:vm');
  const shims = { TRANSPORT_SHIM, ORIENTATION_SHIM, SETTINGS_ENTRY_SHIM, MENU_SHIM };
  for (const [name, src] of Object.entries(shims)) {
    assert.ok(src.startsWith('<script>'), name + ' is wrapped in a script tag');
    assert.ok(src.trimEnd().endsWith('</script>'), name + ' closes its script tag');
    const body = src.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
    // Constructing a Script throws on a syntax error -- exactly what a stray
    // backtick produces after the template literal closes.
    assert.doesNotThrow(() => new vm.Script(body, { filename: name + '.js' }),
      name + ' must parse as JavaScript');
    assert.doesNotMatch(body, /\$\{/, name + ' must not contain a template placeholder');
  }
});

test('shims: no stray backtick can close a template literal early', () => {
  // A backtick inside a shim's COMMENT silently ends the template string, turning
  // the rest into top-level JS and breaking the whole module at require time. That
  // happened twice while writing MENU_SHIM, so it is checked structurally: between
  // `const X_SHIM = \`<script>` and its closing `</script>\`;` there must be no
  // other backtick at all.
  const src = fs.readFileSync(nodePath.join(__dirname, '..', '..', 'src', 'static.js'), 'utf8');
  const lines = src.split('\n');
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^const (\w*SHIM\w*) = `<script>/.exec(lines[i]);
    if (!m) continue;
    checked++;
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const idx = lines[j].indexOf('`');
      if (idx < 0) continue;
      const after = lines[j].slice(idx + 1).trim();
      assert.ok(after.startsWith(';'),
        m[1] + ' has a stray backtick on line ' + (j + 1) + ': ' + lines[j].trim().slice(0, 80));
      closed = true;
      break;
    }
    assert.ok(closed, m[1] + ' is never closed with a backtick');
  }
  assert.ok(checked >= 4, 'found the shim definitions (got ' + checked + ')');
});

test('shims: all four are injected, in order, before every game script', () => {
  const html = '<html><head><meta charset="utf-8">'
    + '<script src="__offline-engine.js"></script><script src="__probe.js"></script>'
    + '</head><body></body></html>';
  const out = injectTransportShim(html);
  const marks = [
    "searchParams.set('transport', 'ws')",
    'wantedMode',
    'TicketDetailController',
    '__menu_editor',
  ];
  const at = marks.map((m) => out.indexOf(m));
  assert.ok(at.every((i) => i > 0), 'all four shims present: ' + JSON.stringify(at));
  // Transport first (the probe reads ?transport=ws when it evaluates), then the
  // rest in a fixed order, all before the engine bundle.
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i - 1] < at[i], marks[i] + ' must come after ' + marks[i - 1]);
  }
  const engineAt = out.indexOf('<script src="__offline-engine.js"');
  assert.ok(at[3] < engineAt, 'the last shim still precedes the engine bundle');
});

test('settings entry: no floating button is injected any more', () => {
  // The separate 设置 ball was removed once the in-game 公告 button became the
  // settings entry -- two entries for one screen was redundant, and the ball
  // overlapped the courtyard art.
  const out = injectTransportShim('<html><head></head><body></body></html>');
  assert.ok(!out.includes('__admin_ball'), 'no settings ball element');
  assert.ok(!out.includes('frog.settingsButton.pos'), 'no stored ball position');
});

// ------------------------------------------------------------- the menu shim
test('menu: relabels the settings plaque to 推送设置', () => {
  assert.match(MENU_SHIM, /var CAPTION_TEXT = '推送设置'/);
  assert.match(MENU_SHIM, /var SETTINGS_PROP = 'ticketDetailBtn'/);
  // The caption is painted into the plaque bitmap, so the new text goes on a COVER
  // band; bare text would overlap the baked-in 公告 and read as noise.
  assert.match(MENU_SHIM, /id = '__menu_settings_label'/);
  assert.match(MENU_SHIM, /background:linear-gradient/);
});

test('menu: the settings caption band cannot swallow taps', () => {
  // Its handler already navigates to /admin, so the overlay must stay transparent
  // to input -- otherwise the plaque would stop receiving the tap that matters.
  assert.match(MENU_SHIM, /'pointer-events:none', 'z-index:99990'/);
});

test('menu: hides 做贺卡/春联 and 做蛋糕', () => {
  assert.match(MENU_SHIM, /var HIDE = \['btnSpringCard', 'btnPartyCake'\]/);
  // Re-asserted because the game recomputes these flags in its own update pass.
  assert.match(MENU_SHIM, /if \(o\.visible\) o\.visible = false/);
  assert.match(MENU_SHIM, /if \(o\.includeInLayout\) o\.includeInLayout = false/);
});

test('menu: adds an 编辑 plaque by repurposing one kept plaque', () => {
  // One plaque is KEPT so its wood art stays, and covered with the new entry.
  assert.match(MENU_SHIM, /var EDITOR_PROP = 'btnGreetCard'/);
  assert.match(MENU_SHIM, /if \(!ed\.visible\) ed\.visible = true/);
  assert.match(MENU_SHIM, /var EDITOR_TEXT = '编辑'/);
  assert.match(MENU_SHIM, /id = '__menu_editor'/);
});

test('menu: the 编辑 plaque TOGGLES the save editor (open and close)', () => {
  // The panel must be closable from the same button that opened it. An earlier
  // version forced display=block after calling the probe's handler, which defeated
  // the toggle and left the panel impossible to close from here -- reported.
  assert.match(MENU_SHIM, /function toggleSaveEditor\(\)/);
  assert.match(MENU_SHIM, /getElementById\('__save_ball'\)/);
  assert.match(MENU_SHIM, /getElementById\('__save_panel'\)/);
  // It must delegate to the probe's own toggle rather than setting display itself.
  assert.match(MENU_SHIM, /ball\.onclick\(\)/);
  assert.doesNotMatch(MENU_SHIM, /panel\.style\.display = 'block'/);
  assert.doesNotMatch(MENU_SHIM, /ball\.click\(\)/);
});

test('menu: a swallowed call is retried, not forced', () => {
  // The probe ignores one call while its drag-suppress flag is pending, so the
  // state is compared before/after and the call repeated only if nothing changed.
  assert.match(MENU_SHIM, /var before = panel\.style\.display/);
  assert.match(MENU_SHIM, /if \(panel\.style\.display === before\) ball\.onclick\(\)/);
});

test('menu: the 编辑 plaque shows whether the editor is open', () => {
  // The player must be able to tell from the button itself that a second tap closes.
  assert.match(MENU_SHIM, /aria-pressed/);
  assert.match(MENU_SHIM, /关闭存档编辑器/);
  // The open state has to be VISIBLE: a subtle inset shadow measured as no
  // difference at all in a screenshot, so it also darkens and dims the contents.
  assert.match(MENU_SHIM, /brightness\(\.86\)/);
  assert.match(MENU_SHIM, /style\.opacity = panelOpen \? '0\.55'/);
});

test('menu: the 编辑 cover swallows the repurposed plaque\'s own tap', () => {
  // The plaque underneath still has its original TOUCH_TAP listener (which would
  // open the 做贺卡 activity), so the cover must stop those events.
  assert.match(MENU_SHIM, /stopImmediatePropagation/);
  assert.match(MENU_SHIM, /'pointerdown', 'pointerup', 'mousedown', 'mouseup'/);
  // click is deliberately NOT in that swallow list: it carries its own listener
  // that both swallows and opens the editor.
  assert.match(MENU_SHIM, /editorHit\.addEventListener\('click', function \(e\) \{/);
  // And it must be OPAQUE, because it replaces baked-in art rather than adding to it.
  assert.match(MENU_SHIM, /background:linear-gradient\(160deg,#f0d089/);
});

test('menu: 编辑 opens from a TOUCH, not only from a mouse click', () => {
  // Regression (reported from a phone): touchstart/touchend used to go through the
  // same preventDefault()ing swallow as the mouse events, and a default-prevented
  // touch never gets a synthesized `click`. Desktop was fine -- mousedown/mouseup
  // do not gate `click` -- so the button looked correct and did nothing on a phone.
  const TS = /editorHit\.addEventListener\('touchstart', function \(e\) \{[\s\S]*?\}, \{ capture: true, passive: true \}\);/;
  const TE = /editorHit\.addEventListener\('touchend', function \(e\) \{[\s\S]*?\}, \{ capture: true, passive: true \}\);/;
  const ts = MENU_SHIM.match(TS);
  const te = MENU_SHIM.match(TE);
  assert.ok(ts, 'touchstart listener present');
  assert.ok(te, 'touchend listener present');
  // The action has to run from touchend itself: that is the fix.
  assert.match(te[0], /activate\(\)/);
  // Neither touch event may cancel the gesture any more -- that is what killed the
  // click, and it also blocked the menu from scrolling off this button.
  assert.doesNotMatch(te[0], /preventDefault/);
  assert.doesNotMatch(ts[0], /preventDefault/);
  // A touch only counts as a tap if it did not travel: a drag starting here is the
  // menu scrolling and must not open the editor.
  assert.match(te[0], /moved > TAP_SLOP/);
  assert.match(te[0], /Date\.now\(\) - start\.at > TAP_MS/);
  assert.match(MENU_SHIM, /addEventListener\('touchcancel'/);
  // Since nothing cancels the gesture now, a compat click follows touchend; it must
  // be ignored once, or the single tap would toggle twice and appear to do nothing.
  assert.match(MENU_SHIM, /Date\.now\(\) - touchAt < CLICK_AFTER_TOUCH_MS/);
  // The retry path is shared by both routes, so it cannot live inside the click
  // handler -- that is exactly the shape that made touch-only devices fail.
  assert.match(MENU_SHIM, /function activate\(\)/);
});

test('menu: positions overlays from the live plaque rects', () => {
  // The menu scrolls and the stage rescales, so positions are recomputed from
  // localToGlobal each pass instead of being hardcoded.
  assert.match(MENU_SHIM, /function rectOf\(obj, sc\)/);
  assert.match(MENU_SHIM, /obj\.localToGlobal\(0, 0\)/);
  assert.match(MENU_SHIM, /function scaleFactor\(\)/);
  assert.match(MENU_SHIM, /setInterval\(sync, 900\)/);
  // Hidden when the game view is not on screen, so nothing outlives its button.
  assert.match(MENU_SHIM, /function hideAll\(\)/);
});

test('settings entry: keeps the 公告 button visible during the tutorial', () => {
  // The game hides ticketDetailBtn (with shop/house/mail) while the guide runs.
  // Since this is now the ONLY in-game route to settings, it must stay reachable
  // on a brand-new save -- otherwise a new player could not open /admin at all.
  assert.match(SETTINGS_ENTRY_SHIM, /function keepButtonReachable\(\)/);
  assert.match(SETTINGS_ENTRY_SHIM, /v\.ticketDetailBtn/);
  assert.match(SETTINGS_ENTRY_SHIM, /if \(!b\.visible\) b\.visible = true/);
  assert.match(SETTINGS_ENTRY_SHIM, /if \(!b\.includeInLayout\) b\.includeInLayout = true/);
  assert.match(SETTINGS_ENTRY_SHIM, /if \(!b\.touchEnabled\) b\.touchEnabled = true/);
  // Cheap: it reads three properties and only writes when something is off.
  assert.match(SETTINGS_ENTRY_SHIM, /setInterval\(keepButtonReachable, 1500\)/);
  // And it must never be able to break the game.
  assert.match(SETTINGS_ENTRY_SHIM, /catch \(e\) \{ \/\* a UI tweak must never break the game \*\//);
});

// ------------------------------------------------------- the notice redirect
test('notice redirect: targets the announcement controller, not a guessed name', () => {
  // The right-hand 公告 button opens TicketDetailController -> TicketDetailView.
  assert.match(SETTINGS_ENTRY_SHIM, /TicketDetailController/);
  // The identity property is __class__ (both sides), which is what the probe
  // reads; plain __class is unset in this build.
  assert.match(SETTINGS_ENTRY_SHIM, /prototype && cls\.prototype\.__class__/);
  assert.doesNotMatch(SETTINGS_ENTRY_SHIM, /prototype\.__class[^_]/);
});

test('notice redirect: only fires when the notice list is EMPTY', () => {
  // The real panel must survive if announcements ever exist.
  assert.match(SETTINGS_ENTRY_SHIM, /function noticesAreEmpty\(\)/);
  assert.match(SETTINGS_ENTRY_SHIM, /list\.length === 0/);
  assert.match(SETTINGS_ENTRY_SHIM, /name === 'TicketDetailController' && noticesAreEmpty\(\)/);
  // Unknown state is treated as empty (an empty panel helps nobody).
  assert.match(SETTINGS_ENTRY_SHIM, /return true;/);
});

test('notice redirect: navigates the tab instead of window.open', () => {
  // Measured: a popup from Egret's synthetic event is blocked, returning null.
  // Same-tab navigation is never blocked.
  assert.match(SETTINGS_ENTRY_SHIM, /location\.href = '\/admin'/);
  assert.doesNotMatch(SETTINGS_ENTRY_SHIM, /window\.open/);
});

test('notice redirect: wraps addViewControl once and keeps the original', () => {
  assert.match(SETTINGS_ENTRY_SHIM, /pg\.__settingsEntry/);
  assert.match(SETTINGS_ENTRY_SHIM, /var oAdd = pg\.addViewControl/);
  assert.match(SETTINGS_ENTRY_SHIM, /return oAdd\.apply\(this, arguments\)/);
  // Returning null suppresses the empty panel.
  assert.match(SETTINGS_ENTRY_SHIM, /return null;/);
});

// ------------------------------------------------------------ the port credit
// The startup notice is the one place the project's legal footing is stated, so
// the port credit may only ever ADD a line there -- never remove or reword what
// Hit-Point's copyright and Balticx's attribution say.

const REAL_INDEX = nodePath.join(__dirname, '..', '..', 'vendor', 'game', 'index.html');
const hasVendor = fs.existsSync(REAL_INDEX);

test('port credit: adds the author line to the notice', () => {
  const html = '<div id="__notice"><p>…</p>\n<p class="__sign">声明人：Balticx</p>\n'
    + '<button id="__notice_ok" type="button">我已阅读，进入游戏</button></div>';
  const out = injectPortCredit(html);
  assert.ok(out.includes(PORT_CREDIT_NAME), 'the port author is credited');
  assert.ok(out.includes('NAS / Docker 移植'), 'labelled as the port, not the game');
  // It must say PORT, so nobody reads it as a claim on the game itself.
  assert.match(out, /NAS \/ Docker 移植/);
});

test('port credit: nothing from the original notice is removed or altered', () => {
  const html = '<div id="__notice">'
    + '<h1>权利归属与告知声明</h1>'
    + '<p>…Hit-Point Co., Ltd.…</p>'
    + '<p>本程序不用于任何商业用途…</p>'
    + '<p class="__sign">声明人：Balticx</p>'
    + '<button id="__notice_ok" type="button">我已阅读，进入游戏</button></div>';
  const out = injectPortCredit(html);
  // Every original fragment survives verbatim.
  for (const fragment of ['权利归属与告知声明', 'Hit-Point Co., Ltd.', '不用于任何商业用途',
    '声明人：Balticx', '__notice_ok', '我已阅读，进入游戏']) {
    assert.ok(out.includes(fragment), 'preserved: ' + fragment);
  }
  // And nothing was dropped: output is strictly longer and starts the same.
  assert.ok(out.length > html.length);
  assert.ok(out.startsWith(html.slice(0, 40)));
});

test('port credit: rides directly after the original sign-off', () => {
  const html = '<p class="__sign">声明人：Balticx</p><button id="__notice_ok">x</button>';
  const out = injectPortCredit(html);
  const balticxAt = out.indexOf('声明人：Balticx');
  const portAt = out.indexOf(PORT_CREDIT_NAME);
  const btnAt = out.indexOf('__notice_ok');
  assert.ok(balticxAt < portAt && portAt < btnAt,
    'the two credits read together, both before the dismiss button');
});

test('port credit: is idempotent', () => {
  const html = '<p class="__sign">声明人：Balticx</p>';
  const once = injectPortCredit(html);
  const twice = injectPortCredit(once);
  assert.equal(twice, once, 'a second pass must not duplicate the line');
});

test('port credit: falls back to the button anchor if the sign-off is missing', () => {
  const html = '<div id="__notice"><p>x</p><button id="__notice_ok">y</button></div>';
  const out = injectPortCredit(html);
  assert.ok(out.includes(PORT_CREDIT_NAME));
  assert.ok(out.indexOf(PORT_CREDIT_NAME) < out.indexOf('__notice_ok'));
});

test('port credit: markup without a notice is returned untouched', () => {
  const html = '<html><body><p>no notice here</p></body></html>';
  assert.equal(injectPortCredit(html), html);
});

test('port credit: applied to the REAL index.html, with the notice intact', { skip: !hasVendor }, () => {
  const real = fs.readFileSync(REAL_INDEX, 'utf8');
  // Credit layer alone, so the byte-comparison below is not confounded by the
  // script shims (which are covered separately above).
  const out = injectPortCredit(real);

  assert.ok(out.includes(PORT_CREDIT_NAME), 'credit present');
  // All three parties must be named on the overlay.
  assert.ok(out.includes('Hit-Point'), 'copyright holder');
  assert.ok(out.includes('Balticx'), 'offline build author');
  assert.ok(out.includes(PORT_CREDIT_NAME), 'port author');
  // Still gated behind a manual dismissal.
  assert.ok(out.includes('我已阅读，进入游戏'));
  assert.ok(out.includes('__noticeDismissed = false'));

  // The original notice must survive VERBATIM except for the inserted line. Strip
  // the credit line and the result must equal the original byte for byte -- the
  // strongest form of "nothing else changed".
  const lineRe = new RegExp('\\n\\s*<p class="__sign">NAS / Docker 移植：' + PORT_CREDIT_NAME + '</p>');
  const stripped = out.replace(lineRe, '');
  assert.equal(stripped, real,
    'the served page differs from the source ONLY by the credit line');

  // And the full pipeline (shims + credit) keeps the credit in the notice.
  const full = injectPortCredit(injectTransportShim(real));
  assert.ok(full.includes(PORT_CREDIT_NAME));
  assert.ok(full.indexOf(PORT_CREDIT_NAME) < full.indexOf('__notice_ok'));
});
