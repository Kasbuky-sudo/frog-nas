'use strict';
/**
 * Projections: engine state -> the JSON the REST API and the push events use.
 *
 * These are DERIVED views, never a second implementation of a rule. Where a value
 * is a game rule (is a clover ripe, is a slot legal) it is read from the engine's
 * own state and tables; where it is a convenience (a Chinese label for a status)
 * it is labelled as such in docs/protocol.md.
 *
 * The one thing this module deliberately withholds is the frog's DESTINATION: the
 * trip is planned at departure (state.travel.plan) and the player is not supposed
 * to know where the frog went until the postcard arrives, so /state reports only
 * "away / home / what it is doing".
 */

/** state.frog.status: the engine's own encoding (client_load_role / Game.isHome). */
const FROG_STATUS = {
  0: 'home',
  1: 'away',
  2: 'standby',
  3: 'party',
};

/** cloverStatus() from the engine, re-expressed for readers. The rule is the
 *  engine's: last_harvest === -1 is an empty slot, a future rebirth_span is
 *  growing, otherwise ready. */
function cloverStatus(slot, nowSec) {
  const lh = Number(slot.last_harvest) || 0;
  if (lh === -1) return 'empty';
  if (lh > 0 && lh + Number(slot.rebirth_span || 0) > nowSec) return 'growing';
  return 'ready';
}

function cloverView(state, nowSec) {
  const slots = Array.isArray(state.clovers) ? state.clovers : [];
  const out = slots.map((s, i) => {
    const status = cloverStatus(s, nowSec);
    return {
      slot: i + 1,
      cloverId: Number(s.clover_id) || i + 1,
      status,
      /** element 1 is the four-leaf variant; it yields a house item, not clover. */
      fourLeaf: Number(s.element) === 1,
      readyAt: status === 'growing'
        ? Number(s.last_harvest) + Number(s.rebirth_span || 0) : null,
    };
  });
  const ready = out.filter((c) => c.status === 'ready');
  const growing = out.filter((c) => c.status === 'growing');
  const empty = out.filter((c) => c.status === 'empty');
  return {
    slots: out,
    total: out.length,
    readyCount: ready.length,
    readySlots: ready.map((c) => c.slot),
    fourLeafReady: ready.filter((c) => c.fourLeaf).map((c) => c.slot),
    nextReadyAt: out.reduce((acc, c) => (c.readyAt && (!acc || c.readyAt < acc) ? c.readyAt : acc), null),
    /** Nothing still growing and something to pick -- "整片长满了".
     *  The push notification fires on exactly this condition (see
     *  src/push/events.js), so the API and the notification can never disagree
     *  about what 长满 means. Empty (never planted) slots do not block it: there
     *  is nothing growing in them. */
    full: growing.length === 0 && ready.length > 0,
    growingCount: growing.length,
    emptyCount: empty.length,
    /** When the LAST growing slot finishes, i.e. when the field becomes full --
     *  NOT the same question as `nextReadyAt`, which is the earliest one. */
    fullAt: growing.reduce((acc, c) => (c.readyAt && (!acc || c.readyAt > acc) ? c.readyAt : acc), null),
  };
}

/** A storage slot's "nothing here" value. The engine uses -1 (see the client's own
 *  ItemModel.bagDataList = [-1,-1,-1,-1] and placeBack's `t.list[want] === -1`).
 *
 *  Do NOT test `id > 0`: item id 0 is the real item 奶油华夫饼, so a `> 0` test
 *  silently reports a slot holding it as empty. */
const EMPTY_SLOT = -1;
function isEmptySlot(v) { return Number(v) === EMPTY_SLOT; }

/** One storage slot list (bag/desk) as ids with their item metadata. `empty` is
 *  always present, so callers never infer occupancy from the id. */
function slotList(ids, gd) {
  return (Array.isArray(ids) ? ids : []).map((id, i) => {
    const n = Number(id);
    if (isEmptySlot(n) || !Number.isFinite(n)) {
      return { slot: i + 1, itemId: -1, empty: true };
    }
    return {
      slot: i + 1,
      itemId: n,
      empty: false,
      name: gd ? gd.itemName(n) : undefined,
      type: gd ? (gd.item(n) || {}).type : undefined,
    };
  });
}

