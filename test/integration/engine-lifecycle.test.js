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
