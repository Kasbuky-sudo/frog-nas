'use strict';
/**
 * Phone-only regression check for the 编辑 menu entry.
 *
 * WHY THIS EXISTS AS A BROWSER TEST: the bug it guards against is invisible on a
 * desktop. The cover used to preventDefault() touchstart/touchend, and a touch
 * whose start or end is default-prevented never gets a synthesized `click` -- so
 * the entry was completely dead on a phone while working perfectly with a mouse.
 * No unit test can see that: it is browser gesture behaviour, not our logic. Only
 * a real Chromium with touch input can tell the two apart.
 *
 * Run:  node test/browser/touch-tap.cjs
 * Needs playwright-core (the browser itself is reused from the Playwright cache,
 * so nothing is downloaded). If it is not installed the script exits 0 with a
 * skip notice -- it is not part of `npm test`.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

/* ------------------------------------------------------------------ playwright */
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    path.join(ROOT, 'node_modules'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      return require(require.resolve('playwright-core', { paths: [dir] }));
    } catch (e) { /* try the next one */ }
  }
  return null;
}

/* The managed Chromium lives in the Playwright browser cache; version checks are
   bypassed by passing the executable explicitly. */
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return null; }
  const dirs = entries.filter((n) => n.startsWith('chromium-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const sub = ['chrome-win64', 'chrome-win', 'chrome-linux', 'chrome-mac'];
  for (const d of dirs) {
    for (const s of sub) {
      const exe = path.join(root, d, s, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/* --------------------------------------------------------------------- the shim */
/** Extract MENU_SHIM's `<script>` body from the served source, so the test runs
 *  the code that actually ships rather than a copy that can drift. */
function menuShimSource() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'static.js'), 'utf8');
  const m = /const MENU_SHIM = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error('MENU_SHIM not found in src/static.js');
  return m[1].replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
}

/* ------------------------------------------------------------- stub game page */
/**
 * A page carrying exactly the seams the shim touches: an `egret` stage whose
 * MainOut.exml view holds the menu plaques, a canvas for scaleFactor(), and the
 * probe's own editor reduced to a ball whose onclick flips a panel.
 */
function gamePage(shim) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<canvas id="__stage" style="display:block;width:640px;height:1136px"></canvas>
<script>
(function () {
  function node(w, h, x, y) {
    return {
      width: w, height: h, visible: true, includeInLayout: true, touchEnabled: true,
      $children: [], localToGlobal: function () { return { x: x, y: y }; },
    };
  }
  var view = node(640, 1136, 0, 0);
  /* the walk identifies the view by String(constructor) containing "MainOut.exml" */
  view.constructor = { toString: function () { return 'MainOut.exml'; } };
  view.btnSpringCard = node(84, 88, 10, 10);
  view.btnPartyCake = node(84, 88, 10, 110);
  view.btnGreetCard = node(84, 88, 120, 300);      /* repurposed as 编辑 */
  view.ticketDetailBtn = node(84, 88, 120, 420);   /* relabelled 推送设置 */
  window.egret = {
    MainContext: { instance: { stage: { stageHeight: 1136, $children: [view] } } },
  };

  var panel = document.createElement('div');
  panel.id = '__save_panel';
  panel.style.display = 'none';
  document.body.appendChild(panel);

  var ball = document.createElement('div');
  ball.id = '__save_ball';
  var flip = function () { panel.style.display = (panel.style.display === 'block') ? 'none' : 'block'; };
  ball.onclick = flip;
  document.body.appendChild(ball);

  /* Count real open/close transitions, so a double toggle is visible as 2. */
  window.__flips = 0;
  ball.onclick = function () {
    var before = panel.style.display;
    flip();
    if (panel.style.display !== before) window.__flips++;
  };
})();
</script>
<script>
${shim}
<\/script>
</body></html>`;
}

/** The mechanism under test, isolated: identical divs, one cancelling the gesture
 *  and one merely stopping propagation. */
const MECHANISM_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<div id="killed" style="width:200px;height:200px;background:#ccc"></div>
<div id="alive" style="width:200px;height:200px;background:#ddd"></div>
<script>
window.__clicks = { killed: 0, alive: 0 };
var stop = function (e) { e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); };
var kill = function (e) { e.preventDefault(); stop(e); };
var k = document.getElementById('killed');
['touchstart', 'touchend'].forEach(function (t) {
  k.addEventListener(t, kill, { capture: true, passive: false });
});
k.addEventListener('click', function () { window.__clicks.killed++; });
var a = document.getElementById('alive');
['touchstart', 'touchend'].forEach(function (t) {
  a.addEventListener(t, stop, { capture: true, passive: true });
});
a.addEventListener('click', function () { window.__clicks.alive++; });
</script>
</body></html>`;

/* ------------------------------------------------------------------------ run */
(async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log('SKIP: playwright-core not installed (this check is optional).');
    process.exit(0);
  }
  const exe = findChromium();
  if (!exe) {
    console.log('SKIP: no Chromium in the Playwright browser cache.');
    process.exit(0);
  }

  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    hasTouch: true, isMobile: true, viewport: { width: 640, height: 1136 },
  });
  const page = await ctx.newPage();
  /* Surface anything the page throws: a shim that fails to parse would otherwise
     only show up as a missing button, which is exactly the symptom under test. */
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  const fails = [];
  const check = (ok, label, detail) => {
    console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail ? '  -- ' + detail : ''));
    if (!ok) fails.push(label);
  };

  /* ---- 1. the mechanism itself: this is what made the button dead on a phone */
  await page.setContent(MECHANISM_PAGE);
  await page.tap('#killed');
  await page.tap('#alive');
  const clicks = await page.evaluate(() => window.__clicks);
  check(clicks.killed === 0,
    'a default-prevented touch produces NO click (the original bug)',
    'clicks=' + clicks.killed);
  check(clicks.alive === 1,
    'stopping propagation alone still lets the click through (the fix)',
    'clicks=' + clicks.alive);

  /* ---- 2. the real shim, tapped with real touch input */
  await page.setContent(gamePage(menuShimSource()));
  try {
    await page.waitForSelector('#__menu_editor', { state: 'visible', timeout: 5000 });
  } catch (e) {
    console.error('the cover never appeared; page errors:\n  '
      + (pageErrors.join('\n  ') || '(none)'));
    throw e;
  }

  const box = await page.locator('#__menu_editor').boundingBox();
  // boundingBox() is {x, y, width, height}; the plaque sits at 120,300 (84x88) in
  // the stub, i.e. at the stage's own coordinates with scale 1.
  check(!!box && box.width > 20 && box.height > 20 && box.x === 120 && box.y === 300,
    'the 编辑 cover is positioned over the plaque',
    box ? Math.round(box.width) + 'x' + Math.round(box.height)
      + ' @' + Math.round(box.x) + ',' + Math.round(box.y) : 'no box');

  await page.tap('#__menu_editor');
  await page.waitForTimeout(250);
  let state = await page.evaluate(() => ({
    flips: window.__flips, display: document.getElementById('__save_panel').style.display,
  }));
  check(state.flips === 1 && state.display === 'block',
    'one touch tap opens the editor exactly once',
    JSON.stringify(state));

  await page.tap('#__menu_editor');
  await page.waitForTimeout(250);
  state = await page.evaluate(() => ({
    flips: window.__flips, display: document.getElementById('__save_panel').style.display,
  }));
  check(state.flips === 2 && state.display === 'none',
    'a second tap closes it (no swallowed double-toggle)',
    JSON.stringify(state));

  /* ---- 3. a drag that starts on the button is the menu scrolling, not a tap */
  await page.evaluate(() => {
    const el = document.getElementById('__menu_editor');
    const r = el.getBoundingClientRect();
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      return new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: [t], targetTouches: [t], changedTouches: [t],
      });
    };
    el.dispatchEvent(mk('touchstart', r.left + 10, r.top + 10));
    el.dispatchEvent(mk('touchmove', r.left + 10, r.top + 70));
    el.dispatchEvent(mk('touchend', r.left + 10, r.top + 70));
  });
  await page.waitForTimeout(200);
  state = await page.evaluate(() => window.__flips);
  check(state === 2, 'a drag over the button does not open the editor', 'flips=' + state);

  await browser.close();
  console.log(fails.length ? '\n' + fails.length + ' check(s) failed.' : '\nall touch checks passed.');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
