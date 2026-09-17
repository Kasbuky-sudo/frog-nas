'use strict';
/**
 * Unit tests for the first-load preloader: the server-side plan
 * (src/preload.js) and the injected client shim (src/preload-shim.js).
 *
 * WHY THE PLAN IS TESTED AGAINST THE REAL vendor/ TREE
 *
 * The whole point of computing the plan on the server is that it names the
 * exact files the client is about to ask for. A test against a fixture would
 * prove nothing: the failure that matters is the plan and the game drifting
 * apart, and only the shipped tree can catch it. So every expectation below is
 * derived from default.res.json / manifest.json and then checked against the
 * real files on disk.
 *
 * WHY THE SHIM IS RUN, NOT JUST PARSED
 *
 * The shim's risky behaviour is ordering and release: it must arm before any
 * game script runs, hold launcher.js's manifest XHR, and release it exactly
 * once through the prototype chain (so the later XHR_TIMEOUT_SHIM still runs).
 * A syntax check cannot see any of that, so the shim is executed in a vm with a
 * fake XMLHttpRequest and a controllable fetch, and the assertions are made on
 * what it actually did.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const nodePath = require('path');
const vm = require('node:vm');

const ROOT = nodePath.join(__dirname, '..', '..');
const GAME_DIR = nodePath.join(ROOT, 'vendor', 'game');
const RES_DIR = nodePath.join(ROOT, 'vendor', 'resource');

const { PreloadPlanner, seasonKey, seasonGroup, BOOT_GROUPS } = require('../../src/preload');
const { preloadShim, SHIM_BODY } = require('../../src/preload-shim');
const { injectPreload, injectTransportShim } = require('../../src/static');

const VERSION = require('../../package.json').version;

function planner() {
  return new PreloadPlanner({
    gameDir: GAME_DIR, resourceDir: RES_DIR, language: 'China', version: VERSION,
  });
}

/** default.res.json + manifest.json, parsed independently of src/preload.js so a
 *  bug in the reader cannot be hidden by the same bug in the expectation. */
function rawConfigs() {
  const res = JSON.parse(fs.readFileSync(nodePath.join(RES_DIR, 'China', 'default.res.json'), 'utf8'));
  const byName = new Map();
  for (const r of res.resources) if (!byName.has(r.name)) byName.set(r.name, r);
  const groups = new Map();
  for (const g of res.groups) groups.set(g.name, String(g.keys || '').split(',').filter(Boolean));
  const mf = JSON.parse(fs.readFileSync(nodePath.join(GAME_DIR, 'manifest.json'), 'utf8'));
  return { res, byName, groups, js: mf.initial.concat(mf.game) };
}

/* ===================================================================== season */

test('seasonKey: the engine\'s own month and hour buckets, boundary by boundary', () => {
  const at = (m, h) => seasonKey(new Date(2026, m - 1, 15, h, 0, 0));
  // months, checked at the two sides of every edge the engine carves out
  assert.equal(at(2, 12), '41', 'February is winter / day');
  assert.equal(at(3, 12), '11', 'March flips to spring');
  assert.equal(at(5, 12), '11', 'May is still spring');
  assert.equal(at(6, 12), '21', 'June flips to summer');
  assert.equal(at(8, 12), '21', 'August is still summer');
  assert.equal(at(9, 12), '31', 'September flips to autumn');
  assert.equal(at(11, 12), '31', 'November is still autumn');
  assert.equal(at(12, 12), '41', 'December flips to winter');
  // hours: 6..17 day, 18..20 evening, 21..23 night, 0..5 late night
  assert.equal(at(9, 5), '34', '05:00 is the late-night bucket');
  assert.equal(at(9, 6), '31', '06:00 starts the day');
  assert.equal(at(9, 17), '31', '17:59 is still the day');
  assert.equal(at(9, 18), '32', '18:00 starts the evening');
  assert.equal(at(9, 20), '32', '20:59 is still the evening');
  assert.equal(at(9, 21), '33', '21:00 starts the night');
  assert.equal(at(9, 23), '33', '23:59 is still the night');
});

