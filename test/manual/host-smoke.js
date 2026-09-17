// Smoke-test EngineHost against the real engine bundle (M1 checkpoint).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EngineHost } = require('../../src/engine-host');

const ROOT = path.join(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-host-'));

const host = new EngineHost({
  engineFile: path.join(ROOT, 'vendor', 'game', '__offline-engine.js'),
  saveDir: dir,
  env: {
    FROG_FAITHFUL: '0',
    FROG_TRAVEL_MIN: '2', FROG_TRAVEL_MAX: '4',
    FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '2',
    FROG_GUEST_ROLL: '2', FROG_GUEST_CHANCE: '100',
  },
}).start();

console.log('engine ready:', host.ready, 'state.clover:', host.state.clover);

console.log('\n--- handshake ---');
console.log('hall_gen_token:', JSON.stringify(host.dispatch('hall_gen_token', { account: 'host-test' }).reply));
console.log('hall_login    :', JSON.stringify(host.dispatch('hall_login', { token: 'offline-host-test' }).reply));
const enter = host.dispatch('hall_enter_game', {});
console.log('hall_enter_game: reply=', JSON.stringify(enter.reply), 'pushes=', enter.pushes.length);

console.log('\n--- harvest every clover slot ---');
let harvested = 0, fourLeaf = 0, blocked = 0;
for (let i = 1; i <= 20; i++) {
  const r = host.dispatch('clover_harvest', { clover_id: i });
  if (r.reply && r.reply.code === 0) {
    harvested++;
    if (r.reply.type === 'four_leaf') fourLeaf++;
  } else blocked++;
}
console.log('harvested=' + harvested, 'fourLeaf=' + fourLeaf, 'not-ready=' + blocked);
console.log('clover now:', host.state.clover, 'house items:', JSON.stringify(host.state.items.house));
console.log('duplicate harvest is idempotent:', JSON.stringify(host.dispatch('clover_harvest', { clover_id: 1 }).reply));

console.log('\n--- push fan-out shape ---');
const r = host.dispatch('clover_harvest_resend', { list: [1, 2] });
console.log('clover_harvest_resend reply:', JSON.stringify(r.reply).slice(0, 200));

console.log('\n--- tick drives the world ---');
const seen = new Set();
for (let i = 0; i < 40; i++) {
  for (const p of host.tick()) seen.add(p.cmd);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
}
console.log('push commands seen:', Array.from(seen).sort().join(', '));
console.log('frog status:', host.state.frog.status, '(1 = away)');
console.log('travel:', JSON.stringify(host.state.travel));
console.log('pictures:', host.state.pictures.length, 'specialtys:', host.state.specialtys.length);
console.log('mails:', host.state.mails.length);

console.log('\n--- save files ---');
for (const f of host.saveFiles()) console.log('  ', f.name, f.size + 'B');

console.log('\n--- reload from disk ---');
const host2 = new EngineHost({
  engineFile: path.join(ROOT, 'vendor', 'game', '__offline-engine.js'),
  saveDir: dir, env: {},
}).start();
console.log('clover after reload:', host2.state.clover, 'status:', host2.state.frog.status,
  'pics:', host2.state.pictures.length, 'specialtys:', host2.state.specialtys.length);
console.log('saveInfo.report:', JSON.stringify(host2.saveInfo().report).slice(0, 300));
fs.rmSync(dir, { recursive: true, force: true });
