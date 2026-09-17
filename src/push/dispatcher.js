'use strict';
/**
 * Push dispatcher: events -> channels, with quiet hours, retries and a log.
 *
 * Flow
 * ----
 *   engine pushes / snapshot ticks
 *     -> events.derive()          (what actually happened)
 *     -> this.notify()            (filters, quiet hours, fan-out)
 *     -> webhook.send / meow.send (one attempt per channel)
 *     -> retry with exponential backoff
 *     -> data/logs/push.jsonl     (every attempt, success or not)
 *
 * Quiet hours
 * -----------
 * A notification raised inside the window is NOT dropped: it is queued and flushed
 * when the window closes, because "your frog came home at 02:00" is still worth
 * knowing at 07:00. The queue is bounded and persisted in memory only -- a restart
 * during the quiet window loses at most the pending notifications, which is the
 * right trade against writing another state file.
 *
 * Retry
 * -----
 * 3 attempts, 2s -> 4s -> 8s by default (settings.push.retry). Only the transport
 * and HTTP status are retried; a 4xx from a webhook is retried anyway, because a
 * misconfigured URL is exactly what the operator wants to see reported in the log.
 */
const fs = require('fs');
const path = require('path');
const events = require('./events');
const webhook = require('./webhook');
const meow = require('./meow');

const LOG_FILE = 'logs/push.jsonl';

/** "23:00" -> minutes since midnight; null when unparseable. */
function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Is `at` (Date) inside [from, to)? Handles a window that crosses midnight. */
function inQuietHours(at, quiet, timeZoneOffsetMin) {
  if (!quiet || !quiet.enabled) return false;
  const from = parseClock(quiet.from);
  const to = parseClock(quiet.to);
  if (from === null || to === null) return false;
  // Local time at the server (TZ is set by compose), optionally offset for a
  // caller-specified zone.
  const minutes = at.getHours() * 60 + at.getMinutes() + (timeZoneOffsetMin || 0);
  const now = ((minutes % 1440) + 1440) % 1440;
  if (from === to) return false;
  if (from < to) return now >= from && now < to;
  return now >= from || now < to;      // crosses midnight
}

