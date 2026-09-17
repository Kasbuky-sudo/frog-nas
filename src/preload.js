'use strict';
/**
 * The preload plan for the game's FIRST load — computed here, on the server, so
 * the browser never has to guess what the game is about to ask for.
 *
 * WHY THIS EXISTS
 *
 * A cold first load is 32.5 MB spread over 91 separate requests (see docs/
 * first-load.md for the measurement and the boot chain that produces it). On a
 * LAN that is a fraction of a second. Through the fnOS relay it is ~65 s of
 * transfer at the relay's ~512 KB/s cap, and the game's own loader fires those
 * requests in bursts that the relay throttles — so the progress bar crawls,
 * stalls, and never finishes. The second visit is instant because the responses
 * are in the HTTP cache.
 *
 * The fix is to stop leaving the download order and the retry policy to the
 * game's loader, and instead run one controlled pass over a known list:
 *
 *   blocking  — everything the client asks for before the login screen gives
 *               way to the courtyard. Held behind a gate, shown as progress.
 *   optional  — the rest of the resource tree (the 图鉴 / 家具 / 其余季节
 *               artwork). Fetched afterwards, in the background, so later
 *               screens come out of the cache instead of off the wire.
 *
 * WHY THE SPLIT IS DERIVED FROM GAME CODE, NOT GUESSED
 *
 * vendor/game/js/main.min.js drives the whole boot from two literals:
 *
 *   RES.loadConfig("default.res.json", getResRoot())      // getResRoot() = resource/China/
 *   RES.loadGroup("preload")                              // login / loading art
 *   ... then, once logged in ...
 *   loadGroups("game", ["config","system","system2","mainout","sheet"]
 *                      (+ "music_App" when GameConfig.isAPP))
 *   loadGroups("game", ["season" + WeatherModel.getSeasonKey()])
 *
 * Those are the group names used below, so `blocking` is the same set the
 * client would request anyway — nothing extra is pulled forward.
 *
 * The seasonal group is the one piece of state the server owns: the offline
 * engine pushes `weather_load` before the client loads its seasonal assets, and
 * the key is `season + "" + hours_type`. `seasonKey()` below is the engine's
 * own rule, copied verbatim from vendor/game/__offline-engine.js so the plan
 * names the group the client will actually ask for.
 *
 * AN .eab IS THE UNIT OF DOWNLOAD, NOT THE ~6900 RESOURCES
 *
 * default.res.json lists 4558 resources, but 692 of them are `eab_asset` types:
 * entries *inside* a packed bundle, with a shared placeholder url (`preload_eab`
 * and friends). They cost zero requests. The real transfer unit is the `eab`
 * resource (eab/preload.eab, …) plus the loose files that are not bundled —
 * notably the 18 sheet/*.png atlases, which are 20.3 MB of the 32.5 MB blocking
 * set. Sizes below come from stat() on the files that will actually be sent,
 * so `blockingBytes` is a real upper bound on the transfer, not an estimate.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Groups the client loads before it will show the courtyard. Taken from the
 * two `loadGroups` call sites in main.min.js (see the file header).
 */
const BOOT_GROUPS = ['preload', 'config', 'system', 'system2', 'mainout', 'sheet', 'music_App'];

/**
 * Download order for everything else. Seasonal bundles come first: if the
 * clock crossed an hours boundary between planning and play, the *right* season
 * bundle is the one file that matters, and it would otherwise be last in a
 * 225 MB queue. The rest is ordered roughly "things the player meets early
 * first" — the exact order only affects how quickly a given screen warms up.
 */
const OPTIONAL_GROUP_ORDER = [
  'season', 'first', 'second', 'reward', 'guide', 'ranking', 'visitor',
  'mainin', 'system', 'animation', 'furniture', 'sheet', 'image', 'picture', 'config',
];

/**
 * The engine's own season rule, copied from __offline-engine.js.
 *
 * It reads LOCAL clock fields on purpose (the engine's comment: a UTC+8 player
 * got the night courtyard in the afternoon when these were read from UTC), and
 * the server's local time is the same clock the engine runs on — both are
 * `new Date(epoch * 1000)` in this process. `weather_load` is pushed before the
 * client loads its seasonal assets, so planning with the same rule at the same
 * moment names the group the client will request.
 *
 * @returns {string} the resource group suffix, e.g. "31" for autumn/day
 */
function seasonKey(date) {
  const d = date || new Date();
  const m = d.getMonth() + 1;
  const season = (m >= 3 && m <= 5) ? 1     // spring
    : (m >= 6 && m <= 8) ? 2                // summer
      : (m >= 9 && m <= 11) ? 3             // autumn
        : 4;                                // winter
  const h = d.getHours();
  const hours = (h >= 6 && h < 18) ? 1     // day
    : (h >= 18 && h < 21) ? 2              // evening
      : (h >= 21) ? 3                      // night
        : 4;                               // late night (0..5)
  return String(season) + String(hours);
}

