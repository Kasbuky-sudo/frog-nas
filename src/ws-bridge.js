'use strict';
/**
 * WebSocket bridge: the browser's transport, speaking the game's own wire protocol.
 *
 * The client (js/socket.min.js + main.min.js) is the only thing that defines the
 * envelope, and it is exactly:
 *
 *   client -> server : {"session"?: N, "timestamp": N, "cmd": "client.load_role", "data": {...}}
 *   server -> client : {"session": N, "data": {...}}              reply to a command
 *                    | {"cmd": "item.load_items", "data": {...}}   unsolicited push
 *
 * (main.min.js: SocketManage.send builds that object; AnalysisProtocol branches on
 * `cmd` being empty/absent to tell a reply from a push, and on `session` to route a
 * reply to the callback registered for it.)
 *
 * One engine, many views
 * ---------------------
 * The engine is authoritative and there is exactly one of it, so every client sees
 * the same world. Two rules make that work:
 *
 *   - replies go back ONLY to the socket that asked (the client correlates them by
 *     session id, and a foreign session id would be "协议编号 N 不存在");
 *   - everything unsolicited (engine pushes, time-driven ticks, another client's
 *     action) is broadcast to ALL sockets, which is the "two tabs see the same
 *     world within 30 s" requirement.
 *
 * The one deliberate exception is the boot sequence: `hall_enter_game` returns 42
 * pushes that belong to the client that just logged in. Those are additionally sent
 * to the asking socket only -- see `respond` below.
 *
 * Pushes are also where the push subsystem gets its events: every message the
 * engine emits passes through `onPush`, and a periodic `tick()` keeps time moving
 * even with no browser attached (that is what makes the integration tests and the
 * headless notification path work).
 */
const { WebSocketServer } = require('ws');

/** Default cadence of the engine's clock. The probe's in-page loopback used 5000 ms;
 *  the server can afford to be a bit brisker because it also feeds the push system. */
const DEFAULT_TICK_MS = 3000;

class WsBridge {
  /**
   * @param {object} opts
   * @param {import('./engine-host').EngineHost} opts.host
   * @param {number} [opts.tickMs]
   * @param {(push: {cmd: string, data: any}, origin: string) => void} [opts.onPush]
   * @param {(info: object) => void} [opts.onLog]
   */
  constructor(opts) {
    this.host = opts.host;
    this.tickMs = opts.tickMs || DEFAULT_TICK_MS;
    this.onPush = opts.onPush || (() => { });
    this.onLog = opts.onLog || (() => { });
    this.wss = null;
    this.clients = new Set();
    this.timer = null;
    this.seq = 0;
    this.stats = { connections: 0, messagesIn: 0, messagesOut: 0, ticks: 0, errors: 0 };
  }

  /** Attach to an existing HTTP server (so the game and the API share one port). */
  attach(httpServer, path) {
    this.wss = new WebSocketServer({ server: httpServer, path: path || '/ws' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', (e) => {
      this.stats.errors++;
      console.error('[ws] server error: ' + e.message);
    });
    this.startClock();
    return this;
  }

  onConnection(ws, req) {
    const id = ++this.seq;
    ws.frogId = id;
    ws.frogAlive = true;
    this.clients.add(ws);
    this.stats.connections++;
    this.onLog({ kind: 'connect', id, remote: req.socket.remoteAddress, total: this.clients.size });

    // Heartbeat: a laptop that sleeps leaves a half-open socket behind, and the
    // client would otherwise keep believing it is connected.
    ws.on('pong', () => { ws.frogAlive = true; });

    ws.on('message', (raw) => {
      this.stats.messagesIn++;
      this.handleMessage(ws, raw);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.onLog({ kind: 'disconnect', id, total: this.clients.size });
    });

    ws.on('error', (e) => {
      this.stats.errors++;
      this.onLog({ kind: 'error', id, message: e.message });
    });
  }

  handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      this.onLog({ kind: 'bad-json', data: String(raw).slice(0, 200) });
      return;
    }
    if (!msg || typeof msg.cmd !== 'string' || !msg.cmd) {
      this.onLog({ kind: 'bad-envelope', data: JSON.stringify(msg).slice(0, 200) });
      return;
    }
    let out;
    try {
      out = this.host.dispatch(msg.cmd, msg.data || {});
    } catch (e) {
      this.stats.errors++;
      console.error('[ws] dispatch ' + msg.cmd + ' threw: ' + (e && e.stack || e));
      return;
    }

    // --- reply (session-correlated, only to the asker) ---
    if (msg.session != null) {
      this.send(ws, { session: msg.session, data: out.reply || {} });
    } else if (out.reply !== undefined) {
      // An uncorrelated command still gets its reply in push form, exactly as the
      // in-page loopback did.
      const wire = this.toWire(msg.cmd);
      this.send(ws, { cmd: wire, data: out.reply });
    }

    // --- engine pushes from this command ---
    const pushes = out.pushes || [];
    for (const p of pushes) {
      this.broadcast(p);
      this.onPush(p, 'dispatch:' + msg.cmd);
    }

    this.onLog({ kind: 'dispatch', cmd: msg.cmd, handled: out.handled, pushes: pushes.length });
  }

  /** The client converts only the FIRST underscore to a dot; mirror that so an
   *  uncorrelated reply is addressed the same way a real push would be. */
  toWire(cmd) {
    if (this.host.sandbox && this.host.sandbox.FrogEngine) {
      return this.host.sandbox.FrogEngine.toWire(this.host.sandbox.FrogEngine.canon(cmd));
    }
    const i = String(cmd).indexOf('_');
    return i < 0 ? String(cmd) : String(cmd).slice(0, i) + '.' + String(cmd).slice(i + 1);
  }

  send(ws, obj) {
    if (ws.readyState !== 1 /* OPEN */) return false;
    try {
      ws.send(JSON.stringify(obj));
      this.stats.messagesOut++;
      return true;
    } catch (e) {
      this.stats.errors++;
      return false;
    }
  }

  /** Send to every connected client. This is what keeps two tabs in sync. */
  broadcast(obj) {
    const text = JSON.stringify(obj);
    let n = 0;
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(text);
        this.stats.messagesOut++;
        n++;
      } catch (e) { this.stats.errors++; }
    }
    return n;
  }

  /**
   * Run the engine's clock and fan the resulting pushes out to everyone.
   * This runs whether or not anybody is connected: the world keeps moving, which
   * is what lets the push system notify a player who has the page closed.
   */
  startClock() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stopClock() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (!this.host.ready) return [];
    let pushes;
    try {
      pushes = this.host.tick();
    } catch (e) {
      this.stats.errors++;
      console.error('[ws] tick threw: ' + (e && e.stack || e));
      return [];
    }
    this.stats.ticks++;
    if (!pushes || !pushes.length) return [];
    for (const p of pushes) {
      this.broadcast(p);
      this.onPush(p, 'tick');
    }
    return pushes;
  }

  close() {
    this.stopClock();
    if (this.wss) {
      for (const ws of this.clients) { try { ws.close(); } catch (e) { } }
      this.clients.clear();
      return new Promise((resolve) => this.wss.close(() => resolve()));
    }
    return Promise.resolve();
  }
}

module.exports = { WsBridge, DEFAULT_TICK_MS };