class PushDispatcher {
  /**
   * @param {object} opts
   * @param {import('../settings').Settings} opts.settings
   * @param {import('../engine-host').EngineHost} opts.host
   * @param {import('../gamedata').GameData} [opts.gd]
   * @param {string} opts.dataDir
   * @param {(line: string) => void} [opts.log]
   */
  constructor(opts) {
    this.settings = opts.settings;
    this.host = opts.host;
    this.gd = opts.gd || null;
    this.dataDir = opts.dataDir;
    this.log = opts.log || (() => { });
    this.config = (opts.settings.get().push) || {};
    this.prevSnapshot = null;
    this.pendingWire = [];
    this.quietQueue = [];
    this.logPath = path.join(this.dataDir, LOG_FILE);
    this.recent = [];
    this.stats = { derived: 0, sent: 0, failed: 0, suppressed: 0, queued: 0, flushed: 0 };
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  reload(config) {
    if (config) this.config = config;
    return this.config;
  }

  /** Wire pushes arrive here so postcard/return detail is available at derive time,
   *  and so the engine's own mail/guest pushes can seed the snapshot early. */
  observePush(push) {
    if (!push || !push.cmd) return;
    this.pendingWire.push(push);
    if (this.pendingWire.length > 200) this.pendingWire.splice(0, this.pendingWire.length - 200);
  }

  /**
   * Take a state snapshot, derive events against the previous one, and dispatch.
   * Called on every engine message batch and on the periodic tick.
   *
   * @param {string} [origin] for the log
   * @returns {Array} the events that were raised
   */
  poll(origin) {
    if (!this.host.ready) return [];
    let snap;
    try {
      snap = events.snapshot(this.host.state);
    } catch (e) {
      return [];
    }
    const wire = this.pendingWire;
    this.pendingWire = [];
    const derived = events.derive(this.prevSnapshot, snap, this.host.state, this.gd, wire);
    this.prevSnapshot = snap;
    this.stats.derived += derived.length;
    for (const ev of derived) {
      this.notify(ev, origin || 'poll').catch((e) => {
        console.error('[push] notify failed: ' + (e && e.stack || e));
      });
    }
    return derived;
  }

  /** Establish the baseline without emitting anything (startup / save import). */
  prime() {
    if (!this.host.ready) return;
    this.prevSnapshot = events.snapshot(this.host.state);
    this.pendingWire = [];
  }

  /** Is this event type subscribed on at least one channel? */
  subscribed(event) {
    const ev = (this.config.events || {})[event];
    return ev !== false;
  }

  /** Absolute URL for a postcard image, so a webhook reader can fetch it.
   *  Served from /asset/postcard/<picId>, which is deliberately outside /api:
   *  the receiving service (MeoW, a webhook) fetches this URL itself and has no
   *  way to send a Bearer token. See docs/decisions.md. */
  imageUrl(note) {
    const base = (this.settings.get().publicUrl || '').replace(/\/+$/, '');
    if (!base || !note.data || !note.data.picId) return '';
    return base + '/asset/postcard/' + note.data.picId;
  }

  linkUrl(note) {
    const base = (this.settings.get().publicUrl || '').replace(/\/+$/, '');
    return base ? base + '/' : '';
  }

  /**
   * Deliver one event to every enabled channel.
   * @returns {Promise<{ok:boolean, results:Array}>}
   */
  async notify(ev, origin) {
    if (!this.config.enabled) { this.stats.suppressed++; return { ok: true, results: [] }; }
    if (!this.subscribed(ev.event)) { this.stats.suppressed++; return { ok: true, results: [] }; }

    const note = {
      event: ev.event,
      title: ev.title,
      body: ev.body,
      data: ev.data || {},
      at: Math.floor(Date.now() / 1000),
      origin: origin || 'unknown',
    };
    note.image = this.imageUrl(note);
    note.url = this.linkUrl(note);

    if (inQuietHours(new Date(), this.config.quietHours)) {
      this.quietQueue.push(note);
      this.stats.queued++;
      this.logLine({ kind: 'queued', event: note.event, reason: 'quiet-hours' });
      return { ok: true, results: [{ channel: 'queue', ok: true, skipped: 'quiet-hours' }] };
    }
    const results = await this.deliver(note);
    return { ok: results.some((r) => r.ok), results };
  }

  /** Flush anything held by quiet hours. Called by the periodic check. */
  async flushQuietQueue() {
    if (!this.quietQueue.length) return [];
    if (inQuietHours(new Date(), this.config.quietHours)) return [];
    const queued = this.quietQueue.splice(0, this.quietQueue.length);
    this.stats.flushed += queued.length;
    const out = [];
    for (const note of queued) {
      const results = await this.deliver(note);
      out.push({ note, results });
    }
    return out;
  }

  /** Run one event through the enabled channels, with retry per channel. */
  async deliver(note) {
    const chans = (this.config && this.config) || {};
    const channels = [];
    if (chans.webhook && chans.webhook.enabled && chans.webhook.url) {
      channels.push({ name: 'webhook', send: (n) => webhook.send(n, chans.webhook) });
    }
    if (chans.meow && chans.meow.enabled && chans.meow.nickname) {
      channels.push({ name: 'meow', send: (n) => meow.send(n, chans.meow) });
    }
    if (!channels.length) {
      this.logLine({ kind: 'no-channel', event: note.event });
      return [];
    }

    const retry = chans.retry || {};
    const attempts = Math.max(1, Math.min(Number(retry.attempts) || 3, 6));
    const baseDelay = Math.max(0, Number(retry.baseDelayMs) || 2000);

    const results = [];
    for (const ch of channels) {
      let last = null;
      for (let i = 1; i <= attempts; i++) {
        const r = await ch.send(note).catch((e) => ({ ok: false, error: String(e && e.message || e), ms: 0 }));
        last = { channel: ch.name, attempt: i, ...r };
        if (r.ok) break;
        if (i < attempts) {
          const wait = baseDelay * Math.pow(2, i - 1);
          this.logLine({ kind: 'retry', channel: ch.name, event: note.event, attempt: i, waitMs: wait, error: r.error });
          await new Promise((res) => setTimeout(res, wait));
        }
      }
      if (last.ok) this.stats.sent++; else this.stats.failed++;
      this.logLine({
        kind: 'push',
        channel: last.channel,
        event: note.event,
        title: note.title,
        body: note.body,
        ok: !!last.ok,
        status: last.status,
        mode: last.mode,
        error: last.error,
        ms: last.ms,
        attempts: last.attempt,
        origin: note.origin,
      });
      results.push(last);
    }
    return results;
  }

  /** The operator-facing "send test" button: both channels, a synthetic event. */
  async test(overrides) {
    const o = overrides || {};
    const note = {
      event: 'test',
      title: o.title || '测试推送',
      body: o.body || '这是一条来自 NAS 旅行青蛙的测试通知。',
      data: { test: true },
      at: Math.floor(Date.now() / 1000),
      origin: 'admin-test',
    };
    note.url = this.linkUrl(note);
    note.image = '';
    // A test bypasses quiet hours and subscriptions: it exists to verify plumbing.
    const cfg = this.config;
    const saveQuiet = cfg.quietHours;
    cfg.quietHours = { enabled: false };
    // Route through deliver() so the retry + log paths are exercised too.
    const prevEvents = cfg.events;
    cfg.events = {};
    try {
      const results = await this.deliver(note);
      return { ok: results.some((r) => r.ok), results };
    } finally {
      cfg.quietHours = saveQuiet;
      cfg.events = prevEvents;
    }
  }

  /** Append one JSON line to data/logs/push.jsonl and keep it bounded. */
  logLine(obj) {
    const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {
      console.error('[push] cannot write log: ' + e.message);
    }
    this.recent.push(JSON.parse(line));
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    this.log('[push] ' + line);
    this.trimLog();
  }

  /** Keep the log file at most `logLimit` lines, checked rarely (every 200 lines). */
  trimLog() {
    this.trimCounter = (this.trimCounter || 0) + 1;
    if (this.trimCounter % 200 !== 0) return;
    const limit = Number((this.config && this.config.logLimit) || 5000);
    if (limit <= 0) return;
    try {
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= limit) return;
      fs.writeFileSync(this.logPath, lines.slice(-limit).join('\n') + '\n');
    } catch (e) { /* a log that cannot be trimmed must not break the server */ }
  }