/** The `season<key>` group the client will load right now. */
function seasonGroup(date) { return 'season' + seasonKey(date); }

class PreloadPlanner {
  /**
   * @param {object} opts
   * @param {string} opts.gameDir      vendor/game   (js/, manifest.json, version.json)
   * @param {string} opts.resourceDir  vendor/resource
   * @param {string} [opts.language]   resource language folder; index.html boots "China"
   * @param {string} [opts.version]    package version, folded into the build id
   */
  constructor(opts) {
    this.gameDir = opts.gameDir;
    this.resourceDir = opts.resourceDir;
    this.language = opts.language || 'China';
    this.version = opts.version || '0';
    this.cache = null;          // { build, plan }
  }

  get resDir() { return path.join(this.resourceDir, this.language); }

  /**
   * A fingerprint of the whole resource tree.
   *
   * vendor/game/version.json already IS a content hash of the tree: it maps
   * every resource path to its md5 (4309 entries). Hashing that file therefore
   * gives a build id that changes exactly when the shipped assets change —
   * which is what the client's resume ledger is keyed on, so a package swap
   * discards the old progress instead of trusting it.
   */
  build() {
    const vfile = path.join(this.gameDir, 'version.json');
    let raw = '';
    try { raw = fs.readFileSync(vfile); } catch (e) { /* absent: fall back to a mtime scan */ }
    const h = crypto.createHash('sha1');
    if (raw.length) {
      h.update(raw);
    } else {
      // No version.json: use the resource tree's newest mtime + total size.
      let newest = 0; let total = 0;
      const walk = (dir) => {
        let names;
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        for (const n of names) {
          const p = path.join(dir, n);
          let st;
          try { st = fs.statSync(p); } catch (e) { continue; }
          if (st.isDirectory()) walk(p);
          else { newest = Math.max(newest, st.mtimeMs); total += st.size; }
        }
      };
      walk(this.resDir);
      h.update(this.language + '|' + newest + '|' + total);
    }
    return this.version + '-' + h.digest('hex').slice(0, 12);
  }

