'use strict';
/**
 * The engine host: run vendor/game/__offline-engine.js inside a `node:vm` context
 * with a DISK-backed localStorage, so the engine's own persistence layer (which
 * was written against a browser) lands in data/save/ as real files.
 *
 * Why a vm at all: the bundle is a browser IIFE -- `(function (global) { ... })(window)`
 * -- that reads `window.localStorage`, `window.FrogNative` and `process.env`. Feeding
 * it a sandbox gives exactly those three without patching a byte of the file, and
 * keeps the game's globals out of the server's own scope.
 *
 * Save layout (the engine's own scheme, just file-backed):
 *   data/save/frog.offline.save.json                     primary save
 *   data/save/frog.offline.save__save.json.bak.json      engine's backup slot
 *   data/save/frog.offline.save__save.json.tmp.json      engine's pending slot
 *   data/save/frog.offline.save__save.json.corrupt-<ts>.json
 * The engine reads back what it wrote and keeps its own main -> backup -> mirror
 * recovery chain, so the host adds no second safety net on top (see docs/decisions.md).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SAVE_KEY = 'frog.offline.save';
const SLOT_PREFIX = SAVE_KEY + '::';

/** localStorage key -> file name. The engine's keys are all
 *  `frog.offline.save` or `frog.offline.save::<slot>`, i.e. already filename-safe;
 *  the guard is for the `.corrupt-<ts>` slots and for anything a future build adds. */
function fileForKey(dir, key) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, safe + '.json');
}

function keyForFile(name) {
  return name.replace(/\.json$/, '');
}

class DiskStorage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    /** Mirror entries in memory, keyed exactly as the engine uses them, so
     *  `key(i)`/`length` are stable even while files come and go underneath. */
    this.keys = new Set();
    this.refresh();
  }

  refresh() {
    this.keys.clear();
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith('.json')) this.keys.add(keyForFile(f));
    }
  }

  get length() { return this.keys.size; }

  key(i) {
    return Array.from(this.keys)[i] || null;
  }

  getItem(key) {
    try {
      const v = fs.readFileSync(fileForKey(this.dir, key), 'utf8');
      this.keys.add(String(key));
      return v;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[storage] read ' + key + ': ' + e.message);
      return null;
    }
  }

  setItem(key, value) {
    const file = fileForKey(this.dir, key);
    const tmp = file + '.writing';
    fs.writeFileSync(tmp, String(value));
    fs.renameSync(tmp, file);          // atomic: a crash cannot truncate a save
    this.keys.add(String(key));
  }

  removeItem(key) {
    try { fs.unlinkSync(fileForKey(this.dir, key)); } catch (e) { /* already gone */ }
    this.keys.delete(String(key));
  }

  clear() {
    for (const k of Array.from(this.keys)) this.removeItem(k);
  }
}

class EngineHost {
  /**
   * @param {object} opts
   * @param {string} opts.engineFile  absolute path to __offline-engine.js
   * @param {string} opts.saveDir     directory the localStorage files live in
   * @param {object} [opts.env]       FROG_CONFIG.env overrides (strings)
   * @param {string} [opts.savePath]  engine savePath (defaults to 'save.json')
   * @param {boolean} [opts.verbose]
   */
  constructor(opts) {
    this.engineFile = opts.engineFile;
    this.saveDir = opts.saveDir;
    this.savePath = opts.savePath || 'save.json';
    this.env = opts.env || {};
    this.verbose = opts.verbose !== false;
    this.storage = new DiskStorage(this.saveDir);
    this.engine = null;
    this.sandbox = null;
    this.startedAt = 0;
    this.lastError = null;
  }

  /** Load the bundle and create the engine. Throws if the bundle is missing --
   *  the caller decides whether that is fatal (it is, for a real server). */
  start() {
    if (!fs.existsSync(this.engineFile)) {
      throw new Error('engine bundle not found: ' + this.engineFile +
        ' (run scripts/fetch-source.js first)');
    }
    const src = fs.readFileSync(this.engineFile, 'utf8');

    const host = this;
    const sandbox = {
      // The bundle wraps itself in an IIFE taking `window`; alias everything a
      // browser global would normally be.
      localStorage: this.storage,
      FROG_CONFIG: { env: { ...this.env } },
      console: this.verbose ? console : {
        log() { }, info() { }, debug() { },
        warn: console.warn.bind(console), error: console.error.bind(console),
      },
      setTimeout, clearTimeout, setInterval, clearInterval,
      Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
      Promise, Map, Set, Symbol, parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent,
    };
    sandbox.window = sandbox;
    sandbox.global = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'offline-engine.js' });

    if (!sandbox.FrogEngine || typeof sandbox.FrogEngine.createEngine !== 'function') {
      throw new Error('engine bundle did not export FrogEngine.createEngine');
    }
    this.sandbox = sandbox;
    this.engine = sandbox.FrogEngine.createEngine({
      savePath: this.savePath,
      verbose: this.verbose,
    });
    this.startedAt = Date.now();
    this.lastError = null;
    return this;
  }

  /** Restart with a (possibly different) env. The engine is rebuilt from the
   *  save on disk, which is how an /admin env change takes effect. */
  restart(env) {
    if (env) this.env = env;
    this.engine = null;
    this.sandbox = null;
    this.storage = new DiskStorage(this.saveDir);
    return this.start();
  }

  get ready() { return !!this.engine; }

  /** @returns {{reply?: object, handled: boolean, pushes: Array}} */
  dispatch(cmd, data) {
    if (!this.engine) throw new Error('engine not started');
    return this.engine.dispatch(cmd, data || {});
  }

  /** Time-driven pushes: clover regrowth, depart/return, visitors, achievements. */
  tick() {
    if (!this.engine) return [];
    return this.engine.tick() || [];
  }

  get state() {
    if (!this.engine) throw new Error('engine not started');
    return this.engine.state;
  }

  saveInfo() { return this.engine ? this.engine.saveInfo() : null; }

  exportSave() { return this.engine.exportSave(); }

  importSave(obj) { return this.engine.importSave(obj); }

  forceSaveOverwrite() { return this.engine.forceSaveOverwrite(); }

  /** Files the engine has written, newest first. Used by /admin's log view and
   *  by the integration tests to assert the recovery slots exist. */
  saveFiles() {
    let names = [];
    try {
      names = fs.readdirSync(this.saveDir).filter((f) => f.endsWith('.json'));
    } catch (e) { return []; }
    return names.map((n) => {
      const st = fs.statSync(path.join(this.saveDir, n));
      return { name: n, size: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
  }
}

module.exports = { EngineHost, DiskStorage, SAVE_KEY, SLOT_PREFIX, fileForKey };