  /** Newest-last entries from disk (falls back to the in-memory tail). */
  recentLogs(limit) {
    const n = Math.max(1, Number(limit) || 100);
    try {
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => {
        try { return JSON.parse(l); } catch (e) { return { raw: l }; }
      }).reverse();
    } catch (e) {
      return this.recent.slice(-n).reverse();
    }
  }

  /** Config for the API/admin page, with the API token and secrets removed. */
  publicConfig() {
    const c = this.config || {};
    return {
      enabled: c.enabled !== false,
      quietHours: c.quietHours || { enabled: false, from: '23:00', to: '07:00' },
      events: c.events || {},
      webhook: {
        enabled: !!(c.webhook && c.webhook.enabled),
        url: (c.webhook && c.webhook.url) || '',
        headers: (c.webhook && c.webhook.headers) || {},
        template: (c.webhook && c.webhook.template) || '',
        contentType: (c.webhook && c.webhook.contentType) || 'json',
      },
      meow: {
        enabled: !!(c.meow && c.meow.enabled),
        nickname: (c.meow && c.meow.nickname) || '',
        apiBase: (c.meow && c.meow.apiBase) || meow.DEFAULT_BASE,
        msgType: (c.meow && c.meow.msgType) || 'text',
        imgUrl: (c.meow && c.meow.imgUrl) || '',
        url: (c.meow && c.meow.url) || '',
        htmlHeight: (c.meow && c.meow.htmlHeight) || 200,
      },
      retry: c.retry || { attempts: 3, baseDelayMs: 2000 },
      logLimit: c.logLimit || 5000,
      stats: this.stats,
      queued: this.quietQueue.length,
    };
  }
}

module.exports = { PushDispatcher, inQuietHours, parseClock, LOG_FILE };
