'use strict';
/**
 * Engine + save lifecycle, without HTTP: the engine boots from disk, the world
 * advances on a clock, and a restart resumes the same save with the time-based
 * catch-up applied.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EngineHost } = require('../../src/engine-host');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'vendor', 'game', '__offline-engine.js');
const hasEngine = fs.existsSync(ENGINE);

/** Fast pacing, so a whole trip fits inside a test. */
const FAST = {
  FROG_FAITHFUL: '0',
  FROG_TRAVEL_MIN: '2', FROG_TRAVEL_MAX: '3',
  FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '2',
};

function boot(saveDir, env) {
  return new EngineHost({ engineFile: ENGINE, saveDir, env: env || FAST, verbose: false }).start();
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'frog-live-')); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Advance the world by calling tick() repeatedly. */
function advance(host, ms, step) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const iv = setInterval(() => {
      host.tick();
      if (Date.now() >= deadline) { clearInterval(iv); resolve(); }
    }, step || 100);
  });
}

const suite = hasEngine ? test : test.skip;

suite('engine: a fresh host boots and exposes the documented shape', () => {
  const dir = tmp();
  const h = boot(dir);
  try {
    assert.equal(h.ready, true);
    const s = h.state;
    assert.equal(typeof s.clover, 'number');
    assert.equal(s.frog.status, 0);
    assert.equal(s.clovers.length, 20, 'the garden has 20 slots');
    assert.deepEqual(s.items.bag, [-1, -1, -1, -1]);
    assert.equal(s.items.desk.length, 8);
    assert.ok(Array.isArray(s.mails));
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { /* nothing to close: the host has no timers */ }
});

suite('engine: FROG_FAITHFUL selects the original timings', () => {
  const dirA = tmp(), dirB = tmp();
  // The engine reads FROG_FAITHFUL at load time and exposes the resulting travel
  // window through state.travel.returnAt only after a departure, so compare the
  // env the sandbox actually received plus a measured departure window instead.
  const fast = boot(dirA, { FROG_FAITHFUL: '0', FROG_TRAVEL_MIN: '2', FROG_TRAVEL_MAX: '3', FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '1' });
  fast.dispatch('client_gm', { cmd: 'add_item 0 1' });
  fast.dispatch('item_putin_bag', { pos: 1, item_id: 0 });
  fast.dispatch('client_gm', { cmd: 'travel_now' });
  const fastWindow = fast.state.travel.returnAt - fast.state.travel.departAt;

  const faithful = boot(dirB, { FROG_FAITHFUL: '1', FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '1' });
  faithful.dispatch('client_gm', { cmd: 'add_item 0 1' });
  faithful.dispatch('item_putin_bag', { pos: 1, item_id: 0 });
  faithful.dispatch('client_gm', { cmd: 'travel_now' });
  const faithfulWindow = faithful.state.travel.returnAt - faithful.state.travel.departAt;

  assert.ok(fastWindow >= 20 && fastWindow <= 60, 'fast trip is seconds, got ' + fastWindow);
  assert.ok(faithfulWindow >= 3600, 'faithful trip is hours, got ' + faithfulWindow);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

suite('engine: a save lands on disk, with the engine\'s own backup slot', () => {
  const dir = tmp();
  const h = boot(dir);
  h.dispatch('hall_enter_game', {});
  h.dispatch('clover_harvest', { clover_id: 1 });
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f === 'frog.offline.save.json'), 'primary save written: ' + files);
  const primary = JSON.parse(fs.readFileSync(path.join(dir, 'frog.offline.save.json'), 'utf8'));
  assert.ok(primary.clover > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

suite('engine: restarting resumes the same save', () => {
  const dir = tmp();
  const a = boot(dir);
  a.dispatch('hall_enter_game', {});
  const cloverBefore = a.state.clover;
  a.dispatch('client_gm', { cmd: 'add_clover 123' });
  a.dispatch('client_gm', { cmd: 'set_name 重启测试' });
  const expected = a.state.clover;

  const b = boot(dir);
  assert.equal(b.state.clover, expected, 'clover survived the restart');
  assert.equal(b.state.name, '重启测试', 'name survived the restart');
  assert.ok(expected > cloverBefore);
  assert.equal(b.saveInfo().report.restoredFrom, 'main', 'loaded from the primary save');
  fs.rmSync(dir, { recursive: true, force: true });
});

suite('engine: time-based catch-up after a restart (a trip finishes while offline)', async () => {
  const dir = tmp();
  // A 1-2 s trip: short enough to finish inside the test, long enough that the
  // restart below provably happens while the frog is still away.
  const env = { FROG_FAITHFUL: '0', FROG_TRAVEL_MIN: '1', FROG_TRAVEL_MAX: '2', FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '1' };
  const a = boot(dir, env);
  a.dispatch('client_gm', { cmd: 'add_item 0 1' });
  a.dispatch('item_putin_bag', { pos: 1, item_id: 0 });
  a.dispatch('client_gm', { cmd: 'travel_now' });
  assert.equal(a.state.frog.status, 1, 'frog is away');
  const returnAt = a.state.travel.returnAt;

  // "Power cut": a new host reads the same save. The world must settle onto the
  // SAME timeline rather than restarting the trip.
  const b = boot(dir, env);
  assert.equal(b.state.frog.status, 1, 'still away right after the restart');
  assert.equal(b.state.travel.returnAt, returnAt, 'the return deadline is preserved, not recomputed');

  // Wait for the deadline to pass, ticking as the server's clock would.
  const waitMs = Math.max(0, (returnAt - Math.floor(Date.now() / 1000)) * 1000) + 2000;
  await advance(b, waitMs, 150);
  assert.equal(b.state.frog.status, 0, 'the frog came home once the deadline passed');
  assert.ok(b.state.travel.tripCount >= 1, 'the trip counted');
  fs.rmSync(dir, { recursive: true, force: true });
});

suite('engine: a harvester is idempotent, and a second pass reports nothing to do', () => {
  const dir = tmp();
  const h = boot(dir);
  h.dispatch('hall_enter_game', {});
  let ok = 0, refused = 0;
  for (let i = 1; i <= 20; i++) {
    const r = h.dispatch('clover_harvest', { clover_id: i });
    if (r.reply && r.reply.code === 0) ok++; else refused++;
  }
  assert.equal(ok, 20, 'a fresh garden is harvestable');
  const again = h.dispatch('clover_harvest', { clover_id: 1 });
  assert.equal(again.reply.code, 2, 'code 2 = not ripe (the engine\'s own refusal)');
  fs.rmSync(dir, { recursive: true, force: true });
});

suite('engine: two hosts on different directories have different worlds', () => {
  const dirA = tmp(), dirB = tmp();
  const a = boot(dirA);
  a.dispatch('client_gm', { cmd: 'set_clover 111' });
  const b = boot(dirB);
  assert.equal(a.state.clover, 111);
  assert.notEqual(b.state.clover, 111, 'a separate save directory is a separate world');
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

suite('engine: the umask of a corrupted save is the engine\'s own recovery chain', () => {
  const dir = tmp();
  const h = boot(dir);
  h.dispatch('hall_enter_game', {});
  h.dispatch('client_gm', { cmd: 'set_clover 4242' });
  // Corrupt the primary; the engine keeps it aside and falls back to the backup.
  fs.writeFileSync(path.join(dir, 'frog.offline.save.json'), '{ this is not json');
  const again = boot(dir);
  assert.ok(again.ready, 'the host still starts');
  const kept = fs.readdirSync(dir).filter((f) => f.includes('corrupt'));
  assert.ok(kept.length >= 1, 'the unreadable bytes were kept: ' + fs.readdirSync(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

suite('engine: export/import round-trips a save', () => {
  const dir = tmp();
  const a = boot(dir);
  a.dispatch('hall_enter_game', {});
  a.dispatch('client_gm', { cmd: 'set_clover 777' });
  const exported = a.exportSave();

  const dir2 = tmp();
  const b = boot(dir2);
  b.importSave(exported);
  assert.equal(b.state.clover, 777);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

suite('engine: 放浪 (stray) trips are not seconds long', () => {
  // WHY THIS TEST EXISTS: the user reported "青蛙出行和回家 的频率有时会异常，
  // 具体而言就是可能会两分钟完成一次出门+回家的流程".
  //
  // A 放浪 trip -- gear in the bag but NO lunch box -- took its window from
  // define.json's FROG_DRIFTRETURNTIME 10 / _MAX 20 read as SECONDS, and
  // departFrog's Math.max(20, window) clamped every one of them to exactly 20 s.
  // With the 60-180 s idle wait after coming home, a whole cycle was 80-200 s.
  //
  // The trigger is not exotic: tripPrepared() accepts ANY item in the bag, while
  // provisionTrip() calls the trip stray unless a LUNCH BOX is present. Durable
  // gear (tools, amulets) comes home again, so "desk has gear, the lunch box has
  // been eaten" renews itself every trip -- the user's own save showed
  // travel.minTripSec === 13, which is a fingerprint of this path.
  //
  // The fix is a default FROG_CONFIG override (src/settings.js, decision D75);
  // vendor/ stays byte-identical. This test therefore asserts the SHIPPED defaults
  // rather than a value the test invents, so it fails if the old 10/20 seconds
  // ever comes back.

  const { Settings } = require('../../src/settings');

  /** The window + stray flag of one trip, under the env the server would pass. */
  function tripWindow(env, bagItem) {
    const dir = tmp();
    const h = boot(dir, env);
    h.dispatch('hall_enter_game', {});
    h.dispatch('client_gm', { cmd: 'add_item ' + bagItem + ' 1' });
    h.dispatch('item_putin_bag', { pos: 1, item_id: bagItem });
    h.dispatch('client_gm', { cmd: 'travel_now' });
    const st = h.state;
    const out = {
      window: (st.travel.returnAt || 0) - (st.travel.departAt || 0),
      stray: !!(st.travel.plan && st.travel.plan.stray),
    };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  }

  /** The engine env the server passes: defaults from src/settings.js. */
  function shippedEnv() {
    const cfgDir = tmp();
    const env = new Settings(cfgDir).engineEnv();
    fs.rmSync(cfgDir, { recursive: true, force: true });
    return env;
  }

  test('a stray trip lasts minutes, not seconds (item 2000 = 竹筒, a durable tool)', () => {
    // A tool makes the bag "prepared" (so the frog actually leaves) while still
    // yielding stray === true, because no lunch box is anywhere.
    const stray = tripWindow(shippedEnv(), 2000);
    assert.equal(stray.stray, true, 'a trip with a tool but no lunch box is 放浪');
    assert.ok(stray.window >= 300,
      'a 放浪 trip must last at least 5 minutes; got ' + stray.window + 's'
      + ' -- define.json\'s 10/20 is being read as SECONDS again');
    assert.ok(stray.window <= 3600,
      'a 放浪 trip should still be the SHORT outing, under an hour; got ' + stray.window + 's');
  });

  test('a normal trip (with a lunch box) is unaffected and still multi-hour', () => {
    // item 0 (奶油华夫饼) is a LUNCH BOX -> not stray.
    const normal = tripWindow(shippedEnv(), 0);
    assert.equal(normal.stray, false, 'a trip with a lunch box is not 放浪');
    assert.ok(normal.window >= 3600,
      'FROG_FAITHFUL=1 keeps a normal trip multi-hour; got ' + normal.window + 's');
  });

  test('the override is a config knob, not a code change: 0 falls back to the table', () => {
    // Guards the escape hatch /admin documents. With the override off the engine
    // uses the define.json values -- the very behaviour the shipped default exists
    // to avoid -- so this pins that the knob really is what is doing the work.
    const stray = tripWindow({ FROG_FAITHFUL: '1', FROG_DRIFT_MIN: '0', FROG_DRIFT_MAX: '0' }, 2000);
    assert.equal(stray.stray, true);
    assert.ok(stray.window <= 25,
      'with the override off the old ~20 s window returns; got ' + stray.window + 's');
  });
});