test('seasonGroup: the group name the client asks for is season + key', () => {
  assert.equal(seasonGroup(new Date(2026, 8, 15, 12)), 'season31');
  assert.match(seasonGroup(new Date()), /^season[1-4][1-4]$/);
});

/* ======================================================================= plan */

test('plan: blocking opens with the 17 engine scripts, in launcher.js\'s order', () => {
  const { js } = rawConfigs();
  const plan = planner().plan();
  const got = plan.blocking.slice(0, js.length).map((f) => f.url);
  assert.deepEqual(got, js.map((u) => u.replace(/^\.?\//, '')));
  // The engine bundle list is what index.html's own <script src> tags load; if a
  // future source package adds one, the plan has to grow with it.
  assert.equal(js.length, 17, 'manifest.json lists 15 initial + 2 game scripts');
});

test('plan: blocking carries the boot bundles and the CURRENT season, nothing else', () => {
  const plan = planner().plan();
  const urls = new Set(plan.blocking.map((f) => f.url));
  for (const bundle of ['preload', 'config', 'system', 'mainout']) {
    assert.ok(urls.has('resource/China/eab/' + bundle + '.eab'),
      bundle + '.eab must be preloaded');
  }
  assert.ok(urls.has('resource/China/eab/' + plan.season + '.eab'),
    'the current season bundle (' + plan.season + ') must be preloaded');
  assert.equal(plan.season, seasonGroup(new Date()),
    'the plan must name the season the client will ask for right now');

  // Every other season is optional: 16 bundles exist, one is in blocking.
  const others = [...urls].filter((u) => /\/eab\/season\d\d\.eab$/.test(u) && u !== 'resource/China/eab/' + plan.season + '.eab');
  assert.equal(others.length, 0, 'no other season bundle may gate the first load');
  const optional = new Set(plan.optional.map((f) => f.url));
  assert.ok([...optional].some((u) => /\/eab\/season\d\d\.eab$/.test(u)),
    'the other seasons are still warmed in the background');
});

test('plan: the 18 sheet atlases are blocking (they are most of the transfer)', () => {
  const plan = planner().plan();
  const sheets = plan.blocking.filter((f) => f.url.indexOf('resource/China/sheet/') === 0);
  assert.equal(sheets.length, 36, '18 atlases x (json + png)');
  const pngs = sheets.filter((f) => f.url.endsWith('.png'));
  assert.equal(pngs.length, 18);
  const bytes = pngs.reduce((n, f) => n + f.size, 0);
  assert.ok(bytes > 15 * 1048576, 'the atlases really are the bulk: ' + bytes + ' bytes');
});

test('plan: gameConfig.json is excluded on purpose', () => {
  const plan = planner().plan();
  const all = plan.blocking.concat(plan.optional).map((f) => f.url);
  // Served per request with a rewritten WS endpoint and `no-cache`, so a warmed
  // copy could never be reused -- preloading it would be pure waste.
  assert.ok(!all.includes('resource/China/config/gameConfig.json'));
  assert.ok(all.includes('resource/China/eab/config.eab'),
    'the rest of the config group IS preloaded, inside its bundle');
});

test('plan: blocking and optional partition the list, with no overlap', () => {
  const plan = planner().plan();
  const b = plan.blocking.map((f) => f.url);
  const o = plan.optional.map((f) => f.url);
  assert.equal(new Set(b).size, b.length, 'blocking has no duplicate url');
  assert.equal(new Set(o).size, o.length, 'optional has no duplicate url');
  const overlap = b.filter((u) => o.indexOf(u) !== -1);
  assert.deepEqual(overlap, [], 'a url must not be in both lists');
  assert.equal(plan.blockingCount, b.length, 'blockingCount marks where the gate stops');
  assert.ok(b.length >= 60 && b.length < 200, 'blocking is ~90 files, got ' + b.length);
  assert.ok(o.length > 1000, 'optional is the rest of the tree, got ' + o.length);
});

test('plan: every entry names a real file whose size matches stat()', () => {
  const plan = planner().plan();
  const sum = (list) => list.reduce((n, f) => n + f.size, 0);
  for (const f of plan.blocking.concat(plan.optional)) {
    const file = f.url.indexOf('resource/China/') === 0
      ? nodePath.join(RES_DIR, 'China', f.url.slice('resource/China/'.length))
      : nodePath.join(GAME_DIR, f.url);
    const st = fs.statSync(file);              // throws if the plan invented a url
    assert.equal(f.size, st.size, f.url + ' size must be the real one');
    assert.ok(f.size > 0, f.url + ' must not be zero-sized');
  }
  assert.equal(plan.bytes.blocking, sum(plan.blocking));
  assert.equal(plan.bytes.optional, sum(plan.optional));
  assert.equal(plan.bytes.total, plan.bytes.blocking + plan.bytes.optional);
});

test('plan: the blocking set is a sane fraction of the tree, not all of it', () => {
  const plan = planner().plan();
  // 32 MB of 258 MB: preloading everything before the player is allowed in
  // would be a 8-minute wait on the relay, so the split is the whole design.
  assert.ok(plan.bytes.blocking > 25 * 1048576, 'blocking is tens of MB');
  assert.ok(plan.bytes.blocking < 45 * 1048576, 'blocking stays near 32 MB, got ' + plan.bytes.blocking);
  assert.ok(plan.bytes.optional > plan.bytes.blocking * 3, 'the optional tail is much larger');
});

test('build: version-prefixed content hash, stable for an unchanged tree', () => {
  const p = planner();
  const build = p.build();
  // The prefix is package.json's version, so a release always invalidates the
  // client's resume ledger; the suffix is a hash of the resource tree.
  assert.match(build, new RegExp('^' + VERSION.replace(/\./g, '\\.') + '-[0-9a-f]{12}$'),
    'got ' + build);
  assert.equal(build, p.build(), 'the fingerprint must be deterministic');
  assert.equal(p.plan().build, build, 'the plan carries the same build id');
});

test('plan: memoised on (build, season) and re-planned when either moves', () => {
  const p = planner();
  const first = p.plan();
  assert.strictEqual(p.plan(), first, 'an unchanged tree must not be re-planned');
  assert.ok(p.cache && p.cache.season, 'the season takes part in the cache key');

  // A server that is up across an hours boundary must serve the NEW season
  // group, not the one it planned at boot. Simulated by poisoning the memo with
  // a stale season (the build is left correct, so only the season can be why
  // the memo is rejected).
  const poisoned = { poisoned: true };
  p.cache = { build: p.build(), season: 'season09', plan: poisoned };
  const again = p.plan();
  assert.notStrictEqual(again, poisoned, 'a stale season must invalidate the memo');
  assert.ok(Array.isArray(again.blocking), 'and the result is a real plan');
  assert.equal(again.season, seasonGroup(new Date()));
});

test('planner: BOOT_GROUPS is the two loadGroups() call sites, nothing more', () => {
  // main.min.js: loadGroups("game", ["config","system","system2","mainout","sheet"])
  //             (+ "music_App" when GameConfig.isAPP)
  //             then loadGroups("game", ["season" + WeatherModel.getSeasonKey()])
  assert.deepEqual(BOOT_GROUPS,
    ['preload', 'config', 'system', 'system2', 'mainout', 'sheet', 'music_App']);
  const plan = planner().plan();
  const urls = new Set(plan.blocking.map((f) => f.url));
  assert.ok(urls.has('resource/China/eab/mainout.eab'), 'mainout is in the boot call');
  assert.ok([...urls].some((u) => u.indexOf('resource/China/music_App/') === 0),
    'music_App is in the boot call too (isAPP is falsy here, but the group is named)');
});

/* ======================================================================= shim */

/** Extract SHIM_BODY with the build token substituted, as .replace() would. */
function shimBody(build) {
  return SHIM_BODY.replace("'__BUILD__'", JSON.stringify(String(build)));
}

test('shim: valid standalone JavaScript, with the build id substituted', () => {
  const src = preloadShim('1.2.3-abcdefabcdef');
  assert.ok(src.startsWith('<script>'));
  assert.ok(src.trimEnd().endsWith('</script>'));
  const body = src.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  assert.doesNotThrow(() => new vm.Script(body, { filename: 'preload-shim.js' }));
  assert.ok(body.indexOf('"1.2.3-abcdefabcdef"') !== -1, 'the build id is embedded quoted');
  assert.ok(SHIM_BODY.indexOf("'__BUILD__'") !== -1, 'the raw template keeps its token');
});

test('shim: no stray backtick can close the template literal early', () => {
  // Same structural guard static.test.js applies to its five shims: between the
  // opening `const SHIM_BODY = \`` and its closing backtick there must be no
  // other backtick. A backtick in a comment silently ends the string.
  const lines = fs.readFileSync(nodePath.join(ROOT, 'src', 'preload-shim.js'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^const SHIM_BODY = `/.test(l));
  assert.ok(start >= 0, 'SHIM_BODY is defined as a template literal');
  let closed = -1;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].indexOf('`') >= 0) { closed = j; break; }
  }
  assert.ok(closed > start, 'SHIM_BODY is closed with a backtick');
  for (let j = start + 1; j < closed; j++) {
    assert.ok(lines[j].indexOf('`') < 0,
      'stray backtick inside SHIM_BODY on line ' + (j + 1) + ': ' + lines[j].trim().slice(0, 80));
    assert.ok(!/\$\{/.test(lines[j]),
      'stray template placeholder inside SHIM_BODY on line ' + (j + 1));
  }
});

test('shim: injected first in <head>, ahead of the engine bundle and the other shims', () => {
  const html = '<html><head><meta charset="utf-8">'
    + '<script src="__offline-engine.js"></script><script src="__probe.js"></script>'
    + '</head><body></body></html>';
  const out = injectPreload(injectTransportShim(html), '1.0.3-x');
  const preloadAt = out.indexOf('__frogPreload');
  const marks = ['searchParams.set(\'transport\', \'ws\')', '__frogXhrTimeout'];
  for (const m of marks) {
    const at = out.indexOf(m);
    assert.ok(at > 0, 'sibling shim present: ' + m);
    assert.ok(preloadAt < at, 'the preload gate must be armed before ' + m);
  }
  assert.ok(preloadAt < out.indexOf('<script src="__offline-engine.js"'),
    'and before the engine bundle, which is what issues the first XHR');
});

test('shim: applying it twice does not inject two gates', () => {
  const html = '<html><head></head><body></body></html>';
  const once = injectPreload(html, 'b');
  assert.equal(injectPreload(once, 'b'), once);
});

test('shim: a document with no <head> still gets the gate (prepended)', () => {
  const out = injectPreload('<html><body>x</body></html>', 'b');
  assert.ok(out.indexOf('__frogPreload') < out.indexOf('<body>'));
});

'use strict';
/* ------------------------------------------------- a fake browser to run it in */

/**
 * Run the shim in a vm with just enough browser to exercise the gate.
 *
 * The XHR is a recorder, so "held" is observable as "not sent yet"; fetch is
 * split into the plan request (controlled by opts.manifest) and resource
 * requests (opts.resource), which is what lets a test keep the plan pending and
 * watch the gate hold.
 */
function runShim(opts) {
  opts = opts || {};
  const log = [];
  const sent = [];
  const listeners = {};
  const elements = {};
  let ledger = null;

  function FakeXHR() {}
  FakeXHR.prototype.open = function (m, u) { this.__test = { m, u }; };
  FakeXHR.prototype.send = function () { sent.push(String(this.__test.u)); };
  FakeXHR.prototype.abort = function () { this.__testAborted = true; };
  FakeXHR.prototype.addEventListener = function () {};

  const timers = new Set();
  const setT = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); timers.add(t); return t; };
  const setI = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); timers.add(t); return t; };

  const sandbox = {
    console: { log: (m) => log.push(String(m)) },
    setTimeout: setT,
    clearTimeout: (t) => { timers.delete(t); clearTimeout(t); },
    setInterval: setI,
    clearInterval: (t) => { timers.delete(t); clearInterval(t); },
    Uint8Array,
    Promise,
    Date,
    Math,
    JSON,
    String,
    AbortController,
    /* The ledger is stored as base64; a vm context gets only the ECMAScript
       built-ins, so btoa/atob have to be handed over explicitly or every
       saveLedger() silently falls into its try/catch. */
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    XMLHttpRequest: FakeXHR,
    location: { search: opts.search || '' },
    fetch: (url) => {
      if (url === '/__preload/manifest') return opts.manifest(opts.plan);
      if (url === '/__log') { log.push('beacon'); return Promise.resolve({ ok: true }); }
      return opts.resource(url);
    },
    document: {
      readyState: 'loading',
      hidden: false,
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      getElementById: (id) => elements[id] || null,
      createElement: () => ({ setAttribute() {}, style: {}, addEventListener() {} }),
    },
    navigator: { userAgent: 'test-agent', sendBeacon: () => true },
    localStorage: {
      getItem: (k) => {
        if (k === '__frog_preload_off') return opts.optOut ? '1' : null;
        if (k === '__frog_preload_v1' && opts.ledger) return opts.ledger;
        return ledger && ledger.k === k ? ledger.v : null;
      },
      setItem: (k, v) => { ledger = { k, v }; },
    },
  };
  if (opts.noFetch) delete sandbox.fetch;

  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  new vm.Script(shimBody(opts.build || 'test-build-1'), { filename: 'preload-shim.js' }).runInContext(ctx);

  return {
    st: sandbox.window && sandbox.window.__frogPreload,
    log,
    sent,
    sandbox,
    ledger: () => ledger,
    stop: () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); },
    fireDomReady: () => (listeners.DOMContentLoaded || []).forEach((fn) => fn()),
  };
}

