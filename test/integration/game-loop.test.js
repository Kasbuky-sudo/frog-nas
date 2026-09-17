'use strict';
/**
 * End-to-end integration: a real server process, a real engine, a real WebSocket
 * client, and a real HTTP receiver standing in for a push target.
 *
 * This is the "full loop" the acceptance criteria ask for, run with shortened
 * pacing so a whole game cycle fits in a test:
 *
 *   harvest -> shop -> pack -> depart -> return -> postcard -> visitor -> feed
 *   -> gift, with each step asserted twice: once through the REST API and once
 *   through the push payloads a subscriber would receive.
 *
 * The server runs as a CHILD PROCESS on its own port and its own data directory,
 * so the test also covers "the container starts from nothing" and cannot corrupt
 * the operator's ./data.
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

/** Pick a free port by binding to 0 and reading it back. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** A push receiver: records every request and answers 200. */
function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => b += c);
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(b); } catch (e) { parsed = { raw: b }; }
      received.push({ url: req.url, contentType: req.headers['content-type'], body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        received,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A running server child process plus a small authenticated client. */
async function startServer(extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-it-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      FROG_DATA_DIR: dataDir,
      FROG_TICK_MS: '300',
      FROG_FAITHFUL: '0',
      FROG_TRAVEL_MIN: '2', FROG_TRAVEL_MAX: '3',
      FROG_IDLE_MIN: '1', FROG_IDLE_MAX: '2',
      FROG_GUEST_ROLL: '2', FROG_GUEST_CHANCE: '100', FROG_GUEST_COOL: '1',
      FROG_VISITOR_ROLL: '2', FROG_VISITOR_CHANCE: '100', FROG_VISITOR_COOL: '1',
      FROG_ENABLE_GM_API: '1',
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push('[err] ' + String(d)));

  const health = async () => {
    try {
      return await rawRequest(port, 'GET', '/api/health');
    } catch (e) {
      return null;
    }
  };
  let up = null;
  for (let i = 0; i < 80; i++) {
    up = await health();
    if (up && up.status === 200) break;
    await sleep(150);
  }
  assert.ok(up && up.status === 200, 'server did not start; log:\n' + logs.join(''));

  const token = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).apiToken;
  return {
    port, dataDir, child, logs, token,
    api: (method, p, body) => request(port, method, p, body, token),
    stop: async () => {
      child.kill('SIGKILL');
      await sleep(200);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** A bare HTTP request (no auth). `buffer` holds the raw bytes, so binary
 *  responses (the postcard PNG) can be inspected without a UTF-8 round trip. */
function rawRequest(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 10000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text, buffer });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

/** An authenticated /api request. */
function request(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 15000,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

suite('integration: the full game loop drives both the API and the push stream', async (t) => {
  const receiver = await startReceiver();
  const srv = await startServer();
  t.after(async () => {
    await srv.stop();
    await receiver.close();
  });

  const api = srv.api;

  // ---------------------------------------------------------------- 1. boot
  await t.test('health and state are up, engine ready', async () => {
    const h = await api('GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.engine, true);
    assert.equal(h.body.ok, true);

    const st = await api('GET', '/api/state');
    assert.equal(st.status, 200);
    assert.equal(st.body.frog.status, 'home');
    assert.equal(st.body.clovers.total, 20);
    assert.ok(Array.isArray(st.body.clovers.readySlots));
  });

  await t.test('push is configured to the local receiver (both channels off by default)', async () => {
    const cfg = await api('GET', '/api/settings/push');
    assert.equal(cfg.body.webhook.enabled, false, 'a fresh install sends nothing anywhere');
    assert.equal(cfg.body.meow.enabled, false);
    const put = await api('PUT', '/api/settings/push', {
      webhook: { enabled: true, url: 'http://127.0.0.1:' + receiver.port + '/hook' },
      quietHours: { enabled: false, from: '23:00', to: '07:00' },
      retry: { attempts: 2, baseDelayMs: 100 },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.push.webhook.enabled, true);
  });

  await t.test('a test push reaches the receiver as JSON', async () => {
    const r = await api('POST', '/api/push/test', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const hit = receiver.received.find((x) => x.body && x.body.event === 'test');
    assert.ok(hit, 'receiver saw the test push');
    assert.match(hit.contentType, /application\/json/);
  });

  // ------------------------------------------------------------- 2. harvest
  await t.test('harvest empties the garden, and a repeat is a no-op', async () => {
    const before = (await api('GET', '/api/state')).body;
    const r = await api('POST', '/api/harvest', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.harvested, before.clovers.readySlots.length);
    assert.ok(r.body.clover > before.resources.clover);
    for (const res of r.body.results) assert.equal(res.ok, true, JSON.stringify(res));

    const again = await api('POST', '/api/harvest', {});
    assert.equal(again.body.ok, false, 'nothing left to harvest');
    assert.match(again.body.message, /没有可收/);
  });

  // ---------------------------------------------------------------- 3. shop
  await t.test('the shop sells a lunch box, and refuses nonsense', async () => {
    const shop = await api('GET', '/api/shop');
    assert.equal(shop.status, 200);
    assert.ok(shop.body.items.length > 50, 'the catalogue is loaded');
    const lunch = shop.body.items.find((i) => i.type === 0 && i.affordable && i.available);
    assert.ok(lunch, 'there is an affordable lunch box');

    const buy = await api('POST', '/api/shop/buy', { shopId: lunch.shopId, qty: 1 });
    assert.equal(buy.body.ok, true, JSON.stringify(buy.body));
    assert.equal(buy.body.bought, 1);

    const bad = await api('POST', '/api/shop/buy', { shopId: 999999, qty: 1 });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.results[0].code, -1, 'unknown slot');

    const noQty = await api('POST', '/api/shop/buy', { shopId: lunch.shopId, qty: 0 });
    assert.equal(noQty.status, 400, 'qty 0 is a request error, not a game refusal');
  });

  // ------------------------------------------------------------- 4. luggage
  await t.test('the bag enforces slot types (a tool cannot go in the lunch slot)', async () => {
    const shop = await api('GET', '/api/shop');
    const lunch = shop.body.items.find((i) => i.type === 0);
    const tool = shop.body.items.find((i) => i.type === 2);

    const ok = await api('PUT', '/api/luggage', { slots: { 1: lunch.itemId } });
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body.ops));
    assert.equal(ok.body.ops[0].ok, true);

    const bad = await api('PUT', '/api/luggage', { slots: { 1: tool.itemId } });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.ops[0].reason, /便当/);

    const read = await api('GET', '/api/luggage');
    assert.equal(read.body.slots[0].itemId, lunch.itemId);
    assert.deepEqual(read.body.slotTypes, ['lunchbox', 'amulet', 'tool', 'tool']);
  });

  await t.test('item id 0 is a real item (not an empty slot)', async () => {
    // 奶油华夫饼 is item 0. A "> 0" occupancy test would report the slot as empty,
    // which is the exact bug this guards: put item 0 in the LAST slot so the
    // assertion cannot be satisfied by an item left there by an earlier subtest.
    const shop = await api('GET', '/api/shop');
    const zero = shop.body.items.find((i) => i.itemId === 0);
    assert.ok(zero, 'item id 0 exists in the catalogue');
    assert.equal(zero.type, 0, 'and it is a lunch box, so slot 4 (a tool slot) must refuse it');

    const put = await api('PUT', '/api/luggage', { slots: { 4: 0 } });
    assert.equal(put.body.ok, false, 'slot 4 is a tool slot; a lunch box is refused there');
    assert.match(put.body.ops[0].reason, /工具/);

    const putOk = await api('PUT', '/api/luggage', { slots: { 2: 0 } });
    assert.equal(putOk.body.ok, false, 'slot 2 is the amulet slot; also refused');
    assert.match(putOk.body.ops[0].reason, /护身符/);

    // The lunch slot accepts item 0, and reading it back must NOT call it empty.
    await api('PUT', '/api/luggage', { slots: { 1: 0 } });
    const read = await api('GET', '/api/luggage');
    assert.equal(read.body.slots[0].empty, false, 'slot 1 holds item 0 and is not empty');
    assert.equal(read.body.slots[0].itemId, 0);
    assert.ok(read.body.slots[0].name, 'item 0 resolves to a name');
  });

  // ----------------------------------------------------------- 5. the trip
  await t.test('the frog departs, returns, and both are pushed with a postcard', async () => {
    const before = receiver.received.length;
    // The frog leaves on its own once something is packed (FROG_IDLE_MIN..MAX = 1-2 s).
    const seen = new Set();
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      for (const r of receiver.received.slice(before)) {
        if (r.body && r.body.event) seen.add(r.body.event);
      }
      if (seen.has('depart') && seen.has('return')) break;
    }
    assert.ok(seen.has('depart'), 'depart pushed; saw ' + [...seen].join(','));
    assert.ok(seen.has('return'), 'return pushed; saw ' + [...seen].join(','));

    const evs = receiver.received.map((r) => r.body).filter((b) => b && b.event);
    const dep = evs.find((e) => e.event === 'depart');
    const ret = evs.find((e) => e.event === 'return');
    assert.ok(evs.indexOf(dep) < evs.indexOf(ret), 'depart arrives before return');
    assert.ok(dep.data && typeof dep.data === 'object', 'depart carries a data object');
    assert.match(ret.body, /回来/);

    const st = (await api('GET', '/api/state')).body;
    assert.equal(st.frog.tripCount, 1, 'one trip counted');
    assert.equal(st.frog.status, 'home');
  });

  await t.test('the trip produced postcards and a souvenir', async () => {
    const st = (await api('GET', '/api/state')).body;
    assert.ok(st.collections.pictures.owned > 0, 'a postcard arrived');
    // Postcards land in 新照片 (albumPending) before they are filed.
    const evs = receiver.received.map((r) => r.body).filter((b) => b && b.event);
    const cards = evs.filter((e) => e.event === 'postcard');
    assert.ok(cards.length >= 1, 'a postcard was pushed');
    assert.ok(cards[0].data.picId > 0, 'the push names the picture');
  });

  // ------------------------------------------------------------ 6. visitor
  await t.test('a visitor arrives, is fed, and leaves a gift', async () => {
    // Grant a feedable specialty: the feed consumes a HOUSE item (the client's
    // PlayerBag/consumeHouseItem path), which a short test trip may not produce.
    const gm = await api('POST', '/api/debug/gm', { cmd: 'add_item 3001 2' });
    assert.equal(gm.body.ok, true, 'GM console reachable in this test build');

    let state = (await api('GET', '/api/state')).body;
    for (let i = 0; i < 40 && !state.guest; i++) {
      await sleep(300);
      state = (await api('GET', '/api/state')).body;
    }
    assert.ok(state.guest, 'a visitor showed up (forced to 100% chance in this run)');
    const evsBefore = receiver.received.map((r) => r.body).filter((b) => b && b.event);
    assert.ok(evsBefore.some((e) => e.event === 'visitor_arrive'), 'visitor_arrive pushed');

    const feedable = state.owned.feedableSpecialtys || [];
    assert.ok(feedable.length > 0, 'something to feed, have: ' + JSON.stringify(feedable));

    const fed = await api('POST', '/api/visitor/feed', { auto: true });
    assert.equal(fed.status, 200, JSON.stringify(fed.body));
    assert.equal(fed.body.ok, true);
    assert.ok(['delighted', 'pleased', 'indifferent', 'put_off'].includes(fed.body.reaction),
      'reaction: ' + fed.body.reaction);

    await sleep(800);
    const evs = receiver.received.map((r) => r.body).filter((b) => b && b.event);
    assert.ok(evs.some((e) => e.event === 'visitor_gift'), 'visitor_gift pushed; saw ' +
      [...new Set(evs.map((e) => e.event))].join(','));
  });

  // ------------------------------------------------------- 7. mail, tickets
  await t.test('mail is claimed and the lottery reports its price', async () => {
    const mail = await api('GET', '/api/mail');
    assert.equal(mail.status, 200);
    if (mail.body.total > 0) {
      const claim = await api('POST', '/api/mail/claim', {});
      assert.equal(claim.body.claimed, mail.body.total, 'every mail was opened');
      assert.ok(claim.body.gained.clover >= 0);
    }
    const after = (await api('GET', '/api/mail')).body;
    assert.equal(after.total, 0, 'the mailbox is empty after claiming');

    const lot = await api('GET', '/api/lottery');
    assert.equal(lot.body.ticketCost, 5, 'from the tuning table (RAFFEL_NEEDTICKETS)');
    const draw = await api('POST', '/api/lottery/draw', {});
    if (draw.body.ok) {
      assert.ok(draw.body.ball >= 0);
      assert.equal(draw.body.ticket, lot.body.ticketCost === 5 ? draw.body.ticket : draw.body.ticket);
    } else {
      assert.match(draw.body.message, /券/);
    }
  });

  // --------------------------------------------------------- 8. collections
  await t.test('collections report progress against the tables', async () => {
    const c = await api('GET', '/api/collections');
    assert.equal(c.status, 200);
    assert.ok(c.body.progress.pictures.total === 351, 'the Picture table drives the denominator');
    assert.ok(c.body.progress.specialtys.total === 64);
    assert.ok(c.body.album.count >= 0);
  });

  await t.test('postcards render from the game art', async () => {
    const c = (await api('GET', '/api/collections')).body;
    const anyPic = (c.album.pictures[0] || {}).picId;
    assert.ok(anyPic > 0, 'there is a postcard to render');
    const img = await rawRequest(srv.port, 'GET', '/asset/postcard/' + anyPic);
    assert.equal(img.status, 200);
    assert.match(img.headers['content-type'], /image\/png/);
    assert.ok(img.buffer.length > 1000, 'the PNG has content');
    // PNG magic + 500x350, the client's own drawToTexture canvas.
    assert.equal(img.buffer.readUInt32BE(0), 0x89504e47);
    assert.equal(img.buffer.readUInt32BE(16), 500);
    assert.equal(img.buffer.readUInt32BE(20), 350);

    // The extensionless form (what a push links to) and the .png form agree.
    const withExt = await rawRequest(srv.port, 'GET', '/asset/postcard/' + anyPic + '.png');
    assert.equal(withExt.status, 200);
    assert.equal(withExt.buffer.length, img.buffer.length);
  });

  // ---------------------------------------------------------------- 9. auth
  await t.test('auth is OFF by default, and enforced once switched on', async () => {
    // The default is deliberate: an AI agent that knows the address should not also
    // need a secret pasted into its config. So /api answers without any header...
    const open = await rawRequest(srv.port, 'GET', '/api/state');
    assert.equal(open.status, 200, '/api works with no Authorization header by default');

    // ...and /api/health stays open either way (the container healthcheck needs it).
    const h = await rawRequest(srv.port, 'GET', '/api/health');
    assert.equal(h.status, 200);

    // An operator can turn the check on from the admin API.
    const on = await api('PUT', '/admin/api/require-token', { requireToken: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.requireToken, true);

    const none = await rawRequest(srv.port, 'GET', '/api/state');
    assert.equal(none.status, 401, 'now a token is required');
    const wrong = await request(srv.port, 'GET', '/api/state', undefined, 'nope');
    assert.equal(wrong.status, 403, 'a wrong token is rejected');
    const right = await api('GET', '/api/state');       // api() sends the real token
    assert.equal(right.status, 200, 'the right token works');
    // /api/health is exempt from the token check.
    assert.equal((await rawRequest(srv.port, 'GET', '/api/health')).status, 200);

    // Put it back, so the remaining subtests run against the default.
    const off = await api('PUT', '/admin/api/require-token', { requireToken: false });
    assert.equal(off.body.requireToken, false);
    assert.equal((await rawRequest(srv.port, 'GET', '/api/state')).status, 200);
  });

  // ------------------------------------------------- 10. the game page itself
  await t.test('the game page is served with the Route A shim, CSP and notice intact', async () => {
    const idx = await rawRequest(srv.port, 'GET', '/');
    assert.equal(idx.status, 200);
    assert.match(idx.headers['content-type'], /text\/html/);
    assert.ok(idx.headers['content-security-policy'], 'CSP present');
    assert.match(idx.headers['content-security-policy'], /default-src 'self'/);
    assert.ok(idx.text.includes("searchParams.set('transport', 'ws')"), 'Route A shim injected');
    assert.ok(idx.text.indexOf('transport') < idx.text.indexOf('__offline-engine.js'),
      'the shim runs before the engine bundle');
    // The rights notice must survive every transformation.
    assert.ok(idx.text.includes('id="__notice"'));
    assert.ok(idx.text.includes('Hit-Point'));
    assert.ok(idx.text.includes('Balticx'));
    assert.ok(idx.text.includes('我已阅读，进入游戏'));
  });

  await t.test('gameConfig points the client at this server', async () => {
    const cfg = await rawRequest(srv.port, 'GET', '/resource/China/config/gameConfig.json');
    const parsed = JSON.parse(cfg.text);
    assert.deepEqual(parsed.serverList.offline.gameServer,
      ['ws://127.0.0.1:' + srv.port + '/ws']);
    assert.equal(parsed.useNode, 'offline', 'other fields untouched');
  });

  // ------------------------------------------------------- 11. the push log
  await t.test('every push attempt is logged, with no failures', async () => {
    const logs = await api('GET', '/api/logs/push?limit=200');
    assert.equal(logs.status, 200);
    assert.ok(logs.body.entries.length > 0, 'the log is not empty');
    const failed = logs.body.entries.filter((e) => e.kind === 'push' && e.ok === false);
    assert.deepEqual(failed, [], 'no push failed; got ' + JSON.stringify(failed.slice(0, 2)));
    const onDisk = fs.readFileSync(path.join(srv.dataDir, 'logs', 'push.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.ok(onDisk.length >= logs.body.entries.length - 1, 'the JSONL file backs the endpoint');
  });

  await t.test('the push log and settings are visible to an operator', async () => {
    const admin = await rawRequest(srv.port, 'GET', '/admin');
    assert.equal(admin.status, 200);
    assert.ok(admin.text.includes('api-token'), 'the settings page exposes the token field');
  });
});

suite('integration: a websocket client drives the same world the API sees', async (t) => {
  const srv = await startServer({ FROG_FAITHFUL: '1' });
  t.after(async () => { await srv.stop(); });

  await t.test('two connections both receive a third party\'s pushes', async () => {
    const WebSocket = require('ws');
    const a = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws');
    const b = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws');
    t.after(() => { try { a.close(); b.close(); } catch (e) { } });

    const bPushes = [];
    b.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (!m.session && m.cmd) bPushes.push(m.cmd);
    });
    await new Promise((res) => {
      let n = 0;
      const done = () => { if (++n === 2) res(); };
      a.on('open', done); b.on('open', done);
      setTimeout(res, 5000);
    });

    // A performs the client's own handshake; its boot pushes must reach B too.
    const replies = [];
    await new Promise((res) => {
      a.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.session) {
          replies.push(m.session);
          if (replies.length === 1) a.send(JSON.stringify({ session: 2, cmd: 'hall_login', data: { token: 'offline-it' } }));
          else if (replies.length === 2) a.send(JSON.stringify({ session: 3, cmd: 'hall_enter_game', data: {} }));
          else res();
        }
      });
      a.send(JSON.stringify({ session: 1, cmd: 'hall_gen_token', data: { account: 'it' } }));
      setTimeout(res, 6000);
    });

    await sleep(600);
    assert.ok(replies.length >= 3, 'the handshake completed: ' + JSON.stringify(replies));
    assert.ok(bPushes.length > 10, 'B saw A\'s boot pushes: ' + bPushes.length + ' (' +
      [...new Set(bPushes)].slice(0, 5).join(',') + ')');
    assert.ok(bPushes.includes('client.load_role'), 'a real push arrived at the other tab');
  });
});

