'use strict';
/**
 * The world must keep moving with NO browser attached.
 *
 * This is the property the whole push feature rests on: if the frog only travelled
 * while a page was open, a notification about it coming home would be pointless.
 * The server's clock is a bare setInterval, so this test starts the server with
 * shortened pacing, connects NOTHING, and checks that the frog leaves and returns
 * and that the clovers regrow.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'vendor', 'game', '__offline-engine.js');
const hasEngine = fs.existsSync(ENGINE);
const suite = hasEngine ? test : test.skip;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function req(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const d = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const q = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 10000,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(d ? { 'Content-Type': 'application/json', 'Content-Length': d.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    q.on('error', reject);
    if (d) q.write(d);
    q.end();
  });
}

suite('the world advances with no browser connected', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-headless-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', FROG_DATA_DIR: dataDir,
      FROG_TICK_MS: '300',
      // Fast pacing, and the API needs no token by default so this test also pins
      // that default.
      FROG_FAITHFUL: '0',
      FROG_TRAVEL_MIN: '4', FROG_TRAVEL_MAX: '5',
      FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '2',
      FROG_PLANT_STAGE_SEC: '4',
      FROG_GUEST_ROLL: '2', FROG_GUEST_CHANCE: '100', FROG_GUEST_COOL: '1',
      FROG_ENABLE_GM_API: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push('[err] ' + String(d)));
  t.after(async () => {
    try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
    await sleep(200);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let up = null;
  for (let i = 0; i < 100; i++) {
    try { up = await req(port, 'GET', '/api/health'); if (up.status === 200) break; } catch (e) { /* not yet */ }
    await sleep(150);
  }
  assert.ok(up && up.status === 200, 'server started:\n' + logs.join(''));

  // No token anywhere in this test, and no WebSocket ever opened.
  const health = await req(port, 'GET', '/api/health');
  assert.equal(health.status, 200, 'health is open');
  assert.equal(health.json.clients, 0, 'no client is connected');

  const state0 = await req(port, 'GET', '/api/state');
  assert.equal(state0.status, 200, '/api works with no token by default');
  assert.ok(state0.json.frog, 'state readable without auth');

  // ---- harvest everything, then leave the garden alone: unharvested slots stay
  //      ripe, but a harvested slot must regrow on its own.
  const slots = state0.json.clovers.readySlots.slice(0, 3);
  assert.ok(slots.length > 0, 'there are ripe clovers to start from');
  const h = await req(port, 'POST', '/api/harvest', { slots }, null);
  assert.equal(h.status, 200);
  const afterHarvest = (await req(port, 'GET', '/api/state')).json;
  const growing = afterHarvest.clovers.slots.filter((s) => s.status === 'growing');
  assert.ok(growing.length >= slots.length, 'harvested slots are now growing');

  // ---- send the frog away, then touch NOTHING. It must come home by itself.
  await req(port, 'POST', '/api/debug/gm', { cmd: 'add_item 0 1' }, null);
  await req(port, 'POST', '/api/debug/gm', { cmd: 'put_bag 1 0' }, null);
  await req(port, 'POST', '/api/debug/gm', { cmd: 'travel_now' }, null);
  const away = (await req(port, 'GET', '/api/state')).json;
  assert.equal(away.frog.status, 'away', 'frog departed');

  // Wait past the return deadline without making a single request.
  const waitMs = Math.max(0, (away.frog.returnAt - Math.floor(Date.now() / 1000)) * 1000) + 3000;
  await sleep(waitMs);

  const home = (await req(port, 'GET', '/api/state')).json;
  assert.equal(home.frog.status, 'home', 'the frog came home on its own');
  assert.ok(home.frog.tripCount >= 1, 'the trip was counted');
  assert.ok(home.collections.pictures.owned > 0 || home.specialtys.length > 0,
    'the trip settled and brought something back');

  // ---- and the harvested slots are still on their own regrow timer
  //
  // The regrow span is NOT one of the tunable knobs: it is a normal draw around
  // CLOVER_REBIRTH_MEAN = 7200s (2 h, clamped to >= 300s), taken from the original
  // service's own formula. So a harvested slot stays 'growing' for at least five
  // minutes and cannot be watched to completion inside a test. What CAN be checked
  // without waiting is that the engine advanced its clock independently: the
  // harvested slots report a future readyAt against the server's own now.
  const now = (await req(port, 'GET', '/api/state')).json;
  const harvestedSlots = now.clovers.slots.filter((s) => slots.includes(s.slot));
  assert.equal(harvestedSlots.length, slots.length, 'the harvested slots are still there');
  for (const s of harvestedSlots) {
    assert.equal(s.status, 'growing', 'slot ' + s.slot + ' is still regrowing');
    assert.ok(s.readyAt > now.server.now,
      'slot ' + s.slot + ' has a future readyAt (' + s.readyAt + ' vs now ' + now.server.now + ')');
  }
  // The nearest ready time is minutes away -- i.e. the world is on the recovered
  // original pacing, not the shortened test pacing.
  assert.ok(now.clovers.nextReadyAt === null || now.clovers.nextReadyAt > now.server.now,
    'no clover claims to be ready in the past');

  // ---- the push log proves the events were derived with no client attached
  const logsRes = await req(port, 'GET', '/api/logs/push?limit=50');
  const kinds = logsRes.json.entries.map((e) => e.event).filter(Boolean);
  assert.ok(kinds.includes('depart'), 'depart was derived headlessly; saw ' + JSON.stringify(kinds));
  assert.ok(kinds.includes('return'), 'return was derived headlessly; saw ' + JSON.stringify(kinds));
});