function houseList(rows, gd) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number(r.item_id) >= 0 && Number(r.count) > 0)
    .map((r) => ({
      itemId: Number(r.item_id),
      count: Number(r.count),
      name: gd ? gd.itemName(r.item_id) : undefined,
      type: gd ? (gd.item(r.item_id) || {}).type : undefined,
    }));
}

/** Item ids the player can actually consume: house (counted), bag and desk (one
 *  each). This is the engine's own `getHaveItem` rule, and it is what decides
 *  whether a visitor can be fed or a material used. */
function ownedItemIds(state) {
  const out = new Map();
  for (const row of (state.items && state.items.house) || []) {
    const id = Number(row.item_id);
    if (id >= 0) out.set(id, (out.get(id) || 0) + (Number(row.count) || 0));
  }
  for (const list of [(state.items && state.items.bag) || [], (state.items && state.items.desk) || []]) {
    for (const raw of list) {
      const id = Number(raw);
      if (!isEmptySlot(id) && Number.isFinite(id)) out.set(id, (out.get(id) || 0) + 1);
    }
  }
  return out;
}

/** The subset of owned items that are 特产 (type 3), i.e. what a guest can eat. */
function ownedSpecialtyIds(state) {
  const out = new Set();
  for (const [id, n] of ownedItemIds(state)) if (n > 0) out.add(id);
  return out;
}

/**
 * The full overview behind GET /api/state.
 *
 * @param {object} state  engine.state
 * @param {object} [gd]   GameData for names (optional; ids are always present)
 * @param {number} [nowSec]
 */