/** A resource response: one chunk, then done -- enough for the stream reader. */
function okResource() {
  return () => {
    let used = 0;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: () => { used++; return Promise.resolve({ done: used > 1 }); } }) },
    });
  };
}

/** A plan response that resolves immediately. */
function okPlan(plan) {
  return () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(plan) });
}

const TEST_PLAN = {
  build: 'test-build-1',
  season: 'season31',
  blockingCount: 2,
  blocking: [{ url: 'js/a.js', size: 10 }, { url: 'js/b.js', size: 20 }],
  optional: [{ url: 'resource/China/x.png', size: 30 }],
  bytes: { blocking: 30, optional: 30, total: 60 },
};

/** A ledger whose every bit is set, for the current build. n = number of files. */
function fullLedger(build, n) {
  return JSON.stringify({ b: build, m: Buffer.alloc((n + 7) >> 3, 0xff).toString('base64') });
}

/** Poll until `fn()` is truthy, or fail. */
async function until(fn, label, ms) {
  const deadline = Date.now() + (ms || 3000);
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + label);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Issue the XHR launcher.js issues first, through the (patched) prototype. */
function gameManifestXhr(env, url) {
  const xhr = new env.sandbox.XMLHttpRequest();
  xhr.open('GET', url || 'manifest.json?v=0.5');
  env.sandbox.XMLHttpRequest.prototype.send.call(xhr, null);
  return xhr;
}

