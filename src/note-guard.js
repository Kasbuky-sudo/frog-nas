'use strict';
/**
 * The client renders every row of `travel_load_note` through its own note config
 * table (Tabikaeru.DataManager.TravelNoteDB) and dereferences that config
 * unconditionally:
 *
 *   TravelNoteModel.updateRedot()      -- reads `o.config.attach` / `o.config.type`
 *                                         for every UNREAD note
 *   TravelNoteModel.getNoteListByType() -- `.filter(t => t.config.type == e)`
 *
 * A row whose id has no config throws a TypeError inside the client, and the
 * client's `window.onerror` turns that into the "呱呱，吃坏肚子了，快重启一下游戏！"
 * dialog (main.min.js: NetworkControl.reloading(Reload.JSError)).
 *
 * The engine builds its own guard -- TV_NOTE_IDS -- from EVERY row of the Note
 * table, but 27 of those 191 rows are not notes at all: ids 20000, 20010, ...,
 * 20260 are the unlock-condition rows for the 旅友 notes (`attach: 2000`,
 * factorType `Own_Note`). They carry no `type`, the client has no config for
 * them, and the engine will hand them out like any other id because they sit in
 * the same table. Dropping them here, at the wire, is the fix that needs no edit
 * to `vendor/` (which must stay byte-identical to the source package).
 *
 * The renderable set is exactly the rows that carry a `type` -- 137 见闻 (type 1)
 * + 27 旅友 (type 2) = the 164 the client's own UI reports ("见闻 x/137",
 * "旅友 y/27").
 */
const fs = require('fs');
const path = require('path');
const { extractModuleLiteral } = require('./gamedata');

let renderable = null;

/** Ids the browser's note book can actually render. Built once, lazily. */
function renderableNoteIds() {
  if (renderable) return renderable;
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'game', '__offline-engine.js'), 'utf8');
  const gd = extractModuleLiteral(src, './data/gamedata.json');
  const table = (gd.tables && gd.tables.Note) || {};
  const rows = Array.isArray(table) ? table : Object.values(table);
  renderable = new Set();
  for (const row of rows) {
    if (row && row.type !== undefined) renderable.add(Number(row.id));
  }
  return renderable;
}

function isRenderableNoteId(id) {
  return renderableNoteIds().has(Number(id));
}

/**
 * Drop rows the client cannot render from a `travel_load_note` payload.
 * Returns the same shape, with a filtered `note_list`.
 */
function sanitizeNotePayload(cmd, data) {
  const wire = String(cmd || '').replace(/\./g, '_');
  if (wire !== 'travel_load_note' || !data || !Array.isArray(data.note_list)) return data;
  const kept = data.note_list.filter((n) => n && isRenderableNoteId(n.id));
  if (kept.length === data.note_list.length) return data;
  const dropped = data.note_list
    .filter((n) => n && !isRenderableNoteId(n.id))
    .map((n) => Number(n.id));
  console.warn('[notes] dropped ' + dropped.length +
    ' note id(s) the client has no config for: ' + dropped.join(', '));
  return Object.assign({}, data, { note_list: kept });
}

module.exports = { renderableNoteIds, isRenderableNoteId, sanitizeNotePayload };
