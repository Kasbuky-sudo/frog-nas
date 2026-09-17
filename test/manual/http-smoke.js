// HTTP + WS smoke test against a running server. Usage: node http-smoke.js [base]
const http = require('http');
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:8980';
const HOST = BASE.replace(/^https?:\/\//, '');

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST.split(':')[0], port: Number(HOST.split(':')[1] || 80), path, method: 'GET', headers: headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    req.on('error', reject);
    req.end();
  });
}

function postJSON(path, obj, headers) {
  const data = Buffer.from(JSON.stringify(obj));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST.split(':')[0], port: Number(HOST.split(':')[1] || 80), path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...(headers || {}) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== 1. index.html (Route A shim + CSP) ===');
  const idx = await get('/');
  console.log('status:', idx.status, 'type:', idx.headers['content-type']);
  console.log('CSP present:', !!idx.headers['content-security-policy']);
  console.log('shim injected:', idx.body.includes("transport") && idx.body.includes('replaceState'));
  const shimAt = idx.body.indexOf('replaceState');
  const engineAt = idx.body.indexOf('__offline-engine.js');
  console.log('shim BEFORE engine script:', shimAt > 0 && shimAt < engineAt, '(shim@' + shimAt + ' engine@' + engineAt + ')');
  console.log('notice preserved:', idx.body.includes('__notice') && idx.body.includes('Balticx') && idx.body.includes('Hit-Point'));

  console.log('\n=== 2. gameConfig.json rewrite ===');
  const cfg = await get('/resource/China/config/gameConfig.json');
  const parsed = JSON.parse(cfg.body);
  console.log('gameServer:', JSON.stringify(parsed.serverList.offline.gameServer));
  console.log('other fields intact: useNode=' + parsed.useNode + ' channelID=' + parsed.serverList.offline.channelID + ' showGM=' + parsed.showGM);

  console.log('\n=== 3. X-Forwarded-* honoured ===');
  const cfgTls = await get('/resource/China/config/gameConfig.json', {
    'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'frog.example.com',
  });
  console.log('wss behind proxy:', JSON.parse(cfgTls.body).serverList.offline.gameServer[0]);

  console.log('\n=== 4. static assets ===');
  for (const p of ['/js/main.min.js', '/__offline-engine.js', '/manifest.json', '/map.html', '/resource/China/default.res.json']) {
    const r = await get(p);
    console.log(' ', p, r.status, (r.headers['content-type'] || '').split(';')[0], r.body.length + 'B');
  }

  console.log('\n=== 5. /api/health (no auth) ===');
  const h = await get('/api/health');
  console.log('status:', h.status, h.body.slice(0, 200));

  console.log('\n=== 6. /api/state without token ===');
  const noauth = await get('/api/state');
  console.log('status:', noauth.status, noauth.body.slice(0, 120));

  console.log('\n=== 7. /api/state with token ===');
  const cfgFile = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'data', 'config.json'), 'utf8'));
  const tok = cfgFile.apiToken;
  const st = await get('/api/state', { Authorization: 'Bearer ' + tok });
  const sv = JSON.parse(st.body);
  console.log('status:', st.status);
  console.log('frog:', JSON.stringify(sv.frog));
  console.log('clovers ready:', sv.clovers.readyCount, '/', sv.clovers.total);
  console.log('mail:', sv.mail.total, 'lottery:', JSON.stringify(sv.lottery));
  console.log('progress:', JSON.stringify(sv.collections.progress));

  console.log('\n=== 8. POST /harvest ===');
  const hb = await postJSON('/api/harvest', {}, { Authorization: 'Bearer ' + tok });
  console.log('status:', hb.status, hb.body.slice(0, 300));

  console.log('\n=== 9. /api/shop ===');
  const shop = await get('/api/shop', { Authorization: 'Bearer ' + tok });
  const shopV = JSON.parse(shop.body);
  console.log('count:', shopV.count, 'buyable:', shopV.buyable.length, 'clover:', shopV.clover);
  console.log('sample:', JSON.stringify(shopV.items.slice(0, 2)));

  console.log('\n=== 10. /admin ===');
  const admin = await get('/admin');
  console.log('status:', admin.status, 'has token field:', admin.body.includes('api-token'));

  console.log('\n=== 11. /api/openapi.json ===');
  const oa = await get('/api/openapi.json', { Authorization: 'Bearer ' + tok });
  const oav = JSON.parse(oa.body);
  console.log('paths:', Object.keys(oav.paths).length);

  console.log('\n=== 12. WebSocket handshake (the browser path) ===');
  await new Promise((resolve) => {
    const ws = new WebSocket('ws://' + HOST + '/ws');
    const seen = [];
    let sessionN = 0;
    const pending = new Map();
    const send = (cmd, data) => {
      sessionN++;
      pending.set(sessionN, cmd);
      ws.send(JSON.stringify({ session: sessionN, timestamp: Math.floor(Date.now() / 1000), cmd, data: data || {} }));
    };
    ws.on('open', () => {
      console.log('connected');
      send('hall_gen_token', { account: 'smoke' });
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.session) {
        const cmd = pending.get(m.session);
        seen.push('reply:' + cmd);
        console.log('  reply for', cmd, JSON.stringify(m.data).slice(0, 80));
        if (cmd === 'hall_gen_token') send('hall_login', { token: m.data.token });
        else if (cmd === 'hall_login') send('hall_enter_game');
        else if (cmd === 'hall_enter_game') {
          setTimeout(() => { ws.close(); resolve(); }, 400);
        }
      } else {
        seen.push('push:' + m.cmd);
      }
    });
    ws.on('error', (e) => { console.log('ws error', e.message); resolve(); });
    setTimeout(() => { try { ws.close(); } catch (e) { } resolve(); }, 8000);
  });

  console.log('\n=== 13. fan-out: two tabs, one engine ===');
  await new Promise((resolve) => {
    const a = new WebSocket('ws://' + HOST + '/ws');
    const b = new WebSocket('ws://' + HOST + '/ws');
    let ready = 0;
    const bPushes = [];
    b.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (!m.session && m.cmd) bPushes.push(m.cmd);
    });
    const onOpen = () => {
      if (++ready < 2) return;
      setTimeout(() => {
        // A acts; B must see the resulting push.
        a.send(JSON.stringify({ session: 1, cmd: 'clover_load_clovers', data: {} }));
        a.send(JSON.stringify({ session: 2, cmd: 'clover_harvest', data: { clover_id: 1 } }));
        setTimeout(() => {
          console.log('B received pushes from A\'s action:', bPushes.length, bPushes.slice(0, 5).join(', '));
          console.log('cross-tab fanout works:', bPushes.length > 0);
          a.close(); b.close(); resolve();
        }, 1200);
      }, 200);
    };
    a.on('open', onOpen); b.on('open', onOpen);
    setTimeout(() => { try { a.close(); b.close(); } catch (e) { } resolve(); }, 8000);
  });
})();
