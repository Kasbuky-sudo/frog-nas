'use strict';
/**
 * MeoW request shaping. The service identifies a recipient by nickname alone and
 * reports application errors in the body, so the tests pin both the URL/body
 * shape and the "status field, not just HTTP code" success rule.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const meow = require('../../src/push/meow');

/** A stub MeoW server; returns {base, close, requests}. */
function stubServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => b += c);
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: b, headers: req.headers });
      handler(req, res, b);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: 'http://127.0.0.1:' + port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const NOTE = {
  event: 'depart', title: '青蛙出发了', body: '蛙背上行囊出门了。',
  data: {}, at: 1700000000, url: '', image: '',
};

test('MeoW: POST puts the nickname in the path and title/msg in a JSON body', async () => {
  const s = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":200,"msg":"推送成功"}');
  });
  const r = await meow.send(NOTE, { nickname: '我的蛙', apiBase: s.base });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'POST');
  assert.equal(s.requests.length, 1);
  const req = s.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/' + encodeURIComponent('我的蛙'));
  assert.match(req.headers['content-type'], /application\/json/);
  const payload = JSON.parse(req.body);
  assert.equal(payload.title, '青蛙出发了');
  assert.equal(payload.msg, '蛙背上行囊出门了。');
  assert.equal(payload.url, undefined, 'no url key when there is none');
  assert.equal(payload.imgUrl, undefined);
  await s.close();
});

test('MeoW: a postcard image and link are included when present', async () => {
  const s = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":200,"msg":"推送成功"}');
  });
  await meow.send({
    ...NOTE, url: 'http://nas:8980/',
    image: 'http://nas:8980/asset/postcard/100',
  }, { nickname: 'frog', apiBase: s.base });
  const payload = JSON.parse(s.requests[0].body);
  assert.equal(payload.url, 'http://nas:8980/');
  assert.equal(payload.imgUrl, 'http://nas:8980/asset/postcard/100');
  await s.close();
});

test('MeoW: HTTP 200 with a non-200 status field is a FAILURE', async () => {
  // This is how the service reports a bad nickname: 200 + status:400.
  const s = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":400,"msg":"昵称不存在"}');
  });
  const r = await meow.send(NOTE, { nickname: 'nobody', apiBase: s.base });
  assert.equal(r.ok, false);
  assert.match(r.error, /昵称不存在/);
  await s.close();
});

test('MeoW: an HTTP error is a failure even if the body claims success', async () => {
  const s = await stubServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"status":200,"msg":"推送成功"}');
  });
  const r = await meow.send(NOTE, { nickname: 'x', apiBase: s.base });
  assert.equal(r.ok, false);
  await s.close();
});

test('MeoW: method GET uses the path form and carries msgType', async () => {
  const s = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":200,"msg":"推送成功"}');
  });
  const r = await meow.send(NOTE, { nickname: '我的蛙', apiBase: s.base, method: 'GET', msgType: 'text' });
  assert.equal(r.ok, true);
  assert.equal(s.requests[0].method, 'GET');
  const url = new URL(s.requests[0].url, 'http://x');
  assert.equal(url.pathname, '/' + encodeURIComponent('我的蛙') + '/' +
    encodeURIComponent(NOTE.title) + '/' + encodeURIComponent(NOTE.body));
  assert.equal(url.searchParams.get('msgType'), 'text');
  await s.close();
});

test('MeoW: a missing nickname fails fast without any request', async () => {
  const r = await meow.send(NOTE, { nickname: '', apiBase: 'http://127.0.0.1:1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /昵称/);
});

test('MeoW: a trailing slash on apiBase does not produce a double slash', async () => {
  const s = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":200,"msg":"推送成功"}');
  });
  await meow.send(NOTE, { nickname: 'n', apiBase: s.base + '///' });
  assert.equal(s.requests[0].url, '/n');
  await s.close();
});

test('MeoW: the documented default base is used when none is set', () => {
  assert.equal(meow.DEFAULT_BASE, 'https://api.chuckfang.com');
});

test('MeoW: an unreachable host reports an error rather than throwing', async () => {
  const r = await meow.send(NOTE, { nickname: 'n', apiBase: 'http://127.0.0.1:9' }, { timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
