'use strict';
/**
 * The first-load preloader, injected into index.html at serve time.
 *
 * WHY A PRELOADER AT ALL
 *
 * A cold first load is 32.5 MB over 91 requests (computed server side — see
 * src/preload.js and docs/first-load.md). On a LAN that is a blink. Through the
 * fnOS relay it is ~65 s at the relay's ~512 KB/s cap, and the game's own loader
 * fires those requests in bursts that the relay throttles. That matches the
 * reported symptom exactly: the bar crawls, the transfer dies part-way, and the
 * NAS looks like it "stopped sending" — while every server log stays clean,
 * because nothing failed, it was merely starved of bandwidth.
 *
 * A second visit is instant, because the responses are in the HTTP cache. That
 * was demonstrated by accident: opening the app in a second tab while the first
 * was still loading let the first one finish, since both tabs share the cache.
 *
 * So the entire problem is the COLD path, and the fix is to take that one pass
 * out of the game's hands:
 *
 *   1. ask the server what the game is about to want   (GET /__preload/manifest)
 *   2. download it with a policy that survives a throttled link
 *   3. hold the game until it is done, showing honest progress
 *
 * WHY THIS IS A SHIM AND NOT AN EDIT TO vendor/
 *
 * The brief's §0 rule: files under vendor/ stay byte-identical, so every
 * behaviour change is a serve-time rewrite in src/static.js. This shim is
 * injected as the FIRST thing in <head>, so it installs before
 * __offline-engine.js and __probe.js are even parsed.
 *
 * WHY THE GATE HOOKS XMLHttpRequest
 *
 * The boot chain is: index.html -> launcher.js (a <script> tag) -> launcher.js
 * does `httpRequest('manifest.json?v=' + Math.random())`  <- XHR -> and only
 * then does it append one <script> tag per engine file. That single XHR is the
 * whole game's choke point: hold it and nothing else starts. It is also already
 * a seam this project patches (XHR_TIMEOUT_SHIM fills in Egret's `timeout = 0`),
 * so no new interception surface is introduced.
 *
 * THE POLICY THAT MATTERS (the "治病" part — not merely a longer timeout)
 *
 *   - concurrency 2, not the browser's default 6. A rate-limited relay starves
 *     six parallel flows; two pipelines make steady progress and keep the bar
 *     moving.
 *   - a stall is DETECTED, not waited out: the body is read through a stream
 *     reader and any 20 s with no new byte aborts that request. That is what
 *     separates a half-open connection from a slow one — with no timeout an XHR
 *     waits forever, which is precisely why 1.0.2 had to give Egret a default
 *     timeout in the first place.
 *   - a stalled file is RETRIED from scratch, up to 5 times, with backoff. The
 *     largest single file is a 4.14 MB atlas, ~8 s at the relay cap, so a retry
 *     is cheap and bounded.
 *   - progress is a RESUME LEDGER in localStorage, one bit per file, keyed by
 *     the server's build id. Close the page at 60% and the next visit starts at
 *     60% instead of zero. This is the piece that makes a long cold load
 *     actually finishable over a bad link.
 *   - nothing here can trap the player: every failure path opens the gate, a
 *     hard cap opens it, a 30 s stall reveals a skip button, and if the manifest
 *     cannot be read the gate is never armed at all.
 *
 * WHAT IT ALSO DOES: OPTIONAL BACKGROUND FILL
 *
 * Once the blocking set is in, the remaining ~225 MB of 图鉴 / 家具 / 其余季节
 * artwork is fetched at concurrency 1, in the background, yielding whenever the
 * game has a request of its own in flight. It resumes across visits, so
 * "之后就不用加载了" eventually covers screens the player has not opened yet.
 * Opt out with `?nopreload=1` or `localStorage.__frog_preload_off = '1'`.
 */

