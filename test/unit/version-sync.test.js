'use strict';
/**
 * 版本号防漂移：`package.json` 的 version 是唯一真源，别处出現的版本字符串
 * 必须与它一致。
 *
 * 为什么要这条测试：1.0.2 → 1.0.3 那一次，`package.json` 和 fnOS manifest 改了
 * （build.sh 会从 package.json 覆盖 manifest 并校验，所以那条链是安全的），
 * 但 **Dockerfile、docker-compose.yml、README** 没有任何机制管住 —— 于是它们
 * 停在 1.0.2/1.0.0，README 还把用户指向旧的 Release 页。功能不受影响，但
 * 用户报告 bug 时给的版本号是错的。
 *
 * 这里只检查"应该是当前版本号"的位置，不去扫全仓库的 `1.0.x` 字面量：
 * 文档里有大量历史版本引用（`docs/acceptance.md` 的「§19 真机升级 1.0.2 → 1.0.3」、
 * `docs/decisions.md` 里"1.0.2 修的那三处"）是**故意**保留的历史记录，
 * 把它们一起改掉反而是错的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** 读一个文件，缺失时返回 null（缺失本身由别的测试负责）。 */
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return null; }
}

test('version: package.json is a real semver', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, '版本号应该是 x.y.z');
});

test('version: Dockerfile 的 OCI 版本标签跟随 package.json', () => {
  const s = read('Dockerfile');
  assert.ok(s, 'Dockerfile 存在');
  const m = /org\.opencontainers\.image\.version="([^"]+)"/.exec(s);
  assert.ok(m, 'Dockerfile 里有 image.version 标签');
  assert.equal(m[1], VERSION,
    'Dockerfile 的 image.version 是 ' + m[1] + '，package.json 是 ' + VERSION
    + ' —— 改版本号时这处要一起改');
});

test('version: docker-compose.yml 的 image tag 跟随 package.json', () => {
  const s = read('docker-compose.yml');
  assert.ok(s, 'docker-compose.yml 存在');
  const m = /^\s*image:\s*frog-nas:(\S+)\s*$/m.exec(s);
  assert.ok(m, 'compose 里有 frog-nas:<version> 镜像名');
  assert.equal(m[1], VERSION,
    'compose 的镜像 tag 是 ' + m[1] + '，package.json 是 ' + VERSION
    + ' —— 改版本号时这处要一起改');
});

test('version: README 的 Release 链接与 docker build 示例跟随 package.json', () => {
  const s = read('README.md');
  assert.ok(s, 'README.md 存在');

  // Release 链接：.../releases/tag/v<version>
  const tag = /releases\/tag\/v(\d+\.\d+\.\d+)/.exec(s);
  assert.ok(tag, 'README 里有 Releases 链接');
  assert.equal(tag[1], VERSION, 'README 的 Release 链接指向 v' + tag[1] + '，应为 v' + VERSION);

  // fpk 文件名：frog-nas-<version>.fpk
  const fpk = /frog-nas-(\d+\.\d+\.\d+)\.fpk/.exec(s);
  assert.ok(fpk, 'README 里有 fpk 文件名');
  assert.equal(fpk[1], VERSION, 'README 提到的包名是 ' + fpk[1] + '，应为 ' + VERSION);

  // docker build -t frog-nas:<version>
  const tags = [...s.matchAll(/frog-nas:(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(tags.length >= 2, 'README 里有 docker build 示例（找到 ' + tags.length + ' 处）');
  for (const t of tags) {
    assert.equal(t, VERSION, 'README 的 docker 示例用了 ' + t + '，应为 ' + VERSION);
  }
});

test('version: fnOS manifest 的 version 跟随 package.json', () => {
  const s = read('packaging/fnOS/manifest');
  assert.ok(s, 'fnOS manifest 存在');
  const m = /^version\s*=\s*(\S+)\s*$/m.exec(s);
  assert.ok(m, 'manifest 里有 version 行');
  // build.sh 会在打包时把 package.json 的版本写进暂存副本，所以源文件与
  // package.json 一致是最省事的状态（不一致时 build.sh 仍会纠正，但源文件
  // 会误导读者）。
  assert.equal(m[1], VERSION,
    'manifest 的 version 是 ' + m[1] + '，package.json 是 ' + VERSION);
});

test('version: package-lock.json 跟随 package.json', () => {
  const s = read('package-lock.json');
  assert.ok(s, 'package-lock.json 存在');
  const j = JSON.parse(s);
  assert.equal(j.version, VERSION, 'lock 顶层 version 应为 ' + VERSION);
  assert.equal(j.packages[''].version, VERSION, 'lock 的 packages[""] version 应为 ' + VERSION);
});
