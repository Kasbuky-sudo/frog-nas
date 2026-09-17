// Trigger a real game event (depart) and confirm the webhook fires automatically.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const tok = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')).apiToken;

function call(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? Buffer.from(JSON.stringify(b)) : null;
    const q = http.request({
      host: '127.0.0.1', port: 8980, path: p, method: m,
      headers: { Authorization: 'Bearer ' + tok, ...(d ? { 'Content-Type': 'application/json', 'Content-Length': d.length } : {}) },
    }, (r) => { let t = ''; r.on('data', (c) => t += c); r.on('end', () => { try { res(JSON.parse(t)); } catch (e) { res({ raw: t }); } }); });
    q.on('error', rej);
    if (d) q.write(d);
    q.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('1. 买一个便当并装进背包');
  const buy = await call('POST', '/api/shop/buy', { shopId: 0, qty: 1 });
  console.log('   buy ok=' + buy.ok + ' clover=' + buy.clover);
  const pack = await call('PUT', '/api/luggage', { slots: { 1: 0 } });
  console.log('   pack ok=' + pack.ok);

  const before = await call('GET', '/api/state');
  console.log('2. 蛙状态:', before.frog.status, '| nextDepartAt in',
    before.frog.nextDepartAt - Math.floor(Date.now() / 1000), 'sec');
  console.log('   推送配置: webhook=' + (await call('GET', '/api/settings/push')).webhook.enabled);

  console.log('3. 等待真实出发事件…');
  let departed = false;
  for (let i = 0; i < 200; i++) {
    await sleep(1000);
    const s = await call('GET', '/api/state');
    if (s.frog.status === 'away') {
      departed = true;
      console.log('   蛙已出发！tripCount=' + s.frog.tripCount + '，等待推送投递…');
      break;
    }
    if (i % 20 === 19) console.log('   …等了 ' + (i + 1) + ' 秒，状态仍为 ' + s.frog.status);
  }
  if (!departed) { console.log('   超时：没有出发'); process.exit(1); }

  await sleep(3000);
  const logs = await call('GET', '/api/logs/push?limit=10');
  console.log('\n4. 推送日志（最近条目的 kind/event/ok）:');
  for (const e of logs.entries.slice(0, 8)) {
    console.log('   ' + e.t + '  ' + (e.kind || '') + '  ' + (e.event || '') + '  ' + (e.ok === undefined ? '' : (e.ok ? 'OK' : 'FAIL')) + '  ' + (e.error || ''));
  }
})();
