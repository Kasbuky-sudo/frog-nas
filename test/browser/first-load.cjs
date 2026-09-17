'use strict';
/**
 * First-load preloader, in a real Chromium against the real server and the real
 * vendor/ tree.
 *
 * WHY THIS TEST EXISTS
 *
 * The bug it guards against only exists on a slow link, and the fix is a
 * *behaviour over time*: hold the game, transfer the blocking set at a steady
 * rate, then let the game start from cache. No unit test can see that. The unit
 * tests in test/unit/preload.test.js prove the gate logic against a fake
 * browser; this one proves the whole thing end to end, with the game's own
 * launcher.js doing the asking.
 *
 * THE THREE PROPERTIES THAT MATTER
 *
 *   1. THE GATE HOLDS. launcher.js's `manifest.json?v=<random>` XHR is the
 *      single choke point of the whole boot -- hold it and nothing else starts.
 *      Asserted by request ORDER: every /resource/ request must precede the
 *      first manifest.json XHR.
 *   2. THE TRANSFER IS SUSTAINED, not merely longer. With the link throttled
 *      through CDP, byte progress must keep advancing -- asserted as "no gap of
 *      more than GAP_MS without new bytes" -- and the pass must finish.
 *   3. THE SECOND LOAD SENDS NOTHING. A reload in the same context must open the
 *      gate immediately (reason 'warm') having issued zero /resource/ requests,
 *      which is the user-visible promise "之后就不用加载了".
 *
 * Run:  node test/browser/first-load.cjs
 * Needs playwright-core; the browser is reused from the Playwright cache, so
 * nothing is downloaded. If either is missing this exits 0 with a skip notice --
 * it is deliberately not part of `npm test`.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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

/* ---------------------------------------------------------------------- server */
/** Boot the real server against the real tree, on a scratch data dir. */
async function startServer() {
  const port = Number(process.env.FROG_TEST_PORT || (18000 + (process.pid % 2000)));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-firstload-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: '127.0.0.1',
      FROG_DATA_DIR: dataDir,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + out)), 30000);
    child.stdout.on('data', (b) => {
      out += String(b);
      if (out.indexOf('listening on') !== -1) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (b) => { out += String(b); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code + ':\n' + out)); });
  });
  await ready;
  return {
    port,
    url: 'http://127.0.0.1:' + port + '/',
    stop: () => { try { child.kill(); } catch (e) { /* already gone */ } },
    output: () => out,
  };
}

/* ------------------------------------------------------------------ assertions */
const fails = [];
function check(ok, label, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail ? '  -- ' + detail : ''));
  if (!ok) fails.push(label);
}

/** Start recording every request the page makes, in arrival order. */
async function recorder(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const events = [];
  cdp.on('Network.requestWillBeSent', (e) => events.push({ url: e.request.url, t: e.timestamp }));
  return {
    events,
    of: (re) => events.filter((e) => re.test(e.url)),
    indexOfFirst: (re) => events.findIndex((e) => re.test(e.url)),
    lastIndexOf: (re) => {
      for (let i = events.length - 1; i >= 0; i--) if (re.test(events[i].url)) return i;
      return -1;
    },
  };
}

/** The shim's own state, or null before it has run. */
const STATE = () => {
  const st = window.__frogPreload;
  if (!st) return null;
  return {
    armed: st.armed, done: st.done, reason: st.reason, phase: st.phase,
    count: st.count, doneCount: st.doneCount, fetched: st.fetched, failed: st.failed,
    loaded: st.loaded, totalBytes: st.totalBytes, gateHeld: st.gateHeld,
  };
};

async function waitForState(page, pred, label, ms) {
  const deadline = Date.now() + (ms || 120000);
  for (;;) {
    const st = await page.evaluate(STATE).catch(() => null);
    if (st && pred(st)) return st;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label + '; last=' + JSON.stringify(st));
    await page.waitForTimeout(150);
  }
}

/** Click the notice button and wait for the notice to be gone. */
async function enterGame(page) {
  await page.locator('#__notice_ok').click({ timeout: 15000 });
  await page.waitForSelector('#__notice', { state: 'detached', timeout: 15000 });
}