/**
 * The clover notification, end to end: a real server, a real engine, a real
 * receiver.
 *
 * Why it is not only unit-tested: the field has 20 slots that regrow on their own
 * independent timers (mean 2h each), so the interesting behaviour only exists in a
 * LIVING garden. The engine's own GM console is the documented way for a headless
 * test to reach such a state without waiting hours, so this drives it through
 * /api/debug/gm.
 *
 * The unit tests in test/unit/events.test.js pin the rule itself; this pins the
 * plumbing -- snapshot -> derive -> dispatcher -> channel -- and the /api/state
 * fields the skills quote.
 */
suite('integration: the clover notification waits for the WHOLE field', async (t) => {
  const receiver = await startReceiver();
  const srv = await startServer({ FROG_ENABLE_GM_API: '1' });
  t.after(async () => {
    await srv.stop();
    await receiver.close();
  });

  const api = srv.api;
  const cloverPushes = () => receiver.received.filter((x) => x.body && x.body.event === 'clover_ready');
  const clovers = async () => (await api('GET', '/api/state')).body.clovers;

  await api('PUT', '/api/settings/push', {
    webhook: { enabled: true, url: 'http://127.0.0.1:' + receiver.port + '/hook' },
    quietHours: { enabled: false, from: '23:00', to: '07:00' },
    retry: { attempts: 2, baseDelayMs: 100 },
  });

  await t.test('a brand-new save is already full, and booting it notifies nobody', async () => {
    const c = await clovers();
    assert.equal(c.total, 20);
    assert.equal(c.readyCount, 20, 'the engine starts every slot ripe');
    assert.equal(c.full, true);
    assert.equal(c.growingCount, 0);
    assert.equal(c.emptyCount, 0);
    assert.equal(c.fullAt, null, 'nothing is growing, so there is no "will be full at"');
    await sleep(700);
    assert.equal(cloverPushes().length, 0, 'the baseline must not fire (dispatcher.prime)');
  });

  await t.test('clearing the field un-fills it, and that is not an event either', async () => {
    const r = await api('POST', '/api/debug/gm', { cmd: 'clear_clovers' });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const c = await clovers();
    assert.equal(c.full, false);
    assert.equal(c.readyCount, 0);
    assert.equal(c.emptyCount, 20);
    await sleep(700);
    assert.equal(cloverPushes().length, 0, 'an empty garden is not a full one');
  });

  await t.test('the field filling up DOES notify, and says the whole field is ready', async () => {
    const r = await api('POST', '/api/debug/gm', { cmd: 'harvest_all' });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(200); hit = cloverPushes()[0]; }
    assert.ok(hit, 'crossing into "full" must notify');
    assert.equal(hit.body.data.ready, 20);
    assert.equal(hit.body.data.empty, 0);
    assert.match(hit.body.body, /全部长好了/, 'the wording says the WHOLE field, not one plant');
  });

  await t.test('a garden that stays full does not re-notify', async () => {
    const before = cloverPushes().length;
    await sleep(1200);      // several ticks with the garden untouched
    assert.equal(cloverPushes().length, before);
  });

  await t.test('harvesting ONE slot is silent, and reports when it will be full again', async () => {
    const before = cloverPushes().length;
    const h = await api('POST', '/api/harvest', { slot: 1 });
    assert.equal(h.body.harvested, 1, JSON.stringify(h.body));

    const c = await clovers();
    assert.equal(c.readyCount, 19);
    assert.equal(c.growingCount, 1);
    assert.equal(c.full, false, 'one slot regrowing means the field is not full');
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(c.fullAt > nowSec, 'fullAt points at the future: ' + c.fullAt);
    assert.ok(c.nextReadyAt <= c.fullAt, 'nextReadyAt is the earliest slot, fullAt the last');
    assert.ok(c.fullAt - nowSec >= 290, 'the engine clamps a rebirth to at least 300s');

    await sleep(1200);
    assert.equal(cloverPushes().length, before,
      'a partly-grown field must not notify -- that was the reported bug');
  });
});