test('shim: arms synchronously, then holds launcher.js\'s manifest XHR', async (t) => {
  let releasePlan;
  const pending = new Promise((r) => { releasePlan = r; });
  const env = runShim({ plan: TEST_PLAN, manifest: () => pending, resource: okResource() });
  t.after(env.stop);

  assert.ok(env.st, 'the shim installed itself');
  assert.equal(env.st.armed, true, 'the gate must be armed before the first game script runs');

  gameManifestXhr(env);
  assert.deepEqual(env.sent, [], 'the request must be held, not sent');
  assert.equal(env.st.gateHeld, 1, 'and counted as held');

  releasePlan({ ok: true, status: 200, json: () => Promise.resolve(TEST_PLAN) });
  await until(() => env.st.done, 'the gate to open');

  assert.deepEqual(env.sent, ['manifest.json?v=0.5'], 'released exactly once, url unchanged');
  assert.equal(env.st.reason, 'ok');
  assert.equal(env.st.gateHeld, 0);
  assert.ok(env.log.some((l) => l.indexOf('blocking done') !== -1), 'the pass reported itself');
});

test('shim: the release re-enters through the prototype, so later patches still run', async (t) => {
  const env = runShim({ plan: TEST_PLAN, manifest: okPlan(TEST_PLAN), resource: okResource() });
  t.after(env.stop);

  gameManifestXhr(env);
  assert.deepEqual(env.sent, [], 'held');

  // A script that loads AFTER the shim (XHR_TIMEOUT_SHIM does exactly this)
  // patches send again. The release must go through the prototype chain, or
  // Egret's missing default timeout would silently come back.
  let laterPatch = 0;
  const before = env.sandbox.XMLHttpRequest.prototype.send;
  env.sandbox.XMLHttpRequest.prototype.send = function (b) { laterPatch++; return before.call(this, b); };

  await until(() => env.st.done, 'the gate to open');
  assert.equal(laterPatch, 1, 'the later patch saw the released request');
  assert.deepEqual(env.sent, ['manifest.json?v=0.5']);
});