  /** Parse the two manifests the plan is built from. Throws on a broken tree. */
  readConfigs() {
    const resConfig = path.join(this.resDir, 'default.res.json');
    const res = JSON.parse(fs.readFileSync(resConfig, 'utf8'));

    const byName = new Map();
    for (const r of res.resources || []) {
      if (!byName.has(r.name)) byName.set(r.name, r);   // first wins, as Egret does
    }
    const groups = new Map();
    for (const g of res.groups || []) {
      groups.set(g.name, String(g.keys || '').split(',').filter(Boolean));
    }

    // launcher.js: list = manifest.initial.concat(manifest.game), each prefixed
    // with window.cdn (empty in this build) and appended as a <script src>.
    let js = [];
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(this.gameDir, 'manifest.json'), 'utf8'));
      js = (mf.initial || []).concat(mf.game || []);
    } catch (e) {
      // A missing manifest.json does not stop the game from booting from
      // index.html's own script tags, so treat it as "no known js" rather than
      // failing the whole plan.
      js = [];
    }

    return { res, byName, groups, js };
  }

  /**
   * Turn a resource entry into the file the client will actually download.
   *
   * @returns {{url: string, file: string}|null}
   */
  fileFor(entry, groupName) {
    if (!entry) return null;
    const type = entry.type;
    let url;
    if (type === 'eab_asset') {
      // `preload_eab` -> eab/preload.eab. The placeholder is shared by every
      // asset inside the bundle; the bundle itself is what goes over the wire.
      const u = String(entry.url || '');
      if (!u.endsWith('_eab')) return null;            // defensive: not a bundle name
      url = 'resource/' + this.language + '/eab/' + u.slice(0, -4) + '.eab';
    } else {
      const u = String(entry.url || '');
      if (!u) return null;
      url = u.indexOf('resource/') === 0 ? u : 'resource/' + this.language + '/' + u;
    }
    // One bundle can be named by many eab_asset entries; the caller de-duplicates.
    const file = url.indexOf('resource/' + this.language + '/') === 0
      ? path.join(this.resDir, url.slice(('resource/' + this.language + '/').length))
      : path.join(this.gameDir, url);
    return { url, file };
  }

  /**
   * Build (and memoise) the plan.
   * @returns {object} see the class doc for the shape
   */
  plan() {
    const build = this.build();
    // The seasonal group is a function of the clock, not of the tree, so it has
    // to take part in the cache key too: a server that has been up since 17:00
    // would otherwise keep handing out season31 after 18:00, and the client's
    // own seasonal bundle would not be in `blocking` at all.
    const season = seasonGroup(new Date());
    if (this.cache && this.cache.build === build && this.cache.season === season) {
      return this.cache.plan;
    }

    const { res, byName, groups, js } = this.readConfigs();

    // URL -> source file, for everything that is actually a file on disk.
    const seen = new Map();
    const add = (url, file) => { if (url && !seen.has(url)) seen.set(url, file); };

    for (const u of js) add('js/' + String(u).replace(/^js\//, ''), path.join(this.gameDir, u));

    // Egret's own config: RES.loadConfig("default.res.json", "resource/China/")
    // is the very first thing the engine asks for once the scripts have run, and
    // every group below is resolved out of it. It is not a `resources` entry, so
    // the sweep at the end of this method cannot find it — without this line it
    // would be the one blocking file the plan misses.
    const resConfig = 'resource/' + this.language + '/default.res.json';
    add(resConfig, path.join(this.resDir, 'default.res.json'));

    const byGroup = new Map();               // group -> [url]
    for (const [gname, keys] of groups) {
      const urls = [];
      for (const k of keys) {
        const f = this.fileFor(byName.get(k), gname);
        if (!f) continue;
        add(f.url, f.file);
        if (urls.indexOf(f.url) === -1) urls.push(f.url);
      }
      byGroup.set(gname, urls);
    }

    // Not every shipped file is named by a group. The client still reaches some
    // of them: `RES.createGroup("furniture_home", …)` (main.min.js) builds a
    // group at runtime out of furniture resource names. A file that no static
    // group names would be fetched on demand and would not be in the plan, so
    // the whole resource list is swept in here and anything unseen appended
    // last — the tail of the queue, where it costs nothing until everything
    // reachable has already been cached.
    const grouped = new Set();
    for (const urls of byGroup.values()) for (const u of urls) grouped.add(u);
    const ungrouped = [];
    for (const [url] of seen) if (!grouped.has(url)) ungrouped.push(url);
    for (const r of res.resources || []) {
      const f = this.fileFor(r, null);
      if (!f || seen.has(f.url)) continue;
      let size = 0;
      try { size = fs.statSync(f.file).size; } catch (e) { continue; }
      seen.set(f.url, f.file);
      ungrouped.push(f.url);
    }

    const blocking = [];
    const optional = [];
    const push = (list, url) => {
      // This one is re-served per request: the server rewrites its WS endpoint
      // (see StaticServer#serveGameConfig) and sends `Cache-Control: no-cache`,
      // so a preloaded copy could never be reused. Warming it would only add a
      // request that is guaranteed to be thrown away.
      if (url === 'resource/' + this.language + '/config/gameConfig.json') return;
      const file = seen.get(url);
      if (!file) return;
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { return; }   // not shipped: skip
      list.push({ url, size });
    };

    const inBlocking = new Set();
    for (const u of js) {
      const url = 'js/' + String(u).replace(/^js\//, '');
      if (seen.has(url) && !inBlocking.has(url)) { inBlocking.add(url); push(blocking, url); }
    }
    // Right after the scripts: the engine cannot resolve a single group before
    // it has this file, so it belongs at the head of the queue behind them.
    if (seen.has(resConfig) && !inBlocking.has(resConfig)) {
      inBlocking.add(resConfig);
      push(blocking, resConfig);
    }
    for (const g of BOOT_GROUPS) {
      for (const url of byGroup.get(g) || []) {
        if (!inBlocking.has(url)) { inBlocking.add(url); push(blocking, url); }
      }
    }
    for (const url of byGroup.get(season) || []) {
      if (!inBlocking.has(url)) { inBlocking.add(url); push(blocking, url); }
    }

    // Everything else, in the order OPTIONAL_GROUP_ORDER lays out.
    const takenOptional = new Set();
    const addOptional = (url) => {
      if (inBlocking.has(url) || takenOptional.has(url)) return;
      takenOptional.add(url);
      push(optional, url);
    };
    for (const name of OPTIONAL_GROUP_ORDER) {
      if (name === 'season') {
        // Every season bundle except the one already in `blocking`.
        for (const [gname, urls] of byGroup) {
          if (gname.indexOf('season') !== 0) continue;
          for (const url of urls) addOptional(url);
        }
      } else {
        for (const url of byGroup.get(name) || []) addOptional(url);
      }
    }
    for (const [gname, urls] of byGroup) {
      if (OPTIONAL_GROUP_ORDER.indexOf(gname) !== -1) continue;
      for (const url of urls) addOptional(url);
    }
    for (const url of ungrouped) addOptional(url);

    const sum = (list) => list.reduce((n, f) => n + f.size, 0);
    const plan = {
      build,
      language: this.language,
      season,
      generatedAt: new Date().toISOString(),
      // The client indexes this single concatenated list with one bitmap, so
      // `blockingCount` is the only thing marking where the gate stops.
      blockingCount: blocking.length,
      blocking,
      optional,
      bytes: {
        blocking: sum(blocking),
        optional: sum(optional),
        total: sum(blocking) + sum(optional),
      },
    };
    this.cache = { build, season, plan };
    return plan;
  }
}

module.exports = { PreloadPlanner, seasonKey, seasonGroup, BOOT_GROUPS };
