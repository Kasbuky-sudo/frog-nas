'use strict';
/**
 * Copy the game source subset we actually serve from an unpacked APK into vendor/.
 *
 * The APK is an Egret H5 game inside a thin Android WebView shell. Only two trees
 * matter for serving it over HTTP:
 *
 *   assets/game/        the H5 game itself (index.html, launcher.js, js/, engine, probe)
 *   resource/China/     art + config for the China flavour (window.gameLanguage === 'China')
 *
 * Everything else in the APK (AndroidManifest.xml, classes.dex, res/, META-INF/,
 * resources.arsc, resource/ejoysdk_lua/) is the native wrapper and is NOT copied --
 * nothing we serve ever requests it, and the acceptance criteria require the image
 * to be free of the Android shell.
 *
 * The script is idempotent: rerun it after updating the source package and rebuild
 * the image. See README "源获取与更新".
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');

/** Default source: the unpacked APK used for development. */
const DEFAULT_SRC = 'D:\\Downloads\\com.frog.offline';

function parseArgs(argv) {
  const out = { src: process.env.FROG_SOURCE || DEFAULT_SRC, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src' || a === '-s') out.src = argv[++i];
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.src = a;
  }
  return out;
}

/** Files/dirs inside assets/game that are part of the Android shell, not the game. */
const EXCLUDE_GAME = new Set([]);

function copyTree(from, to, stats) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE_GAME.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst, stats);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      stats.files++;
      stats.bytes += fs.statSync(dst).size;
    }
  }
}

/** The four files the acceptance criteria require to be absent from the image. */
const SHELL_MARKERS = ['AndroidManifest.xml', 'classes.dex', 'resources.arsc'];

function findShellMarkers(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SHELL_MARKERS.includes(e.name) || e.name.startsWith('META-INF')) hits.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node scripts/fetch-source.js [--src <解包目录>] [--force]

  --src    解包后的 APK 目录（默认 ${DEFAULT_SRC}，也可用环境变量 FROG_SOURCE）
  --force  覆盖已存在的 vendor/ 内容`);
    return 0;
  }

  const src = path.resolve(args.src);
  const gameSrc = path.join(src, 'assets', 'game');
  const resSrc = path.join(src, 'resource', 'China');

  for (const [label, p] of [['assets/game', gameSrc], ['resource/China', resSrc]]) {
    if (!fs.existsSync(p)) {
      console.error(`[fetch-source] 找不到 ${label}: ${p}`);
      console.error(`[fetch-source] 请确认 --src 指向解包后的 APK 目录（含 assets/ 与 resource/）。`);
      return 2;
    }
  }

  const gameDst = path.join(VENDOR, 'game');
  const resDst = path.join(VENDOR, 'resource', 'China');

  for (const d of [gameDst, resDst]) {
    if (fs.existsSync(d)) {
      if (!args.force) {
        // Still refresh: the whole point is "rerun after updating the source".
        // --force only widens this to a full delete, which matters when the new
        // source REMOVED files (a stale extra file would otherwise be served).
        console.log(`[fetch-source] 已存在，增量覆盖: ${path.relative(ROOT, d)}`);
      } else {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  const stats = { files: 0, bytes: 0 };
  console.log('[fetch-source] 复制 assets/game ->', path.relative(ROOT, gameDst));
  copyTree(gameSrc, gameDst, stats);
  const afterGame = { ...stats };

  console.log('[fetch-source] 复制 resource/China ->', path.relative(ROOT, resDst));
  copyTree(resSrc, resDst, stats);

  // The one file we rewrite at response time -- keep a pristine copy so the
  // rewrite is always derived from the original rather than from our own output.
  const cfgSrc = path.join(resSrc, 'config', 'gameConfig.json');
  if (fs.existsSync(cfgSrc)) {
    const pristine = path.join(VENDOR, 'gameConfig.original.json');
    fs.copyFileSync(cfgSrc, pristine);
    console.log('[fetch-source] 保留原始配置副本 ->', path.relative(ROOT, pristine));
  }

  // Proof that the Android shell did not come along.
  const markers = findShellMarkers(VENDOR);
  if (markers.length) {
    console.error('[fetch-source] 错误：vendor/ 中出现了安卓壳文件：');
    markers.forEach((m) => console.error('  -', path.relative(ROOT, m)));
    return 3;
  }

  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log('');
  console.log('[fetch-source] 完成');
  console.log('  game     : ' + afterGame.files + ' 个文件, ' + mb(afterGame.bytes));
  console.log('  resource : ' + (stats.files - afterGame.files) + ' 个文件, ' + mb(stats.bytes - afterGame.bytes));
  console.log('  合计     : ' + stats.files + ' 个文件, ' + mb(stats.bytes));
  console.log('  安卓壳文件: 0（已校验）');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, parseArgs, findShellMarkers, DEFAULT_SRC };