test('shim: an aborted held request is dropped, never fired late', async (t) => {
  let releasePlan;
  const env = runShim({
    plan: TEST_PLAN,
    manifest: () => new Promise((r) => { releasePlan = r; }),
    resource: okResource(),
  });
  t.after(env.stop);

  const xhr = gameManifestXhr(env);
  xhr.abort();
  releasePlan({ ok: true, status: 200, json: () => Promise.resolve(TEST_PLAN) });
  await until(() => env.st.done, 'the gate to open');
  assert.deepEqual(env.sent, [], 'an aborted request must not be sent afterwards');
});

test('shim: a warm ledger is a no-op -- nothing is fetched a second time', async (t) => {
  const all = TEST_PLAN.blocking.concat(TEST_PLAN.optional);
  let fetched = 0;
  const env = runShim({
    plan: TEST_PLAN,
    manifest: okPlan(TEST_PLAN),
    resource: (u) => { fetched++; return okResource()(); },
    ledger: fullLedger(TEST_PLAN.build, all.length),
  });
  t.after(env.stop);

  await until(() => env.st.done, 'the warm run to finish');
  assert.equal(env.st.reason, 'warm', 'a fully warm ledger opens the gate immediately');
  assert.equal(env.st.count, 0, 'and there is nothing outstanding');
  assert.equal(fetched, 0, 'no resource request at all: "之后就不用加载了"');
  assert.deepEqual(env.sent, [], 'and no gate was ever needed');
});

