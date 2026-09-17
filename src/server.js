'use strict';
/**
 * Entry point: one HTTP server on PORT (8980) serving
 *   /            the game (vendor/game + vendor/resource, rewritten per request)
 *   /ws          the WebSocket bridge to the single server-side engine
 *   /api/*       the REST surface for external agents
 *   /admin       the settings page
 *   /skills/*    the SKILL.md files themselves
 *   /__log       the sink __probe.js POSTs to with ?log=1
 *
 * Everything is in this one process on purpose: the engine is in-memory state
 * guarded by a single event loop, and splitting the WS bridge from the API would
 * mean either two engines (forbidden: two saves, two worlds) or an IPC layer with
 * no benefit at this scale.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { Settings } = require('./settings');
const { EngineHost } = require('./engine-host');
const { WsBridge } = require('./ws-bridge');
const { GameData } = require('./gamedata');
const { BotClient } = require('./bot');
const { StaticServer } = require('./static');
const { createApiRouter } = require('./api');
const { PushDispatcher } = require('./push/dispatcher');
const { PostcardRenderer } = require('./postcard');
const { buildOpenApi } = require('./openapi');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8980);
const HOST = process.env.HOST || '0.0.0.0';

/** Total engine-tick period. The WS bridge ticks the engine on this cadence and
 *  the dispatcher polls for events right after, so a notification is never more
 *  than one period behind the state change. */
const TICK_MS = Number(process.env.FROG_TICK_MS || 3000);

function ensureDirs(dataDir) {
  for (const d of ['save', 'logs']) {
    fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  }
}

