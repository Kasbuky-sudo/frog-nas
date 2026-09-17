'use strict';
/**
 * The bot client: a second, in-process consumer of the engine, on the same wire
 * protocol the browser speaks.
 *
 * Why a client and not direct state access: every rule that matters -- slot typing,
 * buy limits, prerequisite chains, feed-once-per-visit, ticket cost -- lives inside
 * the engine's handlers. Reimplementing any of it here would fork the game's
 * behaviour, which the brief forbids. So the bot does what a browser would do:
 * send a command, read the reply, and capture the pushes that came with it.
 *
 * The one thing it does NOT do is keep its own login session alive. The engine is
 * a single shared world -- there is no per-connection state -- so the handshake is
 * performed once at startup for realism (the client's own ordering: hall_gen_token
 * -> hall_login -> hall_enter_game, i.e. main.min.js NetworkControl.totalEvents)
 * and afterwards commands can be dispatched at any time. A handshake failure is
 * surfaced, not swallowed, because it means the engine did not start properly.
 *
 * Push collection is the other half: `call()` returns the pushes that the command
 * produced, and `drainPushes()` returns the ones produced by the clock. The push
 * dispatcher consumes both, which is how a notification can say "你的蛙出发了"
 * without the API layer re-deriving game state.
 */
class BotClient {
  /**
   * @param {object} opts
   * @param {import('./engine-host').EngineHost} opts.host
   * @param {string} [opts.account]
   * @param {boolean} [opts.verbose]
   * @param {(push: object) => void} [opts.onPush]  also notified for clock pushes
   */
  constructor(opts) {
    this.host = opts.host;
    this.account = opts.account || 'api';
    this.verbose = !!opts.verbose;
    this.onPush = opts.onPush || (() => { });
    this.loggedIn = false;
    this.handshake = null;
    /** Command log, newest last. Bounded: the API can be polled for hours. */
    this.history = [];
    this.historyLimit = 200;
  }

  /**
   * Reproduce the browser's first packets.
   *
   * Evidence (main.min.js NetworkControl.totalEvents):
   *   ConnectionSucceed + ChannelType.Test -> send("hall_gen_token", null, userName)
   *   reply arrives as UserEventType.getToken -> send("hall_login", null, token)
   *   reply arrives as UserEventType.loginComplete -> send("hall_enter_game")
   * This build's gameConfig is ChannelType 1 (Test), which is the path implemented
   * below; the Ejoy/WXgame branches send hall_login with a stored token instead.
   */
  login() {
    const out = [];
    const gen = this.host.dispatch('hall_gen_token', { account: this.account });
    this.pushHistory('hall_gen_token', gen);
    out.push(gen);
    const token = (gen.reply && gen.reply.token) || 'offline-' + this.account;

    const login = this.host.dispatch('hall_login', { token });
    this.pushHistory('hall_login', login);
    out.push(login);

    const enter = this.host.dispatch('hall_enter_game', {});
    this.pushHistory('hall_enter_game', enter);
    out.push(enter);

    const ok = !!(enter.reply && Number(enter.reply.code) === 0);
    this.loggedIn = ok;
    this.handshake = {
      account: this.account,
      token,
      code: enter.reply && enter.reply.code,
      bootPushes: (enter.pushes || []).length,
      at: Date.now(),
    };
    // The boot pushes go to the dispatcher too: they carry state the diff baseline
    // needs (mail list, guest, album) and the first-login tutorial mail.
    for (const p of enter.pushes || []) this.onPush(p);
    if (this.verbose) {
      console.log('[bot] handshake ok=' + ok + ' bootPushes=' + (enter.pushes || []).length);
    }
    return { ok, results: out, handshake: this.handshake };
  }

  pushHistory(cmd, result) {
    this.history.push({
      at: Date.now(),
      cmd,
      handled: !!result.handled,
      reply: result.reply === undefined ? null : result.reply,
      pushes: (result.pushes || []).map((p) => p.cmd),
    });
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }

  /**
   * Send one command.
   * @returns {{ok: boolean, code: number|undefined, reason: string|undefined,
   *            reply: any, pushes: Array, cmd: string}}
   */
  call(cmd, data) {
    const res = this.host.dispatch(cmd, data || {});
    this.pushHistory(cmd, res);
    for (const p of res.pushes || []) this.onPush(p);
    const reply = res.reply;
    return {
      cmd,
      ok: res.handled,
      code: reply && reply.code !== undefined ? Number(reply.code) : undefined,
      reason: reply && reply.reason,
      reply,
      pushes: res.pushes || [],
      handled: !!res.handled,
    };
  }

  /**
   * A command whose reply is the interesting part (load_* commands).
   * Some handlers return `undefined` for a refusal (guest_serve does), so callers
   * must treat `{reply: undefined}` as "the game refused" rather than as an error.
   */
  query(cmd, data) {
    const r = this.call(cmd, data);
    return r.reply;
  }

  /** Pushes produced by the engine's clock since the last call. */
  drainPushes() {
    const pushes = this.host.tick() || [];
    for (const p of pushes) this.onPush(p);
    return pushes;
  }

  get state() { return this.host.state; }

  recent(limit) {
    return this.history.slice(-(limit || 20));
  }

  /** Where the bot's own state comes from -- surfaced in /api/health. */
  info() {
    return {
      account: this.account,
      loggedIn: this.loggedIn,
      handshake: this.handshake,
      commands: this.history.length,
      lastCommand: this.history.length ? this.history[this.history.length - 1].cmd : null,
    };
  }
}

module.exports = { BotClient };