/* ------------------------------------------------------------------------- run */
(async () => {
  const pw = loadPlaywright();
  if (!pw) { console.log('SKIP: playwright-core not installed (this check is optional).'); process.exit(0); }
  const exe = findChromium();
  if (!exe) { console.log('SKIP: no Chromium in the Playwright browser cache.'); process.exit(0); }

  const server = await startServer();
  const plan = await fetch(server.url + '__preload/manifest', { cache: 'no-store' }).then((r) => r.json());
  console.log('server on ' + server.url
    + '  blocking=' + plan.blocking.length + '/' + (plan.bytes.blocking / 1048576).toFixed(1) + ' MB'
    + '  optional=' + plan.optional.length + '/' + (plan.bytes.optional / 1048576).toFixed(1) + ' MB'
    + '  build=' + plan.build);

  // --no-proxy-server: this machine has a system proxy set, and a throttled
  // CDP session that is also being proxied measures the proxy, not the server.
  const browser = await pw.chromium.launch({
    executablePath: exe, args: ['--no-sandbox', '--no-proxy-server'],
  });

  try {
    /* ================================================================ stage A
       A cold load, unthrottled, against the real game. */
    const ctxA = await browser.newContext({ viewport: { width: 480, height: 900 } });
    const pageA = await ctxA.newPage();
    const pageErrors = [];
    pageA.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    const recA = await recorder(pageA);

    await pageA.goto(server.url, { waitUntil: 'commit' });

    // The gate is armed before anything else, and the notice shows progress
    // instead of a live 进入游戏 button.
    const armed = await waitForState(pageA, (st) => st.armed || st.done, 'the shim to arm', 15000);
    check(armed.armed === true, 'the gate is armed while the blocking set is still coming', JSON.stringify(armed));

    /* The UI may not be mounted yet (the plan round-trip and the notice's own
       parse race each other), so wait for it rather than sampling once. */
    let ui = null;
    for (let i = 0; i < 100 && !ui; i++) {
      ui = await pageA.evaluate(() => {
        const box = document.getElementById('__frog_preload');
        const ok = document.getElementById('__notice_ok');
        return box && ok ? {
          insideNotice: !!document.querySelector('#__notice #__frog_preload'),
          okDisabled: ok.disabled, okText: ok.textContent,
          bar: (document.getElementById('__frog_preload_bar') || {}).style
            ? document.getElementById('__frog_preload_bar').style.width : null,
        } : null;
      }).catch(() => null);
      if (!ui) await pageA.waitForTimeout(100);
    }
    check(!!ui && ui.insideNotice, 'the progress box lives inside the rights notice');
    check(!!ui && ui.okDisabled === true, '进入游戏 is disabled while the blocking set downloads',
      ui ? 'text=' + JSON.stringify(ui.okText) : 'no ui');
    check(!!ui && ui.okText.indexOf('预载') !== -1, 'and says so: ' + (ui && ui.okText));

    const stA = await waitForState(pageA, (st) => st.done, 'the cold blocking pass to finish', 180000);
    check(stA.reason === 'ok', 'a clean cold pass opens the gate with reason "ok"', stA.reason);
    check(stA.count === stA.doneCount,
      'every blocking file was fetched: ' + stA.doneCount + '/' + stA.count);
    check(stA.fetched >= plan.blocking.length,
      'the plan was followed (' + stA.fetched + ' fetches for ' + plan.blocking.length + ' blocking files)');

    // THE GATE. Order is the evidence: the game cannot ask for a resource
    // before it has manifest.json, and manifest.json is exactly what we held.
    const manifestAt = recA.indexOfFirst(/manifest\.json\?v=/);
    const lastResAt = recA.lastIndexOf(/\/resource\/China\//);
    check(manifestAt > -1, 'launcher.js did ask for manifest.json');
    check(manifestAt > lastResAt && lastResAt > -1,
      'the game\'s manifest XHR was held until the blocking set was in',
      'manifest@' + manifestAt + ' lastResource@' + lastResAt);

    const opened = await pageA.evaluate(() => {
      const ok = document.getElementById('__notice_ok');
      const box = document.getElementById('__frog_preload');
      return { disabled: ok.disabled, text: ok.textContent, boxHidden: !box || box.style.display === 'none' };
    });
    check(opened.disabled === false, 'the button is re-enabled once the pass is done');
    check(opened.boxHidden === true, 'and the progress box is hidden again');
    check(opened.text.indexOf('预载') === -1, 'the button wording is restored: ' + JSON.stringify(opened.text));

    await enterGame(pageA);
    check(await pageA.evaluate(() => window.__noticeDismissed === true),
      'the player can enter the game (notice dismissed, game not blocked behind it)');

    /* ================================================================ stage B
       The same browser again: the promise "之后就不用加载了". */
    const pageB = await ctxA.newPage();
    const recB = await recorder(pageB);
    await pageB.goto(server.url, { waitUntil: 'commit' });
    const stB = await waitForState(pageB, (st) => st.done, 'the warm pass to decide', 60000);

    const manifestB = recB.indexOfFirst(/manifest\.json\?v=/);
    const resBeforeManifest = recB.events
      .slice(0, manifestB < 0 ? recB.events.length : manifestB)
      .filter((e) => /\/resource\/China\//.test(e.url));
    check(stB.reason === 'warm', 'a second visit is recognised as warm', stB.reason);
    check(stB.count === 0, 'with nothing outstanding', String(stB.count));
    check(resBeforeManifest.length === 0,
      'the warm pass issues ZERO resource requests -- nothing is downloaded twice',
      resBeforeManifest.length + ' request(s): '
        + resBeforeManifest.slice(0, 3).map((e) => e.url.split('/').slice(-1)[0]).join(', '));
    await pageB.close();

    /* ================================================================ stage C
       A cold load on a throttled link -- the reported symptom, reproduced, and
       checked for the thing that was wrong: the transfer has to keep moving. */
    const GAP_MS = 6000;
    const RATE = Number(process.env.FROG_TEST_RATE || 4 * 1024 * 1024);   // bytes/s
    const ctxC = await browser.newContext({ viewport: { width: 480, height: 900 } });
    const pageC = await ctxC.newPage();
    const cdpC = await ctxC.newCDPSession(pageC);
    await cdpC.send('Network.enable');
    await cdpC.send('Network.emulateNetworkConditions', {
      offline: false, latency: 80, downloadThroughput: RATE, uploadThroughput: RATE / 4,
    });

    await pageC.goto(server.url, { waitUntil: 'commit' });
    const samples = [];
    const t0 = Date.now();
    let stC = null;
    for (;;) {
      const st = await pageC.evaluate(STATE).catch(() => null);
      if (st) {
        samples.push({ t: Date.now() - t0, loaded: st.loaded });
        if (st.done) { stC = st; break; }
      }
      if (Date.now() - t0 > 300000) throw new Error('the throttled pass never finished: ' + JSON.stringify(st));
      await pageC.waitForTimeout(200);
    }

    // Gaps between byte increases. A loader that stalls and gives up shows up
    // here as one long gap; a sustained transfer has none.
    let worstGap = 0;
    let worstAt = 0;
    let prev = { t: 0, loaded: 0 };
    for (const s of samples) {
      if (s.loaded > prev.loaded) {
        const gap = s.t - prev.t;
        if (gap > worstGap) { worstGap = gap; worstAt = s.t; }
        prev = s;
      }
    }
    const total = Date.now() - t0;
    const mb = (stC.loaded / 1048576).toFixed(1);
    console.log('     throttled: ' + mb + ' MB in ' + (total / 1000).toFixed(1) + 's  ('
      + (stC.loaded / 1024 / (total / 1000)).toFixed(0) + ' KB/s), worst gap '
      + worstGap + 'ms @' + worstAt + 'ms, samples=' + samples.length);

    check(stC.reason === 'ok', 'the throttled pass also finishes cleanly', stC.reason);
    check(stC.count === stC.doneCount, 'nothing was left behind: ' + stC.doneCount + '/' + stC.count);
    check(worstGap < GAP_MS,
      'the transfer never stalls for more than ' + GAP_MS + 'ms (that is the "网速就没了" bug)',
      'worst gap ' + worstGap + 'ms');
    check(stC.loaded > plan.bytes.blocking * 0.98,
      'the blocking set really moved: ' + mb + ' MB of '
        + (plan.bytes.blocking / 1048576).toFixed(1) + ' MB');
    await ctxC.close();

    /* ================================================================ stage D
       A file the plan lists but the tree does not have. It must be reported,
       not retried five times over a slow link, and it must not gate the game. */
    const ctxD = await browser.newContext({ viewport: { width: 480, height: 900 } });
    const pageD = await ctxD.newPage();
    const bogus = 'resource/China/__not_in_the_tree__.png';
    const doctored = JSON.parse(JSON.stringify(plan));
    doctored.blocking = doctored.blocking.slice(0, 12)
      .concat([{ url: bogus, size: 4096 }]);
    await pageD.route('**/__preload/manifest*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(doctored),
    }));
    const recD = await recorder(pageD);
    await pageD.goto(server.url, { waitUntil: 'commit' });
    const stD = await waitForState(pageD, (st) => st.done, 'the doctored plan to finish', 60000);

    const bogusHits = recD.of(/__not_in_the_tree__/).length;
    check(stD.done === true, 'one missing file does not trap the player');
    check(bogusHits === 1, 'a 404 is asked for exactly once, not retried', bogusHits + ' request(s)');
    check(stD.reason === 'partial', 'and it is reported honestly as a partial pass', stD.reason);
    await ctxD.close();

    if (pageErrors.length) console.log('note: page errors seen (not asserted):\n  ' + pageErrors.slice(0, 4).join('\n  '));
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(fails.length ? '\n' + fails.length + ' check(s) failed.' : '\nall first-load checks passed.');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