/** Body of the injected <script>. `'__BUILD__'` is replaced with the build id. */
const SHIM_BODY = `
(function () {
  'use strict';
  if (window.__frogPreload) return;              /* injected twice: keep the first */

  /* ---- tuning -------------------------------------------------------------- */
  var BUILD          = '__BUILD__';
  var MANIFEST_URL   = '/__preload/manifest';
  var STORE_KEY      = '__frog_preload_v1';
  var OPT_OUT_KEY    = '__frog_preload_off';
  var CONCURRENCY    = 2;        /* see the header: 6 starves a throttled relay */
  var BG_CONCURRENCY = 1;        /* background fill must never crowd the game */
  var STALL_MS       = 20000;    /* no new byte for this long -> abort + retry */
  var MAX_TRIES      = 5;
  var DECIDE_MS      = 5000;     /* manifest must answer within this or we open */
  var HARD_CAP_MS    = 8 * 60 * 1000;
  var SKIP_AFTER_MS  = 30000;    /* a skip button, so a bad link never traps */

  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  var XHR = window.XMLHttpRequest;
  var _open = XHR && XHR.prototype.open;
  var _send = XHR && XHR.prototype.send;
  var _abort = XHR && XHR.prototype.abort;
  /* Without fetch + streams there is no way to notice a stall or to run a
     controlled queue, so the shim stands down completely and the game boots
     exactly as it did before. Failing open is the whole safety story here. */
  if (!_fetch || !XHR || !_open || !_send) return;

  var st = {
    build: BUILD,
    /* armed: the gate is holding game requests. decided: we know whether a
       preload is needed. done: the gate is open, for whatever reason. */
    armed: false, decided: false, done: false, reason: null,
    phase: 'idle', skipped: false,
    count: 0, doneCount: 0, fetched: 0, failed: 0,
    loaded: 0, totalBytes: 0, blockingBytes: 0, optionalBytes: 0,
    gateHeld: 0, inflight: 0, lastError: null, lastByte: 0,
    t0: Date.now()
  };
  window.__frogPreload = st;

  /* ---- a line or two to the server, so a slow first load on someone's phone
     is diagnosable afterwards instead of guessed at --------------------------- */
  function log(msg) {
    try { console.log('[preload] ' + msg); } catch (e) {}
    try {
      var line = '[preload] ' + msg + '\\n';
      if (navigator.sendBeacon) navigator.sendBeacon('/__log', line);
      else _fetch('/__log', { method: 'POST', body: line, keepalive: true });
    } catch (e) { /* logging must never affect the load */ }
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ---- the gate ------------------------------------------------------------ */
  var held = [];

  function releaseAll() {
    var q = held; held = [];
    /* gateHeld is drained by the queued closures themselves, one decrement
       each -- zeroing it here as well would drive the counter negative and make
       it useless as a diagnostic. */
    for (var i = 0; i < q.length; i++) {
      try { q[i](); } catch (e) { /* one bad request must not strand the rest */ }
    }
  }

  /** Open the gate permanently and say why. Idempotent. */
  function finish(reason) {
    if (st.done) return;
    st.done = true;
    st.armed = false;
    st.reason = reason || 'ok';
    releaseAll();
    render();
    log('gate open (' + st.reason + ') at ' + (Date.now() - st.t0) + 'ms');
  }

  XHR.prototype.open = function (method, url) {
    /* Recorded only for diagnostics/tests: URLs are never rewritten, because
       the preloader must fetch exactly the URL the game will ask for — that
       identity is what makes the warm pass a pure cache hit. */
    try { this.__frog = { m: method, u: String(url) }; } catch (e) {}
    return _open.apply(this, arguments);
  };

  XHR.prototype.send = function (body) {
    var xhr = this;
    if (st.armed && !st.done && !xhr.__frogReleased && !xhr.__frogCancelled) {
      st.gateHeld++;
      held.push(function () {
        if (xhr.__frogCancelled) { st.gateHeld--; return; }
        xhr.__frogReleased = true;
        st.gateHeld--;
        /* Re-enter through the prototype so the OTHER patches installed after
           this one (XHR_TIMEOUT_SHIM) still run — calling the saved _send here
           would silently skip Egret's default timeout and undo 1.0.2's fix. */
        XHR.prototype.send.call(xhr, body);
      });
      return undefined;
    }
    if (!xhr.__frogCounted) {
      xhr.__frogCounted = true;
      xhr.addEventListener('loadend', function () {
        if (!xhr.__frogCounted) return;
        xhr.__frogCounted = false;
        st.inflight--;
      }, false);
    }
    xhr.__frogCounted = true;
    st.inflight++;
    return _send.call(xhr, body);
  };

  if (_abort) {
    XHR.prototype.abort = function () {
      this.__frogCancelled = true;      /* a held request must not fire later */
      return _abort.apply(this, arguments);
    };
  }

  /* ---- the resume ledger: one bit per file, keyed by the server's build id -- */
  function Ledger(bits) { this.bits = bits || new Uint8Array(0); }
  Ledger.prototype.has = function (i) {
    return (this.bits[i >> 3] & (1 << (i & 7))) !== 0;
  };
  Ledger.prototype.set = function (i) {
    this.bits[i >> 3] |= (1 << (i & 7));
  };

  function loadLedger(build, n) {
    var blank = function () { return new Ledger(new Uint8Array((n + 7) >> 3)); };
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return blank();
      var o = JSON.parse(raw);
      /* A different build means different files: start over rather than trust
         bit positions that no longer mean the same thing. */
      if (!o || o.b !== build || typeof o.m !== 'string') return blank();
      var bin = window.atob(o.m);
      var bits = new Uint8Array((n + 7) >> 3);
      for (var i = 0; i < bin.length && i < bits.length; i++) bits[i] = bin.charCodeAt(i);
      return new Ledger(bits);
    } catch (e) { return blank(); }
  }

  function saveLedger(build, ledger) {
    try {
      var bits = ledger.bits, s = '';
      for (var i = 0; i < bits.length; i++) s += String.fromCharCode(bits[i]);
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ b: build, m: window.btoa(s) }));
    } catch (e) { /* private mode / quota: the ledger is an optimisation only */ }
  }

  /* ---- one file, with a stall detector and bounded retries ------------------ */
  function fetchOne(url) {
    var tries = 0;
    function attempt() {
      tries++;
      var ctrl = null;
      try { ctrl = new AbortController(); } catch (e) { /* no abort: no stall guard */ }
      var last = Date.now();
      var timer = setInterval(function () {
        if (ctrl && Date.now() - last > STALL_MS) {
          try { ctrl.abort(); } catch (e) {}
        }
      }, 2000);

      var opts = { credentials: 'same-origin' };
      if (ctrl) opts.signal = ctrl.signal;

      return _fetch(url, opts).then(function (res) {
        if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
        /* Read the body through the stream so byte progress is visible — that
           is what makes a stall detectable. Fully consuming it is also what
           commits the response to the HTTP cache for the game to reuse. */
        if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer();
        var reader = res.body.getReader();
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) return undefined;
            last = Date.now();
            st.lastByte = last;
            return pump();
          });
        };
        return pump();
      }).then(function () {
        clearInterval(timer);
      }, function (err) {
        clearInterval(timer);
        /* A 404 will still be a 404 on the fifth try, and five round trips over
           a throttled relay is real time. Anything else a 4xx says about the
           REQUEST is equally permanent; 408 and 429 are the two that are not.
           Only genuinely transient failures are worth retrying. */
        var permanent = err && err.status >= 400 && err.status < 500
          && err.status !== 408 && err.status !== 429;
        if (!permanent && tries < MAX_TRIES) return wait(300 * tries).then(attempt);
        throw err;
      });
    }
    return attempt();
  }

  /* ---- the queue: fixed concurrency, promise-chained so the stack stays flat
     even when a resumed ledger skips thousands of already-done entries -------- */
  function waitWhile(fn) {
    if (!fn()) return Promise.resolve();
    return wait(700).then(function () { return waitWhile(fn); });
  }

  function runQueue(list, ledger, concurrency, onEach, shouldPause, onDone) {
    var idx = 0;

    function worker() {
      return Promise.resolve().then(function next() {
        var k;
        for (;;) {
          k = idx++;
          if (k >= list.length) return undefined;
          if (!ledger.has(k)) break;                 /* finished on an earlier visit */
        }
        var p = shouldPause ? waitWhile(shouldPause) : Promise.resolve();
        return p.then(function () {
          return fetchOne(list[k].url);
        }).then(function () {
          ledger.set(k);
          st.fetched++;
          st.doneCount++;
          st.loaded += list[k].size || 0;
          if (onEach) onEach(k, null);
        }, function (err) {
          st.failed++;
          st.lastError = String((err && err.message) || err);
          if (st.lastError.indexOf('HTTP 404') === 0) {
            /* Listed by the plan but absent from the tree: retrying can never
               help, so mark it done and move on. */
            ledger.set(k);
          }
          if (onEach) onEach(k, err);
        }).then(next);
      });
    }

    var ws = [];
    for (var w = 0; w < concurrency; w++) ws.push(worker());
    return Promise.all(ws).then(function () { if (onDone) onDone(); });
  }

  /* ---- progress UI, inside the rights notice ------------------------------
     The notice is already mandatory on every launch and already covers the
     stage, so it is the one place that can hold the player without inventing a
     second overlay or fighting its z-index (2147483647). Disabling the button
     until the blocking set is in is precisely "传完再进去游戏". ----------------- */
  var uiReady = false;
  var okText = null;

  function mountUI() {
    var notice = document.getElementById('__notice');
    var ok = document.getElementById('__notice_ok');
    if (!notice || !ok) return false;
    if (okText === null) okText = ok.textContent;
    if (document.getElementById('__frog_preload')) { uiReady = true; return true; }

    var box = document.createElement('div');
    box.id = '__frog_preload';
    box.setAttribute('style',
      'margin:26px 0 0;padding:14px 16px;border:1px solid rgba(255,255,255,.3);'
      + 'border-radius:6px;background:rgba(255,255,255,.06);text-align:left');
    box.innerHTML =
      '<div id="__frog_preload_msg" style="font-size:13px;line-height:1.65;margin:0 0 10px"></div>'
      + '<div style="height:6px;border-radius:3px;background:rgba(255,255,255,.18);overflow:hidden">'
      + '<div id="__frog_preload_bar" style="height:100%;width:0;background:#fff;transition:width .25s"></div>'
      + '</div>'
      + '<div id="__frog_preload_sub" style="font-size:11px;opacity:.6;margin:8px 0 0"></div>'
      + '<button id="__frog_preload_skip" type="button" style="display:none;margin:14px 0 0;'
      + 'padding:7px 14px;font-size:12px;font-family:inherit;color:#ccc;background:transparent;'
      + 'border:1px solid rgba(255,255,255,.3);border-radius:4px;cursor:pointer">跳过预载，直接进入</button>';
    var wrap = notice.querySelector('.__nwrap') || notice;
    wrap.insertBefore(box, ok);

    document.getElementById('__frog_preload_skip').addEventListener('click', function () {
      st.skipped = true;
      log('skipped by the player at ' + st.doneCount + '/' + st.count);
      finish('skipped');
    }, false);

    uiReady = true;
    return true;
  }

  function fmtMB(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

  function render() {
    if (!uiReady) return;
    var box = document.getElementById('__frog_preload');
    var ok = document.getElementById('__notice_ok');
    if (!box || !ok) return;

    if (st.done) {
      box.style.display = 'none';
      ok.disabled = false;
      ok.style.opacity = '';
      if (okText !== null) ok.textContent = okText;
      return;
    }

    ok.disabled = true;
    ok.style.opacity = '.45';
    ok.textContent = '预载中…';

    var pct = st.totalBytes ? Math.min(99, Math.round(st.loaded / st.totalBytes * 100)) : 0;
    var bar = document.getElementById('__frog_preload_bar');
    if (bar) bar.style.width = pct + '%';

    var msg = document.getElementById('__frog_preload_msg');
    if (msg) {
      msg.textContent = '首次进入需要把游戏画面存到本机（' + fmtMB(st.totalBytes)
        + '），完成之后再打开就不用再下载了。';
    }

    var sub = document.getElementById('__frog_preload_sub');
    if (sub) {
      var elapsed = Date.now() - st.t0;
      var rate = elapsed > 1500 ? st.loaded / elapsed * 1000 : 0;      /* bytes/s */
      var left = (rate > 4096) ? Math.max(1, Math.round((st.totalBytes - st.loaded) / rate)) : 0;
      var parts = [fmtMB(st.loaded) + ' / ' + fmtMB(st.totalBytes), pct + '%'];
      if (left) parts.push(left >= 60 ? ('约 ' + Math.ceil(left / 60) + ' 分钟') : ('约 ' + left + ' 秒'));
      parts.push(st.doneCount + '/' + st.count + ' 个文件');
      if (st.failed) parts.push('已重试 ' + st.failed + ' 次');
      sub.textContent = parts.join(' · ');
    }

    var skip = document.getElementById('__frog_preload_skip');
    if (skip) skip.style.display = (Date.now() - st.t0 > SKIP_AFTER_MS) ? 'block' : 'none';
  }

  var renderTimer = setInterval(function () {
    if (st.done) { clearInterval(renderTimer); return; }
    if (!uiReady && st.phase === 'blocking') mountUI();
    if (uiReady) render();
  }, 400);

  /* ---- boot ---------------------------------------------------------------- */
  if (/(?:^|[?&])nopreload=1(?:&|$)/.test(window.location.search)) return;

  /* A persistent per-browser opt-out has to cover the BLOCKING pass too, not
     just the background fill — otherwise "off" would still mean staring at the
     progress bar. Read it before arming so the gate is never even closed. */
  var optOut = false;
  try { optOut = window.localStorage.getItem(OPT_OUT_KEY) === '1'; } catch (e) {}

  if (optOut) {
    st.phase = 'opt-out';
    st.done = true;
    st.reason = 'opt-out';
    log('opted out via localStorage');
    return;
  }

  /* Arm the gate synchronously, before any game script can run. Whether it
     STAYS armed is decided one round trip later; arming first is what makes the
     outcome deterministic instead of a race with launcher.js's first XHR. */
  st.armed = true;

  var decided = false;
  function decide() {
    if (decided) return;
    decided = true;
    st.decided = true;
    clearTimeout(decideTimer);
  }

  var decideTimer = setTimeout(function () {
    /* The manifest did not answer in time. Open the gate RIGHT NOW — a slow
       metadata request must never cost the player the game, and simply
       clearing st.armed would strand every request already queued in held
       until the hard cap. finish() releases them and re-enables the button.
       Warming may still happen later if the manifest eventually arrives: the
       plan handler checks st.done and degrades to background-only. */
    if (decided) return;
    decide();
    st.phase = 'manifest-timeout';
    finish('manifest-timeout');
  }, DECIDE_MS);

  /* ---- optional fill: the rest of the tree, one file at a time -------------- */
  function startBackground(plan, all, ledger) {
    decide();
    if (st.bgStarted) return;
    var outstanding = 0;
    for (var i = 0; i < all.length; i++) if (!ledger.has(i)) outstanding++;
    if (!outstanding) { log('nothing left to warm'); return; }
    st.bgStarted = true;

    st.phase = 'optional';
    st.bgTotal = outstanding;

    /* Yield to the game: pause whenever one of its own requests is in flight,
       and whenever the page is not visible. On a throttled link the player's
       next tap must always win over speculative warming. */
    var shouldPause = function () {
      return st.inflight > 0 || document.hidden === true;
    };

    /* Wait until the player is actually in the game: warming resources while
       the notice is still up would compete with the blocking pass. */
    var kick = setInterval(function () {
      if (document.getElementById('__notice')) return;
      clearInterval(kick);
      var n = 0;
      runQueue(all, ledger, BG_CONCURRENCY, function (k, err) {
        n++;
        if (err) log('warm fail ' + all[k].url + ' :: ' + err.message);
        if (n % 25 === 0) { saveLedger(plan.build, ledger); log('warming ' + n + '/' + outstanding); }
      }, shouldPause, function () {
        saveLedger(plan.build, ledger);
        log('warming complete (' + n + ' files)');
      });
    }, 2000);
  }

  /* ---- the plan ------------------------------------------------------------ */
  _fetch(MANIFEST_URL, { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (plan) {
    if (!plan || !plan.blocking || !plan.blocking.length) throw new Error('empty plan');
    decide();

    var all = plan.blocking.concat(plan.optional);
    var ledger = loadLedger(plan.build, all.length);

    log('plan build=' + plan.build + ' season=' + plan.season
      + ' blocking=' + plan.blocking.length + '/' + fmtMB(plan.bytes.blocking)
      + ' optional=' + plan.optional.length + '/' + fmtMB(plan.bytes.optional)
      + ' cores=' + (navigator.hardwareConcurrency || '?')
      + ' ua=' + navigator.userAgent);

    /* The manifest lost the race with DECIDE_MS: the player is already in the
       game. Warming the cache is still worth doing for the NEXT visit, but it
       must never gate, and concurrency 1 keeps it behind the player's own
       requests (shouldPause watches st.inflight). */
    if (st.done) {
      log('manifest arrived late (' + (Date.now() - st.t0) + 'ms); warming only');
      startBackground(plan, all, ledger);
      return;
    }

    var todo = 0;
    for (var i = 0; i < plan.blocking.length; i++) if (!ledger.has(i)) todo++;

    st.count = todo;
    st.totalBytes = 0;
    for (var j = 0; j < plan.blocking.length; j++) {
      if (!ledger.has(j)) st.totalBytes += plan.blocking[j].size || 0;
    }
    st.blockingBytes = plan.bytes.blocking;
    st.optionalBytes = plan.bytes.optional;

    if (!todo) {
      /* Warm cache: everything was stored on an earlier visit. The notice is
         left completely untouched, so the player sees no difference at all. */
      st.phase = 'warm';
      finish('warm');
      startBackground(plan, all, ledger);
      return;
    }

    st.phase = 'blocking';
    mountUI();
    render();

    /* Progressive ledger saves: cheap, and they are the whole point of the
       resume. Batched rather than per file so a 3800-file background fill does
       not rewrite localStorage 3800 times. */
    var lastSave = 0;
    function maybeSave() {
      var now = Date.now();
      if (now - lastSave < 3000) return;
      lastSave = now;
      saveLedger(plan.build, ledger);
    }

    runQueue(plan.blocking, ledger, CONCURRENCY, function (k, err) {
      maybeSave();
      render();
      if (err) log('fail ' + plan.blocking[k].url + ' :: ' + err.message);
    }, null, function () {
      saveLedger(plan.build, ledger);
      var elapsed = Date.now() - st.t0;
      var rate = elapsed > 0 ? (st.loaded / 1024 / (elapsed / 1000)) : 0;
      log('blocking done in ' + elapsed + 'ms fetched=' + st.fetched
        + ' failed=' + st.failed + ' bytes=' + st.loaded
        + ' rate=' + rate.toFixed(0) + 'KB/s');
      st.phase = 'entered';
      /* Any file that exhausted its retries stays unset in the ledger, so the
         next visit tries again; the gate opens regardless and the game's own
         loader picks up the slack. */
      finish(st.failed ? 'partial' : 'ok');
      startBackground(plan, all, ledger);
    });
  }).catch(function (e) {
    decide();
    st.armed = false;
    st.lastError = String((e && e.message) || e);
    /* If the timeout already opened the gate, leave that phase/reason alone:
       it is the one the player actually experienced. */
    if (!st.done) st.phase = 'manifest-failed';
    log('manifest failed: ' + st.lastError + '; the game boots normally');
    finish('manifest');
  });

  setTimeout(function () {
    if (!st.done) { log('hard cap reached at ' + st.doneCount + '/' + st.count); finish('hard-cap'); }
  }, HARD_CAP_MS);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (uiReady || st.done) return;
      if (st.phase === 'blocking' && mountUI()) render();
    }, false);
  }
})();
`;

/**
 * @param {string} build  the server's build id, embedded so the shim can compare
 *                        it with the stored ledger without a second round trip
 * @returns {string} an inline <script> element
 */
function preloadShim(build) {
  const body = SHIM_BODY.replace("'__BUILD__'", JSON.stringify(String(build || '')));
  return '<script>' + body + '</script>';
}

module.exports = { preloadShim, SHIM_BODY };
