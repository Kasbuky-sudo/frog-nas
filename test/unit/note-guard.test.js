'use strict';
/**
 * The client's note book dereferences its own config for every row it is handed
 * (updateRedot -> o.config.attach, getNoteListByType -> t.config.type), so a row
 * with no config is the "呱呱，吃坏肚子了" JSError dialog. The engine's TV_NOTE_IDS
 * accepts 27 ids that have no config (the 20000-series condition rows), so the
 * wire filter is what keeps the client alive.
 */
const test = require('node:test');
const assert = require('node:assert');
const guard = require('../../src/note-guard');

test('the renderable set is exactly the notes the client can draw', () => {
  const ids = guard.renderableNoteIds();
  // 137 见闻 (type 1) + 27 旅友 (type 2) -- the totals the game's own note book shows.
  assert.equal(ids.size, 164, 'expected 137 + 27 renderable notes');
  for (const id of [1000, 1136, 2000, 2026]) {
    assert.ok(ids.has(id), id + ' is a real note');
  }
});

test('the 27 condition rows in the same table are NOT renderable', () => {
  for (const id of [20000, 20010, 20130, 20260]) {
    assert.equal(guard.isRenderableNoteId(id), false,
      id + ' is an unlock-condition row (attach/factorType), not a note');
  }
});

test('sanitizeNotePayload drops only the rows the client cannot render', () => {
  const payload = {
    note_list: [
      { id: 1006, read: 1, timestamp: 1 },
      { id: 20060, read: 0, timestamp: 2 },   // <- would throw in updateRedot()
      { id: 2006, read: 0, timestamp: 3 },
    ],
  };
  const out = guard.sanitizeNotePayload('travel_load_note', payload);
  assert.deepEqual(out.note_list.map((n) => n.id), [1006, 2006]);
  assert.equal(payload.note_list.length, 3, 'the input is not mutated');
});

test('sanitizeNotePayload leaves other commands and clean payloads alone', () => {
  const other = { note_list: [{ id: 20060 }] };
  assert.equal(guard.sanitizeNotePayload('album_load', other), other);
  const clean = { note_list: [{ id: 1006 }] };
  assert.equal(guard.sanitizeNotePayload('travel_load_note', clean), clean,
    'an all-renderable payload is returned as-is');
  assert.deepEqual(guard.sanitizeNotePayload('travel_load_note', {}), {});
});
