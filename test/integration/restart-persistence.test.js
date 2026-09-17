'use strict';
/**
 * Durability: a hard kill must not lose progress, and time-based events must
 * settle correctly on the next boot.
 *
 * The process is killed with SIGKILL (no graceful shutdown, no final save) to
 * model a power cut on the NAS, then restarted on the same data directory.
 *
 * The interesting assertions are the ones about the trip: the frog is still away,
 * the return deadline is the SAME timestamp rather than being recomputed, and once
 * that deadline passes the frog comes home with the trip settled -- i.e. the
 * engine's offline catch-up is actually reachable through this server.
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function req(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const d = body === undefined || body === null ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const q = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 15000,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(d ? { 'Content-Type': 'application/json', 'Content-Length': d.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    q.on('error', reject);
    if (d) q.write(d);
    q.end();
  });
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', FROG_DATA_DIR: dataDir,
      FROG_TICK_MS: '300',
      FROG_FAITHFUL: '0', FROG_TRAVEL_MIN: '3', FROG_TRAVEL_MAX: '4',
      FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '1',
      FROG_ENABLE_GM_API: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push('[err] ' + String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const h = await req(port, 'GET', '/api/health');
      if (h.status === 200) return { child, logs };
    } catch (e) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not start:\n' + logs.join(''));
}

suite('a hard kill loses no progress and time settles on the next boot', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-durable-'));
  const port = await freePort();
  let srv = await startServer(port, dataDir);
  t.after(async () => {
    try { srv.child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    await sleep(200);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const tokenFor = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).apiToken;
  let token = tokenFor();

  // ---- establish distinctive progress
  await req(port, 'POST', '/api/debug/gm', { cmd: 'set_name 断电测试' }, token);
  await req(port, 'POST', '/api/debug/gm', { cmd: 'set_clover 8888' }, token);
  const harvest = await req(port, 'POST', '/api/harvest', {}, token);
  const before = (await req(port, 'GET', '/api/state', undefined, token)).json;
  // 8888 is exact, and the harvest above adds clover, so the mark to carry across
  // the restart is whatever the engine reports now.
  assert.ok(before.resources.clover >= 8888, 'clover after set+harvest: ' + before.resources.clover);
  assert.equal(before.frog.name, '断电测试');
  assert.ok(harvest.json.harvested > 0, 'the harvest did something worth persisting');
  const cloverMark = before.resources.clover;

  // ---- send the frog away, then kill the process without a clean shutdown
  await req(port, 'POST', '/api/debug/gm', { cmd: 'add_item 0 1' }, token);
  await req(port, 'POST', '/api/debug/gm', { cmd: 'put_bag 1 0' }, token);
  await req(port, 'POST', '/api/debug/gm', { cmd: 'travel_now' }, token);
  const away = (await req(port, 'GET', '/api/state', undefined, token)).json;
  assert.equal(away.frog.status, 'away', 'the frog is away before the kill');
  assert.ok(away.frog.returnAt > 0);

  srv.child.kill('SIGKILL');
  await sleep(600);

  const saveFiles = fs.readdirSync(path.join(dataDir, 'save'));
  assert.ok(saveFiles.includes('frog.offline.save.json'),
    'the save survived the kill: ' + saveFiles.join(', '));

  // ---- restart on the same data directory
  srv = await startServer(port, dataDir);
  token = tokenFor();
  const after = (await req(port, 'GET', '/api/state', undefined, token)).json;

  assert.equal(after.resources.clover, cloverMark, 'clover survived the restart');
  assert.equal(after.frog.name, '断电测试', 'the name survived the restart');
  assert.equal(after.frog.tripCount, away.frog.tripCount, 'the trip is remembered');
  assert.equal(after.frog.returnAt, away.frog.returnAt,
    'the return deadline is the SAME timestamp, not recomputed at boot');
  assert.equal(after.frog.status, 'away', 'still away right after the restart');

  // ---- the deadline passes: the frog must come home on the restored timeline
  const waitMs = Math.max(0, (away.frog.returnAt - Math.floor(Date.now() / 1000)) * 1000) + 2500;
  await sleep(waitMs);
  const home = (await req(port, 'GET', '/api/state', undefined, token)).json;
  assert.equal(home.frog.status, 'home', 'the frog came home (offline catch-up)');
  assert.ok(home.collections.pictures.owned > 0 || home.specialtys.length > 0,
    'the trip settled: pics=' + home.collections.pictures.owned + ' spec=' + home.specialtys.length);

  // ---- /__log accepts the probe's beacon (text/plain, not JSON)
  const beacon = await new Promise((resolve, reject) => {
    const d = Buffer.from('[selftest] beacon line\n');
    const q = http.request({
      host: '127.0.0.1', port, path: '/__log', method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': d.length },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    q.on('error', reject); q.write(d); q.end();
  });
  assert.equal(beacon, 204);
  const clientLog = await req(port, 'GET', '/api/logs/client', undefined, token);
  assert.ok(clientLog.json.lines.some((l) => l.includes('beacon line')),
    'the beacon body was stored and is readable: ' + JSON.stringify(clientLog.json.lines.slice(0, 3)));
});