test('shim: a cold run fetches the blocking set and records progress', async (t) => {
  let fetched = 0;
  const env = runShim({
    plan: TEST_PLAN,
    manifest: okPlan(TEST_PLAN),
    resource: () => { fetched++; return okResource()(); },
  });
  t.after(env.stop);

  await until(() => env.st.done, 'the cold run to finish');
  assert.equal(env.st.reason, 'ok');
  assert.ok(fetched >= TEST_PLAN.blocking.length, 'the blocking files were fetched: ' + fetched);
  const wrote = JSON.parse(env.ledger().v);
  assert.equal(wrote.b, TEST_PLAN.build, 'the ledger is keyed by build');
  assert.ok(wrote.m.length > 0, 'and records progress');
});

test('shim: a ledger from a DIFFERENT build is discarded, not trusted', async (t) => {
  // A package swap changes what bit 37 means, so the old bitmap must be thrown
  // away rather than skipping files that were never downloaded.
  const all = TEST_PLAN.blocking.concat(TEST_PLAN.optional);
  let fetched = 0;
  const env = runShim({
    plan: TEST_PLAN,
    manifest: okPlan(TEST_PLAN),
    resource: () => { fetched++; return okResource()(); },
    ledger: fullLedger('some-older-build', all.length),
  });
  t.after(env.stop);

  await until(() => env.st.done, 'the run to finish');
  assert.notEqual(env.st.reason, 'warm', 'a stale ledger must not short-circuit the load');
  assert.ok(fetched >= TEST_PLAN.blocking.length, 'everything in blocking is fetched again');
});