function main() {
  const dataDir = process.env.FROG_DATA_DIR
    ? path.resolve(process.env.FROG_DATA_DIR)
    : path.join(ROOT, 'data');
  ensureDirs(dataDir);

  // ---- 轻量访问日志
  //
  // 这台服务此前的故障从不留在自己的日志里：WebView 在加载中途停住时，服务端
  // 看到的只是一次"没写完的响应"，而这一版之前连这都没记，于是每次"卡住"都
  // 不可复现、只能靠猜。这里只记**可疑**的请求：客户端中途断开、状态码 >= 400、
  // 或耗时超过阈值。正常请求一律不记，所以它既不会把日志冲成噪声，也不会成为
  // 常态 IO 负担。文件超过 ACCESS_MAX_BYTES 时清零重来，避免无限增长。
  const accessLogFile = path.join(dataDir, 'logs', 'access.log');
  const ACCESS_SLOW_MS = Number(process.env.FROG_ACCESS_SLOW_MS || 3000);
  const ACCESS_MAX_BYTES = 4 * 1024 * 1024;
  let accessLogBytes = fileSize(accessLogFile);
  const noteAccess = (line) => {
    try {
      if (accessLogBytes > ACCESS_MAX_BYTES) {
        fs.truncateSync(accessLogFile, 0);
        accessLogBytes = 0;
      }
      fs.appendFile(accessLogFile, line + '\n', () => { });
      accessLogBytes += Buffer.byteLength(line) + 1;
    } catch (e) { /* 记日志绝不能影响请求本身 */ }
  };

  const settings = new Settings(dataDir);
  const cfg = settings.get();

  // ---- engine
  const engineFile = path.join(ROOT, 'vendor', 'game', '__offline-engine.js');
  if (!fs.existsSync(engineFile)) {
    console.error('[server] vendor/game/__offline-engine.js 不存在。');
    console.error('[server] 请先运行:  node scripts/fetch-source.js');
    process.exit(2);
  }
  const host = new EngineHost({
    engineFile,
    saveDir: path.join(dataDir, 'save'),
    // FROG_CONFIG comes from data/config.json, whose default is FROG_FAITHFUL=1
    // (the original multi-hour timings). Real env vars win, so the integration
    // tests can force fast pacing without touching the operator's file.
    env: envWithOverrides(settings.engineEnv()),
    verbose: true,
  });
  host.start();
  console.log('[server] engine started; save -> ' + path.join(dataDir, 'save'));

  const gd = new GameData(engineFile);

  // ---- push
  const dispatcher = new PushDispatcher({ settings, host, gd, dataDir });

  // ---- bot (the API's own client)
  const bot = new BotClient({ host, account: 'api' });
  const handshake = bot.login();
  if (!handshake.ok) {
    console.error('[server] bot handshake failed; /api will still work but state may be unprimed');
  } else {
    console.log('[server] bot logged in; boot pushes = ' + handshake.handshake.bootPushes);
  }
  // Baseline the push diff AFTER login so the login's own boot pushes (which
  // include the tutorial mail) do not all fire as notifications on first start.
  dispatcher.prime();

  // ---- bridge
  const bridge = new WsBridge({
    host,
    tickMs: TICK_MS,
    onPush: (push) => {
      dispatcher.observePush(push);
      return undefined;
    },
    onLog: () => { },
  });

  // ---- http
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({
    limit: '8mb',
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ---- 可疑请求记录（见上面 noteAccess 的说明）
  //
  // 必须挂在所有路由之前，否则最需要被记录的那几条（资源 404、连接被掐断）
  // 根本走不到这里。req.path 用 `|| '/'` 兜底，避免 express 在某些挂载点上
  // 给出空串时把判断写歪。
  app.use((req, res, next) => {
    const path = req.path || '/';
    if (path === '/__log') { next(); return; }   // 探针自己的上报不记，否则会自己刷自己
    const t0 = Date.now();
    res.on('close', () => {
      const ms = Date.now() - t0;
      const code = res.statusCode;
      const cut = !res.writableEnded;            // 响应没写完就关了 => 客户端中途断开
      if (!cut && code < 400 && ms < ACCESS_SLOW_MS) return;
      const tag = cut ? 'CUT' : (code >= 400 ? 'ERR' : 'SLOW');
      noteAccess([
        new Date().toISOString(),
        tag,
        req.method,
        String(code),
        ms + 'ms',
        req.headers.range || '-',
        String(req.headers['user-agent'] || '-').slice(0, 70),
        req.originalUrl,
      ].join(' '));
    });
    next();
  });

  const staticServer = new StaticServer({
    gameDir: path.join(ROOT, 'vendor', 'game'),
    resourceDir: path.join(ROOT, 'vendor', 'resource'),
    wsPath: '/ws',
  });
  // Prefer the pristine copy fetch-source kept, so the response rewrite always
  // starts from the source package's bytes.
  const originalConfig = path.join(ROOT, 'vendor', 'gameConfig.original.json');
  if (fs.existsSync(originalConfig)) {
    staticServer.setOriginalConfig(fs.readFileSync(originalConfig, 'utf8'));
  }

  // ---- /api
  app.use('/api', createApiRouter({
    host, gd, bot, settings, push: dispatcher, bridge,
    openapi: buildOpenApi(),
    readClientLog: (limit) => readTail(path.join(dataDir, 'logs', 'client.log'), limit),
    readAccessLog: (limit) => readTail(accessLogFile, limit),
  }));

  // ---- /__log: the sink __probe.js posts to when the page is opened with ?log=1
  //
  // The probe sends the log as a PLAIN STRING via navigator.sendBeacon, which
  // means Content-Type: text/plain -- so express.json() (used for /api) never
  // parses it and its `verify` hook never fires. A dedicated text parser that
  // accepts any content type is what makes the body readable here.
  app.post('/__log', express.text({ type: () => true, limit: '1mb' }), (req, res) => {
    const body = typeof req.body === 'string' ? req.body
      : (req.rawBody ? req.rawBody.toString('utf8') : '');
    if (body) {
      try {
        fs.appendFileSync(path.join(dataDir, 'logs', 'client.log'), body.endsWith('\n') ? body : body + '\n');
      } catch (e) {
        console.error('[server] /__log write failed: ' + e.message);
      }
    }
    res.status(204).end();
  });

  // ---- /asset/postcard/<picId>: composed postcard PNGs.
  // Unauthenticated by necessity -- MeoW and webhook receivers fetch the image
  // themselves and cannot attach a Bearer token. It exposes only artwork that is
  // already served from /resource/China, so nothing private is revealed.
  const postcards = new PostcardRenderer({
    gd,
    imageRoot: path.join(ROOT, 'vendor', 'resource', 'China', 'images'),
    cacheDir: path.join(dataDir, 'cache', 'postcards'),
  });
  // Registered as two explicit paths rather than `/picId(\\d+).png?`: Express 4's
  // path-to-regexp treats the trailing `.png?` as mandatory, so the extensionless
  // form 404s -- and the extensionless form is exactly what a push notification
  // links to.
  const servePostcard = (req, res) => {
    const picId = Number(req.params.picId);
    let png = null;
    try {
      png = postcards.render(picId);
    } catch (e) {
      console.error('[server] postcard render failed for ' + picId + ': ' + (e && e.message));
    }
    if (!png) {
      res.status(404).type('text/plain').send('no postcard recipe for pic_id ' + picId);
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(png);
  };
  app.get('/asset/postcard/:picId(\\d+).png', servePostcard);
  app.get('/asset/postcard/:picId(\\d+)', servePostcard);

  // ---- /admin
  app.use('/admin', require('./admin').createAdminRouter({
    settings, host, dispatcher, gd, bot, bridge, dataDir,
  }));

  // ---- skills as static files (so an agent can fetch the raw markdown)
  app.use('/skills', express.static(path.join(ROOT, 'skills'), {
    index: false,
    setHeaders: (res) => { res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); },
  }));

  // ---- the game itself
  app.get(['/', '/index.html'], (req, res) => staticServer.serveIndex(req, res));

  app.get('/resource/China/config/gameConfig.json', (req, res) => staticServer.serveGameConfig(req, res));
  app.get('/resource/*', (req, res) => {
    const file = staticServer.resourceFile(req.path);
    if (!file) { res.status(404).type('text/plain').send('not found'); return; }
    staticServer.serveFile(req, res, file, { immutable: true });
  });

  // Everything else falls through to vendor/game: js/, manifest.json,
  // version.json, map.html, map_data.json, __offline-engine.js, __probe.js.
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
    const file = staticServer.gameFile(req.path);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { next(); return; }
    staticServer.serveFile(req, res, file);
  });

  app.use((req, res) => {
    res.status(404).type('text/plain').send('not found: ' + req.path);
  });

  app.use((err, req, res, next) => {
    console.error('[server] ' + req.method + ' ' + req.path + ': ' + (err && err.stack || err));
    if (res.headersSent) { next(err); return; }
    if (req.path.startsWith('/api')) {
      res.status(err.status || 500).json({
        error: { code: err.code || 'internal', message: String(err.message || err) },
      });
      return;
    }
    res.status(500).type('text/plain').send('internal error');
  });

  const server = http.createServer(app);
  // Node 默认 keepAliveTimeout 只有 5s。游戏的资源加载器固定 4 路并发，而组与组
  // 之间（以及加载页等待玩家点击时）经常有超过 5s 的空档——这时浏览器手里那条
  // 复用的连接已经被服务端悄悄关掉了，下一个请求发上去就变成 RST / 假死。
  // 症状是"传着传着突然不动了、刷新一下又好了"，和客户端是安卓还是鸿蒙无关，
  // 所以 1.0.2 之前那种"只有鸿蒙会挂"的判断并不成立。
  // headersTimeout 必须严格大于 keepAliveTimeout，否则 Node 会在连接被复用、
  // 但请求头还没读完时先把连接掐掉（这会制造出比原问题更难查的假象）。
  server.keepAliveTimeout = Number(process.env.FROG_KEEPALIVE_MS || 65000);
  server.headersTimeout = server.keepAliveTimeout + 5000;
  bridge.attach(server, '/ws');

  server.listen(PORT, HOST, () => {
    console.log('[server] listening on http://' + HOST + ':' + PORT);
    console.log('[server]   game   http://<host>:' + PORT + '/');
    console.log('[server]   admin  http://<host>:' + PORT + '/admin');
    console.log('[server]   api    http://<host>:' + PORT + '/api/health');
    console.log('[server]   ws     ws://<host>:' + PORT + '/ws');
    console.log('[server] engine env: ' + JSON.stringify(settings.engineEnv()));
  });

  // The engine clock and the push diff run on one timer, so the ordering is
  // deterministic: world moves, then events are derived from the new world.
  const worldTimer = setInterval(() => {
    try {
      bridge.tick();
      dispatcher.poll('tick');
      dispatcher.flushQuietQueue().catch(() => { });
    } catch (e) {
      console.error('[server] world tick failed: ' + (e && e.stack || e));
    }
  }, TICK_MS);
  if (worldTimer.unref) worldTimer.unref();
  // The bridge also ticks on its own; disable the duplicate to keep one clock.
  bridge.stopClock();

  // Any engine message the bridge handles also gets sampled for events.
  const origOnPush = bridge.onPush;
  bridge.onPush = (push, origin) => {
    origOnPush(push, origin);
    try { dispatcher.poll(origin || 'push'); } catch (e) { /* never break a message */ }
  };

  const shutdown = (sig) => {
    console.log('[server] ' + sig + ' received, shutting down');
    clearInterval(worldTimer);
    try { host.engine && host.engine.save(); } catch (e) { }
    bridge.close().finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server, host, bridge, dispatcher, settings, bot, gd };
}

/** Real process env wins over data/config.json, so `docker run -e FROG_FAITHFUL=0`
 *  and the test suite can override without editing the operator's file. */
function envWithOverrides(fromConfig) {
  const out = { ...fromConfig };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FROG_') && key !== 'FROG_CONFIG' && key !== 'FROG_TICK_MS'
      && key !== 'FROG_DATA_DIR' && key !== 'FROG_SOURCE') {
      out[key] = process.env[key];
    }
  }
  return out;
}

/** Size of a file in bytes, or 0 when it does not exist yet. Used to prime the
 *  access log's size counter without an extra stat on every request. */
function fileSize(file) {
  try { return fs.statSync(file).size; } catch (e) { return 0; }
}

/** Last `limit` lines of a log file (missing file -> empty). */
function readTail(file, limit) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, limit));
  } catch (e) {
    return [];
  }
}

if (require.main === module) main();

module.exports = { main, envWithOverrides, readTail, fileSize, PORT, TICK_MS };
