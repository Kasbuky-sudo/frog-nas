'use strict';
/**
 * The disk-backed localStorage adapter: the piece that turns the engine's
 * browser persistence into real files, including its backup/tmp/corrupt slots.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DiskStorage, fileForKey } = require('../../src/engine-host');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frog-store-'));
}

test('DiskStorage: key -> file name mapping', () => {
  const dir = tmp();
  const s = new DiskStorage(dir);
  const primary = 'frog.offline.save';
  const slot = 'frog.offline.save::save.json.bak';

  s.setItem(primary, '{"a":1}');
  s.setItem(slot, '{"a":0}');

  // The primary key keeps its exact name so a save written by the phone build
  // still loads by path.
  assert.ok(fs.existsSync(path.join(dir, primary + '.json')));
  assert.ok(fs.existsSync(fileForKey(dir, slot)));
  assert.equal(s.getItem(primary), '{"a":1}');
  assert.equal(s.getItem(slot), '{"a":0}');
});

test('DiskStorage: writes survive a new instance (the restart path)', () => {
  const dir = tmp();
  const a = new DiskStorage(dir);
  a.setItem('frog.offline.save', '{"clover":42}');

  const b = new DiskStorage(dir);
  assert.equal(b.getItem('frog.offline.save'), '{"clover":42}');
  assert.equal(b.length, 1, 'length reflects files on disk');
});

test('DiskStorage: missing key reads as null rather than throwing', () => {
  const s = new DiskStorage(tmp());
  assert.equal(s.getItem('nothing.here'), null);
});

test('DiskStorage: removeItem deletes the file and drops it from length', () => {
  const dir = tmp();
  const s = new DiskStorage(dir);
  s.setItem('k1', 'v');
  s.setItem('k2', 'v');
  assert.equal(s.length, 2);
  s.removeItem('k1');
  assert.equal(s.length, 1);
  assert.equal(s.getItem('k1'), null);
  // Removing something absent must not throw.
  s.removeItem('k1');
});

test('DiskStorage: an unsafe key cannot escape the save directory', () => {
  const dir = tmp();
  const s = new DiskStorage(dir);
  const evil = '../../escaped';
  s.setItem(evil, 'x');
  // Whatever name it got, it must live inside dir.
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'escaped.json')));
  assert.equal(s.getItem(evil), 'x');
});

test('DiskStorage: length/key() are stable and enumerable', () => {
  const dir = tmp();
  const s = new DiskStorage(dir);
  s.setItem('a', '1');
  s.setItem('b', '2');
  assert.equal(s.length, 2);
  const keys = [s.key(0), s.key(1)].sort();
  assert.deepEqual(keys, ['a', 'b']);
  assert.equal(s.key(99), null);
});

test('DiskStorage: a write is atomic (no partial file is ever visible)', () => {
  const dir = tmp();
  const s = new DiskStorage(dir);
  s.setItem('k', 'first');
  s.setItem('k', 'second');
  assert.equal(s.getItem('k'), 'second');
  // The temp file used during the write must not be left behind.
  assert.deepEqual(fs.readdirSync(dir), ['k.json']);
});

test('DiskStorage: the engine\'s own save slots all land as separate files', () => {
  // These are the names the engine builds from savePath + SAVE_BAK/TMP_SUFFIX,
  // reaching the fs stub via keys of the form <SAVE_KEY>::<basename>.
  const dir = tmp();
  const s = new DiskStorage(dir);
  const names = [
    'frog.offline.save',
    'frog.offline.save::save.json.bak',
    'frog.offline.save::save.json.tmp',
    'frog.offline.save::save.json.corrupt-1700000000',
  ];
  names.forEach((n, i) => s.setItem(n, JSON.stringify({ i })));
  assert.equal(fs.readdirSync(dir).length, 4);
  names.forEach((n, i) => assert.equal(JSON.parse(s.getItem(n)).i, i));
});