test('shim: a failed plan request opens the gate and the game boots normally', async (t) => {
  const env = runShim({
    plan: TEST_PLAN,
    manifest: () => Promise.reject(new Error('boom')),
    resource: okResource(),
  });
  t.after(env.stop);

  gameManifestXhr(env);
  assert.deepEqual(env.sent, [], 'held while the plan was in flight');

  await until(() => env.st.done, 'the gate to open on failure');
  assert.equal(env.st.reason, 'manifest');
  assert.deepEqual(env.sent, ['manifest.json?v=0.5'], 'held requests are released anyway');
  assert.ok(env.log.some((l) => l.indexOf('the game boots normally') !== -1));
});

test('shim: no fetch, no gate -- XMLHttpRequest is left completely alone', () => {
  const env = runShim({
    noFetch: true,
    plan: TEST_PLAN,
    manifest: () => Promise.reject(new Error('unused')),
    resource: okResource(),
  });
  env.stop();
  assert.equal(env.st, undefined, 'nothing is published, so nothing can be relied on');
  // The decisive property: send is the original function, so the game behaves
  // exactly as it did before this shim existed.
  env.sandbox.XMLHttpRequest.prototype.send.call(
    Object.assign(new env.sandbox.XMLHttpRequest(), { __test: { u: 'x' } }), null);
  assert.deepEqual(env.sent, ['x'], 'the request goes straight out');
});

test('shim: ?nopreload=1 stands the gate down', (t) => {
  const env = runShim({
    search: '?nopreload=1',
    plan: TEST_PLAN,
    manifest: okPlan(TEST_PLAN),
    resource: okResource(),
  });
  t.after(env.stop);
  assert.ok(env.st, 'the marker is still published for diagnostics');
  assert.notEqual(env.st.armed, true, 'a query opt-out must never hold a request');
});

test('shim: the localStorage opt-out stands the gate down too', (t) => {
  const env = runShim({
    optOut: true,
    plan: TEST_PLAN,
    manifest: okPlan(TEST_PLAN),
    resource: okResource(),
  });
  t.after(env.stop);
  assert.notEqual(env.st.armed, true, 'a persistent opt-out must never hold a request');
  assert.equal(env.st.phase, 'opt-out');
  assert.equal(env.st.done, true);
});

test('shim: the manifest timeout releases the held request, and a late plan only warms', async (t) => {
  // Two failures in one run, because both need the 5 s decide timer:
  //  1. the gate was closed and the plan never answered -- clearing `armed`
  //     alone would leave what launcher.js already sent sitting in `held` until
  //     the 8-minute hard cap, so the timeout must call finish() and release it;
  //  2. when the plan finally arrives, it must NOT re-close the gate or
  //     re-disable the button: the player is already in the game.
  let releasePlan;
  const env = runShim({
    plan: TEST_PLAN,
    manifest: () => new Promise((r) => { releasePlan = r; }),   // never answers in time
    resource: okResource(),
  });
  t.after(env.stop);

  gameManifestXhr(env);
  assert.deepEqual(env.sent, [], 'held while the plan is in flight');

  await until(() => env.st.done, 'the decide timer to open the gate', 8000);
  assert.equal(env.st.reason, 'manifest-timeout');
  assert.deepEqual(env.sent, ['manifest.json?v=0.5'], 'the held request is NOT stranded');

  releasePlan({ ok: true, status: 200, json: () => Promise.resolve(TEST_PLAN) });
  await until(() => env.log.some((l) => l.indexOf('warming only') !== -1), 'the late-plan path');
  assert.equal(env.st.done, true, 'the gate stays open');
  assert.equal(env.st.phase, 'optional', 'the late plan degrades to background warming');
  assert.equal(env.log.some((l) => l.indexOf('gate open') !== -1), true);
});