function stateView(state, gd, nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  const frog = state.frog || {};
  const status = FROG_STATUS[Number(frog.status)] || 'unknown';
  const travel = state.travel || {};
  const mails = Array.isArray(state.mails) ? state.mails : [];
  const unread = mails.filter((m) => m && !m.opened);

  const g = state.guest;
  const guest = g ? {
    id: Number(g.id),
    name: gd ? (((gd.character.data || [])[Number(g.id)] || {}).name || undefined) : undefined,
    served: !!g.served,
    confirmed: !!g.confirmed,
    expireAt: Number(g.expire_time) || 0,
    /** What this visitor likes, best first -- the frog-visitor skill's main lever. */
    favourites: gd ? gd.guestFavourites(g.id, 5).map((f) => ({
      itemId: f.itemId, taste: f.taste, name: gd.itemName(f.itemId),
      /** Only an item the player actually HAS (house/bag/desk) can be fed; the
       *  feed consumes it the way the client's consumeHouseItem does. */
      owned: ownedSpecialtyIds(state).has(Number(f.itemId)),
    })) : undefined,
  } : null;

  const pictures = Array.isArray(state.pictures) ? state.pictures : [];
  const specialtys = Array.isArray(state.specialtys) ? state.specialtys : [];
  const handbook = state.handbook || { collections: [], specialtys: [] };

  // ---- collection progress, counted against the tables where they exist
  const allSpecialtyIds = gd ? gd.items.filter((i) => Number(i.type) === 3).map((i) => Number(i.id)) : [];
  const allPictureIds = gd ? gd.pictures.map((p) => Number(p.id)) : [];
  const allCollectionIds = gd ? ((gd.tables.Collection || []).map((c) => Number(c.id))) : [];
  // Codex entries -- what the player has EVER collected, which is not the same as
  // what they still own (see ownedItemIds below, and the `owned` block).
  const codexSpecialtyIds = new Set(specialtys.map((s) => Number(s.item_id)));
  const ownedPicturePicIds = new Set(pictures.map((p) => Number(p.pic_id)));

  return {
    server: { now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null },
    frog: {
      name: state.name,
      /** 'home' | 'away' | 'standby' | 'party' */
      status,
      statusCode: Number(frog.status),
      /** What it is doing at home (engine's motion sequence); null while away. */
      motion: Number(frog.motion) || 0,
      /** Deliberately no destination: the trip plan stays server-side until the
       *  postcard arrives. See docs/protocol.md "why /state hides 目的地". */
      away: status === 'away',
      departAt: Number(travel.departAt) || 0,
      returnAt: Number(travel.returnAt) || 0,
      /** Seconds until the current state changes, when known. */
      returnInSec: status === 'away' && travel.returnAt ? Math.max(0, Number(travel.returnAt) - now) : null,
      nextDepartAt: Number(travel.nextDepartAt) || 0,
      tripCount: Number(travel.tripCount) || 0,
      /** True while the frog is home but has nothing packed, which is why it is
       *  not leaving -- the state the frog-prepare skill exists to fix. */
      waitingForBag: !!travel.waitingForBag,
      prepared: !!travel.plan,
    },
    resources: {
      clover: Number(state.clover) || 0,
      ticket: Number(state.ticket) || 0,
    },
    clovers: cloverView(state, now),
    storage: {
      bag: slotList(state.items && state.items.bag, gd),
      desk: slotList(state.items && state.items.desk, gd),
      house: houseList(state.items && state.items.house, gd),
    },
    mail: {
      total: mails.length,
      unread: unread.length,
      /** Newest few, so a caller can see what arrived without a second request. */
      recent: mails.slice(-5).reverse().map((m) => ({
        id: Number(m.id),
        title: m.title,
        type: Number(m.type),
        read: !!m.read,
        opened: !!m.opened,
        clover: Number((m.resource || {}).clover_point) || 0,
        ticket: Number((m.resource || {}).ticket) || 0,
        items: Array.isArray(m.items) ? m.items : [],
        pictures: Array.isArray(m.pictures) ? m.pictures.length : 0,
      })),
    },
    guest,
    lottery: {
      /** A pending colour ball means a prize was drawn and is waiting to be redeemed. */
      pendingBall: Number((state.gacha || {}).colorBall) >= 0 ? Number(state.gacha.colorBall) : null,
      draws: Number(state.gachaCount) || 0,
      /** Cost per draw, from the tuning table (RAFFEL_NEEDTICKETS). */
      ticketCost: gd ? Number((gd.define.scalars || {}).RAFFEL_NEEDTICKETS) || 5 : 5,
      canDraw: (Number(state.ticket) || 0) >= (gd ? Number((gd.define.scalars || {}).RAFFEL_NEEDTICKETS) || 5 : 5),
      phase: Number((state.lottery || {}).phase) || 0,
    },
    collections: {
      pictures: { owned: pictures.length, total: allPictureIds.length || null },
      specialtys: {
        /** Codex entries (ever collected). NOT a feedable stock -- see `owned`. */
        owned: codexSpecialtyIds.size,
        total: allSpecialtyIds.length || null,
      },
      handbook: {
        collections: (handbook.collections || []).length,
        specialtys: (handbook.specialtys || []).length,
        totalCollections: allCollectionIds.length || null,
      },
      achievements: (state.achieves || []).length,
      title: state.curAchieve || null,
    },
    specialtys: specialtys.map((s) => ({
      itemId: Number(s.item_id),
      count: Number(s.count) || 0,
      /** 图鉴 entry: records that it was ever collected. NOT a feedable stock. */
      name: gd ? gd.itemName(s.item_id) : undefined,
    })),
    /** What can actually be consumed (house + bag + desk), which is a different
     *  set from `specialtys` above. A guest feed and most crafting take from here,
     *  so anything that needs "what do I have" must read this, not `specialtys`. */
    owned: {
      /** type-3 特产 only -- the guest's food. */
      feedableSpecialtys: gd ? Array.from(ownedSpecialtyIds(state))
        .filter((id) => Number((gd.item(id) || {}).type) === 3)
        .map((id) => ({ itemId: id, name: gd.itemName(id) }))
        : undefined,
      itemIds: Array.from(ownedItemIds(state).keys()),
    },
  };
}

/** Chinese one-line description of the frog, used by push notifications. */
function frogStatusLabel(state) {
  const status = Number((state.frog || {}).status);
  return FROG_STATUS[status] || 'unknown';
}

module.exports = {
  stateView, cloverView, cloverStatus, slotList, houseList, FROG_STATUS, frogStatusLabel,
  EMPTY_SLOT, isEmptySlot, ownedItemIds, ownedSpecialtyIds,
};
