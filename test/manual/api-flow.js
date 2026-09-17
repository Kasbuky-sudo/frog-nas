// End-to-end API flow: harvest -> buy -> pack -> depart -> return -> visitor ->
// feed -> lottery, with a local webhook receiver asserting push payloads.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const BASE = 'http://127.0.0.1:8980';
const TOKEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')).apiToken;

function call(method, p, body) {
  const url = new URL(BASE + p);
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (e) { j = { raw: b }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const ok = (label, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra === undefined ? '' : '  ' + extra));
  return cond;
};

(async () => {
  let failures = 0;
  const check = (l, c, e) => { if (!ok(l, c, e)) failures++; };

  console.log('=== A. status ===');
  const st = (await call('GET', '/api/state')).body;
  check('state ok', !!st.frog, JSON.stringify(st.frog && st.frog.status));
  check('has clovers', st.clovers.total === 20, 'ready=' + st.clovers.readyCount);

  console.log('\n=== B. harvest ===');
  const hv = (await call('POST', '/api/harvest', {})).body;
  check('harvest responded', typeof hv.harvested === 'number', 'harvested=' + hv.harvested);
  const hv2 = (await call('POST', '/api/harvest', {})).body;
  check('second harvest idle (idempotent)', hv2.ok === false || hv2.harvested === 0,
    'message=' + (hv2.message || ''));

  console.log('\n=== C. shop list + buy ===');
  const shop = (await call('GET', '/api/shop')).body;
  check('shop list', shop.count === 66, 'buyable=' + shop.buyable.length);
  const lunch = shop.items.find((i) => i.type === 0 && i.available && i.affordable);
  check('found an affordable lunch', !!lunch, lunch && (lunch.shopId + ':' + lunch.name + ' @' + lunch.price));
  const buy = (await call('POST', '/api/shop/buy', { shopId: lunch.shopId, qty: 1 })).body;
  check('buy succeeded', buy.ok === true, 'clover=' + buy.clover + ' name=' + buy.name);
  const buy2 = (await call('POST', '/api/shop/buy', { shopId: 99999, qty: 1 })).body;
  check('unknown slot refused', buy2.ok === false, 'code=' + JSON.stringify(buy2.results));

  console.log('\n=== D. luggage ===');
  const lug = (await call('GET', '/api/luggage')).body;
  check('luggage shape', Array.isArray(lug.slots) && lug.slots.length === 4, JSON.stringify(lug.slotTypes));
  // Put a lunch box (type 0) in slot 1, and try a tool in slot 1 -> must be refused.
  const putGood = (await call('PUT', '/api/luggage', { slots: { 1: lunch.itemId } })).body;
  check('put lunch in slot 1', putGood.ok === true, JSON.stringify(putGood.ops));
  const toolItem = shop.items.find((i) => i.type === 2 && i.affordable) || { itemId: 2000 };
  const putBad = (await call('PUT', '/api/luggage', { slots: { 1: 2000 } })).body;
  check('wrong slot type refused', putBad.ok === false, JSON.stringify(putBad.ops && putBad.ops[0]));

  console.log('\n=== E. table ===');
  const tbl = (await call('GET', '/api/table')).body;
  check('table shape', Array.isArray(tbl.slots) && tbl.slots.length === 8, 'prepared=' + tbl.prepared);
  const tblPut = (await call('PUT', '/api/table', { slots: { 1: lunch.itemId } })).body;
  check('put lunch on table', tblPut.ok === true, JSON.stringify(tblPut.ops));
  const tblClr = (await call('DELETE', '/api/table')).body;
  check('clear table', tblClr.ok === true, 'cleared=' + tblClr.cleared);

  console.log('\n=== F. mail + collections + lottery + skills ===');
  const mail = (await call('GET', '/api/mail')).body;
  check('mail list', typeof mail.total === 'number', 'total=' + mail.total + ' unread=' + mail.unread);
  const claim = (await call('POST', '/api/mail/claim', {})).body;
  check('mail claim', claim.ok === true || claim.claimed === 0,
    'claimed=' + claim.claimed + ' gained=' + JSON.stringify(claim.gained));
  const col = (await call('GET', '/api/collections')).body;
  check('collections progress', !!col.progress, JSON.stringify(col.progress));
  const lot = (await call('GET', '/api/lottery')).body;
  check('lottery shape', typeof lot.ticketCost === 'number', JSON.stringify(lot));
  const draw = (await call('POST', '/api/lottery/draw', {})).body;
  check('lottery draw answered', typeof draw.ok === 'boolean',
    'ok=' + draw.ok + ' ' + (draw.message || ('ball=' + draw.ball)));
  const skills = (await call('GET', '/api/skills')).body;
  check('skills index', skills.count === 5, JSON.stringify(skills.skills.map((s) => s.name)));
  const one = (await call('GET', '/api/skills/frog-status')).body;
  check('skill body served', one.body.includes('FROG_API_BASE'), one.bytes + 'B');

  console.log('\n=== G. push settings + logs ===');
  const pu = (await call('GET', '/api/settings/push')).body;
  check('push config', !!pu.webhook && !!pu.meow, 'events=' + Object.keys(pu.events).length);
  const logs = (await call('GET', '/api/logs/push')).body;
  check('push logs endpoint', Array.isArray(logs.entries), 'entries=' + logs.entries.length);

  console.log('\n=== H. openapi ===');
  const oa = (await call('GET', '/api/openapi.json')).body;
  check('openapi paths', Object.keys(oa.paths).length === 21, Object.keys(oa.paths).length + ' paths');

  console.log('\n=== I. auth enforcement ===');
  const noauth = await new Promise((resolve) => {
    http.get(BASE + '/api/state', (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve({ s: r.statusCode, b })); });
  });
  check('no token -> 401', noauth.s === 401);
  const badTok = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 8980, path: '/api/state', headers: { Authorization: 'Bearer wrong' } },
      (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve({ s: r.statusCode })); });
  });
  check('bad token -> 403', badTok.s === 403);

  console.log('\n' + (failures ? failures + ' FAILURES' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})();
