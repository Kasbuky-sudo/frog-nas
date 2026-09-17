'use strict';
/**
 * Server settings: data/config.json.
 *
 * One JSON file holds everything the operator can change at runtime: the API
 * bearer token, the two push channels, the engine's FROG_CONFIG env overrides,
 * and the /admin access code. Writes are atomic (temp + rename) because a
 * truncated config would lose the API token.
 *
 * Precedence for every value: default (here) < data/config.json < real process
 * env for the handful of deployment knobs that belong to Docker (PORT, TZ).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Engine pacing overrides an operator may set on the /admin page. */
const EDITABLE_ENV = [
  'FROG_FAITHFUL',
  'FROG_TRAVEL_MIN', 'FROG_TRAVEL_MAX', 'FROG_IDLE_MIN', 'FROG_IDLE_MAX',
  'FROG_WAIT_MIN', 'FROG_WAIT_MAX', 'FROG_DRIFT_MIN', 'FROG_DRIFT_MAX',
  'FROG_GUEST_ROLL', 'FROG_GUEST_CHANCE',
  'FROG_VISITOR_ROLL', 'FROG_VISITOR_CHANCE', 'FROG_VISITOR_STAY', 'FROG_VISITOR_COOL',
  'FROG_DRAWING_ROLL', 'FROG_DRAWING_CHANCE', 'FROG_DRAWING_TRIP',
  'FROG_LOTTERY_ROLL', 'FROG_LOTTERY_CHANCE', 'FROG_LOTTERY_OPTIONS',
  'FROG_SHOP_HOURS', 'FROG_PLANT_STAGE_SEC', 'FROG_CRAFT_SEC', 'FROG_MOTION_SEC',
  'FROG_WISH_POOL_DAYS', 'FROG_WISH_COINS_PER_DAY', 'FROG_WISH_COIN_MAX',
  'FROG_CAPSULE_DAYS', 'FROG_CAPSULE_COIN',
  'FROG_DECORATION_CHANCE', 'FROG_GUEST_CLOVER_POW', 'FROG_VISITOR_FOOD_MAX',
  'FROG_TRAVEL_STEPS', 'FROG_TRAVEL_GOAL_STEPS', 'FROG_TRAVEL_MINUTES',
];

/** The events a push channel can subscribe to.
 *
 *  Defaults reflect what a player actually wants pushed while away: the frog leaving
 *  and coming home (with what it brought), a postcard, the garden filling up, and a
 *  visitor. `clover_ready` is ON because it is the one event that fires purely from
 *  the world clock -- with nothing else happening, it is what tells you the game is
 *  still alive. The rest are opt-in. */
const PUSH_EVENTS = [
  'depart', 'postcard', 'return', 'clover_ready', 'visitor_arrive', 'visitor_gift',
  'mail', 'lottery', 'title_unlock', 'furniture_finish',
];

function defaultEvents() {
  const on = new Set(['depart', 'postcard', 'return', 'clover_ready', 'visitor_arrive', 'visitor_gift']);
  const out = {};
  for (const e of PUSH_EVENTS) out[e] = on.has(e);
  return out;
}

