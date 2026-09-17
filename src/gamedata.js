'use strict';
/**
 * Read-only access to the game's own data tables.
 *
 * The engine bundle embeds them (define('./data/gamedata.json', ...)) but exports
 * only createEngine/canon/toWire, so the API layer needs its own reader to answer
 * questions like "what is item 12 called" or "what does shop slot 3 cost".
 *
 * Rather than duplicating the bundle into a second file, the tables are sliced out
 * of the bundle text and JSON.parse'd. That is safe because the generator writes
 * them as plain JSON literals (`module.exports = {...};`), and it keeps the source
 * of truth in exactly one place -- the file the engine itself runs.
 *
 * Nothing here is allowed to influence gameplay: the engine remains authoritative
 * for every number that matters. This module only names things.
 */
const fs = require('fs');

/** Extract the JSON literal assigned by `define(<name>, function (module, exports) {` */
function extractModuleLiteral(source, name) {
  const marker = "define('" + name + "', function (module, exports) {";
  const mi = source.indexOf(marker);
  if (mi < 0) throw new Error('table not found in bundle: ' + name);
  const eq = source.indexOf('module.exports =', mi);
  if (eq < 0) throw new Error('no module.exports for ' + name);
  let i = source.indexOf('{', eq);
  if (i < 0) throw new Error('no object literal for ' + name);
  const start = i;
  let depth = 0, inStr = null, esc = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return JSON.parse(source.slice(start, i + 1));
}

/**
 * Item type ids, read off the engine's own constants (__offline-engine.js:
 * ITEM_TYPE_LUNCHBOX / _AMULET / _TOOLS / _SPECIALTY / _DRAWING) and confirmed
 * against the item table's distribution.
 *
 * The first three are also the bag/desk SLOT types:
 *   BAG_SLOT_TYPE  = [0, 1, 2, 2]           (便当, 护身符, 工具, 工具)
 *   DESK_SLOT_TYPE = [0, 0, 1, 1, 2, 2, 2, 2]
 * which is what makes a 水壶 impossible to put in the 便当 slot.
 */
const ITEM_TYPE = {
  LUNCHBOX: 0,
  AMULET: 1,
  TOOLS: 2,
  SPECIALTY: 3,
  DRAWING: 13,
  /** COMPOSE materials (the three 木片); the engine files these in the house
   *  rather than among the 特产, which the collection counts must respect. */
  MATERIAL: 16,
};

/** Bag slot types in slot order -- the engine's BAG_SLOT_TYPE, named. */
const BAG_SLOT_TYPES = ['lunchbox', 'amulet', 'tool', 'tool'];
/** Desk slot types in slot order -- the engine's DESK_SLOT_TYPE, named. */
const DESK_SLOT_TYPES = ['lunchbox', 'lunchbox', 'amulet', 'amulet', 'tool', 'tool', 'tool', 'tool'];

class GameData {
  constructor(engineFile) {
    const src = fs.readFileSync(engineFile, 'utf8');
    this.gamedata = extractModuleLiteral(src, './data/gamedata.json');
    this.define = extractModuleLiteral(src, './data/define.json');
    this.tables = this.gamedata.tables || {};
    this.items = this.gamedata.items || [];
    this.itemById = new Map(this.items.map((i) => [Number(i.id), i]));
    this.shopRows = this.tables.shopData || [];
    this.shopById = new Map(this.shopRows.map((s) => [Number(s.id), s]));
    this.pictures = this.tables.Picture || [];
    this.pictureById = new Map(this.pictures.map((p) => [Number(p.id), p]));
    // GoalNumber: id -> { name (Chinese province / museum), tag }. A Goal-type
    // picture's `place` indexes this, which is how a postcard gets a real name.
    this.goals = Array.isArray(this.tables.GoalNumber) ? this.tables.GoalNumber : [];
    this.goalById = new Map(this.goals.map((g) => [Number(g.id), g]));
    this.character = this.tables.Character || { rowItemId: [], data: [] };
  }

  item(id) { return this.itemById.get(Number(id)) || null; }

  itemName(id) {
    const it = this.item(id);
    return it ? String(it.name || '') : '未知物品(' + id + ')';
  }

  /** How many of this item can be owned at once (0 = unlimited in the tables). */
  ownLimit(id) {
    const it = this.item(id);
    return it && Number(it.own_num) > 0 ? Number(it.own_num) : 0;
  }

  /** Normalised shop catalogue for /api/shop, ordered as the client shows it. */
  shopList() {
    return this.shopRows.slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .map((s) => ({
        shopId: Number(s.id),
        itemId: Number(s.itemId),
        name: String(s.name || this.itemName(s.itemId)),
        info: String(s.info || ''),
        price: Number(s.price) || 0,
        limit: Number(s.limit) || 0,
        order: Number(s.order) || 0,
        beforeBuy: Array.isArray(s.before_buy) ? s.before_buy : [],
        hideBefore: !!Number(s.is_hide_before),
      }));
  }

  setShopList(list) { if (Array.isArray(list) && list.length) this.shopRows = list; }

  /** Postcard/composite metadata for one Picture row. */
  picture(id) { return this.pictureById.get(Number(id)) || null; }

  /**
   * A player-facing name for a postcard.
   *
   * A Picture row's own `name` is an internal asset id ("back_n_roof1",
   * "help_bh"), so it must never be shown to the user. What the game DOES show is
   * the destination: a `Goal`-type picture carries `place`, which indexes
   * GoalNumber, and those rows hold the Chinese province/museum names
   * (北京 / 成都 / …). Normal and Unique cards are trip snapshots with no
   * destination label of their own, so they get a descriptive fallback instead of
   * a fake name.
   */
  pictureLabel(id) {
    const p = this.picture(id);
    if (!p) return null;
    const type = String(p.type || '');
    if (type === 'Goal' && Number(p.place) > 0) {
      const row = this.goalById.get(Number(p.place));
      if (row && row.name) return String(row.name);
    }
    if (type === 'Goal') return '目的地照片';
    if (type === 'Unique') return '特别的明信片';
    return '旅途明信片';
  }

  /** Visitor preferences: Character.taste is aligned to Character.rowItemId, whose
   *  entries are Specialty item ids. Returns the raw taste value (the client maps
   *  it to one of four reactions itself) plus the matching item. */
  guestTaste(guestId, itemId) {
    const row = (this.character.data || [])[Number(guestId)];
    const ids = this.character.rowItemId || [];
    if (!row || !Array.isArray(row.taste)) return null;
    const i = ids.indexOf(Number(itemId));
    if (i < 0) return null;
    return Number(row.taste[i]) || 0;
  }

  /** Item ids a visitor actually likes, best first -- drives the frog-visitor skill. */
  guestFavourites(guestId, limit) {
    const row = (this.character.data || [])[Number(guestId)];
    const ids = this.character.rowItemId || [];
    if (!row || !Array.isArray(row.taste)) return [];
    return ids.map((itemId, i) => ({ itemId: Number(itemId), taste: Number(row.taste[i]) || 0 }))
      .sort((a, b) => b.taste - a.taste)
      .slice(0, limit || 5);
  }
}

module.exports = { GameData, extractModuleLiteral, ITEM_TYPE, BAG_SLOT_TYPES, DESK_SLOT_TYPES };