function defaults() {
  return {
    configVersion: 1,
    /** Whether /api requires `Authorization: Bearer <apiToken>`.
     *
     *  OFF by default: this runs on a home LAN, and an AI agent that already knows
     *  the address should not also need a secret pasted into its config. The token
     *  still exists (and the settings page still shows it) so it can be switched on
     *  when the port is reachable by anything you do not trust -- a shared network,
     *  a port forward, a reverse proxy without its own auth. */
    requireToken: false,
    /** Bearer token for /api/*, used only when requireToken is true. */
    apiToken: crypto.randomBytes(24).toString('hex'),
    /** /admin access code. Empty means "no code" (the default). */
    adminCode: '',
    /** Public base URL used to build absolute links (postcard images) in pushes.
     *  Empty means "derive from the request that triggered the notification". */
    publicUrl: '',
    engine: {
      /** FROG_FAITHFUL=1 keeps the original multi-hour travel timings. */
      env: { FROG_FAITHFUL: '1' },
    },
    push: {
      enabled: true,
      /** Quiet hours: notifications are queued and flushed when the window ends. */
      quietHours: { enabled: true, from: '23:00', to: '07:00' },
      events: defaultEvents(),
      webhook: {
        enabled: false,
        url: '',
        headers: {},
        /** Body template. Placeholders: {{event}} {{title}} {{body}} {{timestamp}} {{url}} {{image}}. */
        template: '',
        /** 'json' posts the rendered template as application/json when it parses,
         *  otherwise as text/plain. */
        contentType: 'json',
      },
      meow: {
        enabled: false,
        /** MeoW identifies a recipient by NICKNAME alone -- there is no token. */
        nickname: '',
        apiBase: 'https://api.chuckfang.com',
        msgType: 'text',
        imgUrl: '',
        url: '',
        htmlHeight: 200,
      },
      retry: { attempts: 3, baseDelayMs: 2000 },
      /** Keep the push log bounded. */
      logLimit: 5000,
    },
  };
}

/** Deep-merge stored config over defaults so a config written by an older build
 *  still loads (missing keys take their default). Arrays are replaced wholesale. */
function merge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (typeof base !== 'object' || typeof over !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

class Settings {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.value = null;
    this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // A corrupt config must not silently rotate the API token away from the
        // operator's copy, so keep the bytes and start from defaults.
        const keep = this.file + '.corrupt-' + Date.now();
        try { fs.renameSync(this.file, keep); } catch (e2) { /* best effort */ }
        console.error('[settings] config.json unreadable, kept at ' + keep + ': ' + e.message);
      }
    }
    this.value = merge(defaults(), stored || {});
    // PUBLIC_URL from the environment wins over the file, so docker-compose can
    // set the public address without the operator editing JSON by hand.
    if (process.env.PUBLIC_URL !== undefined && process.env.PUBLIC_URL !== '') {
      this.value.publicUrl = String(process.env.PUBLIC_URL).replace(/\/+$/, '');
    }
    if (!stored) this.save();
    return this.value;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    return this.value;
  }

  get() { return this.value; }

  /** Replace part of the config (deep merge) and persist. */
  update(patch) {
    this.value = merge(this.value, patch);
    this.save();
    return this.value;
  }

  /** Engine env for FROG_CONFIG: only string values, since the engine reads
   *  process.env-style strings. */
  engineEnv() {
    const env = (this.value.engine && this.value.engine.env) || {};
    const out = {};
    for (const [k, v] of Object.entries(env)) {
      if (v === null || v === undefined || v === '') continue;
      out[k] = String(v);
    }
    return out;
  }

  resetToken() {
    this.value.apiToken = crypto.randomBytes(24).toString('hex');
    this.save();
    return this.value.apiToken;
  }

  /** Is a Bearer token required for /api? */
  tokenRequired() {
    return this.value.requireToken === true;
  }

  /**
   * Authorise an /api request.
   * @param {string} provided  the token from the Authorization header ('' if absent)
   * @returns {{ok: boolean, reason?: string}}
   */
  checkApiAuth(provided) {
    if (!this.tokenRequired()) return { ok: true };
    if (!provided) return { ok: false, reason: 'missing' };
    return this.checkToken(provided) ? { ok: true } : { ok: false, reason: 'bad' };
  }

  /** Constant-time compare so a wrong token cannot be found by timing. */
  checkToken(provided) {
    const want = Buffer.from(String(this.value.apiToken || ''));
    const got = Buffer.from(String(provided || ''));
    if (want.length !== got.length) return false;
    return crypto.timingSafeEqual(want, got);
  }

  checkAdminCode(provided) {
    const want = String(this.value.adminCode || '');
    if (!want) return true;                 // no code configured -> open
    return this.checkAdminCodeString(want, String(provided || ''));
  }

  checkAdminCodeString(want, got) {
    const a = Buffer.from(want);
    const b = Buffer.from(got);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

module.exports = { Settings, defaults, merge, EDITABLE_ENV, PUSH_EVENTS };
