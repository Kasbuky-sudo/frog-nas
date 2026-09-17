'use strict';
/**
 * REST surface: /api/*.
 *
 * Every endpoint is a thin translation onto the wire commands the browser sends,
 * executed through the bot client so the engine stays the only authority on rules.
 * The mapping is documented per-route in docs/protocol.md and asserted by
 * test/unit/openapi-consistency.test.js.
 *
 * Conventions
 * -----------
 *   - auth: `Authorization: Bearer <apiToken>`; only GET /api/health is open
 *     (the container healthcheck needs it, and it exposes nothing but liveness).
 *   - errors: {"error":{"code","message"}} with a real HTTP status.
 *   - refusals that are part of gameplay (no ripe clover, not enough clover) are
 *     NOT errors: they return 200 with `ok:false` and the engine's code, because
 *     "the game said no" is a valid answer the calling agent must handle.
 */
const express = require('express');
const { stateView, EMPTY_SLOT, isEmptySlot } = require('../state-view');
const { SKILLS, skillsIndex } = require('../skills');
const { ITEM_TYPE, BAG_SLOT_TYPES, DESK_SLOT_TYPES } = require('../gamedata');

/** An id the caller gave us that means "this slot". Item id 0 is real, so the
 *  test is >= 0 rather than > 0 (see state-view's EMPTY_SLOT note). */
function isRealItem(id) { return Number.isFinite(id) && id >= 0; }

/** Does an item's type fit a named slot type?
 *
 *  The engine's own `item_putin_bag`/`item_putin_desk` are deliberately
 *  unvalidating (they assign the slot and return {code:0}), because in-game the
 *  UI is what prevents a 水壶 from being dropped into the 便当 slot. An API caller
 *  has no such UI, so the guard is applied here, using the engine's own slot-type
 *  tables (BAG_SLOT_TYPE / DESK_SLOT_TYPE) as the definition of the rule. A
 *  mis-placed item would not break provisioning -- `provisionTrip` scans by type --
 *  but it would render wrong, which is exactly the class of bug the engine's own
 *  `placeBack` comment describes. */
const SLOT_TYPE_TO_ITEM_TYPE = {
  lunchbox: ITEM_TYPE.LUNCHBOX,
  amulet: ITEM_TYPE.AMULET,
  tool: ITEM_TYPE.TOOLS,
};

function slotAccepts(slotTypes, pos, itemId, gd) {
  const want = slotTypes[pos - 1];
  if (!want) return { ok: false, reason: '没有 ' + pos + ' 号格' };
  const it = gd.item(itemId);
  if (!it) return { ok: false, reason: '没有这个物品 id: ' + itemId };
  const expected = SLOT_TYPE_TO_ITEM_TYPE[want];
  if (Number(it.type) !== expected) {
    return {
      ok: false,
      reason: pos + ' 号格是「' + SLOT_LABEL[want] + '」位，放不了「' + gd.itemName(itemId) + '」',
      expected: want,
      actualType: Number(it.type),
    };
  }
  return { ok: true, slotType: want };
}

const SLOT_LABEL = { lunchbox: '便当', amulet: '护身符', tool: '工具' };

/** The engine's refusal codes for the commands we expose, where they are known.
 *  Codes are per-command, so they are looked up with the command name. */
const CODE_MEANING = {
  clover_harvest: { 1: '无效的草丛编号', 2: '这株三叶草还没长好' },
  item_buy: {
    '-1': '商店里没有这个商品编号',
    '-2': '达到购买上限（或已拥有上限数量）',
    '-3': '前置商品还没买（before_buy 链）',
    '-4': '三叶草不够',
  },
};

function explain(cmd, code) {
  if (code === undefined) return undefined;
  const m = CODE_MEANING[cmd];
  return (m && m[String(code)]) || undefined;
}

function jsonError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/** Wrap an async route so a throw becomes a 500 with the standard shape. */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * @param {object} ctx
 * @param {import('./engine-host').EngineHost} ctx.host
 * @param {import('./gamedata').GameData} ctx.gd
 * @param {import('./bot').BotClient} ctx.bot
 * @param {import('./settings').Settings} ctx.settings
 * @param {object} ctx.push          the push dispatcher (for /settings/push, /push/test)
 * @param {object} ctx.logs          push + client log readers
 */
function createApiRouter(ctx) {
  const { host, gd, bot, settings, push } = ctx;
  const router = express.Router();

  // ---------------------------------------------------------------- auth
  //
  // A token is OPTIONAL and off by default: this is meant to be reachable by an AI
  // agent that only knows the address, without a secret to paste into its config.
  // The operator can turn it on from /admin when the port is exposed beyond a
  // trusted LAN. When it is off, requests are simply allowed through.
  router.use((req, res, next) => {
    // CORS for Bearer clients (an AI agent, a script, a different origin's UI).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.path === '/health') { next(); return; }

    const hdr = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    const auth = settings.checkApiAuth(m ? m[1].trim() : '');
    if (!auth.ok) {
      if (auth.reason === 'missing') {
        jsonError(res, 401, 'unauthorized',
          '这台服务器要求 API token。请在 Authorization 头里提供 Bearer token（见 /admin 或 data/config.json 的 apiToken），或到 /admin 关闭「要求 API token」');
      } else {
        jsonError(res, 403, 'forbidden', 'token 无效');
      }
      return;
    }
    next();
  });

  // ------------------------------------------------------------- health
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      engine: host.ready,
      uptimeSec: Math.floor((Date.now() - host.startedAt) / 1000),
      clients: ctx.bridge ? ctx.bridge.clients.size : 0,
      bot: bot.info(),
      now: Math.floor(Date.now() / 1000),
    });
  });

  // -------------------------------------------------------------- state
  router.get('/state', wrap((req, res) => {
    res.json(stateView(host.state, gd));
  }));

  // ------------------------------------------------------------ harvest
  router.post('/harvest', wrap((req, res) => {
    // Accept a specific slot, or "all ready" when no slot is given -- the
    // frog-harvest skill's normal call. Each slot is a separate wire command, so
    // partial success is normal and reported per slot.
    const view = stateView(host.state, gd);
    let targets;
    if (req.body && req.body.slot !== undefined) targets = [Number(req.body.slot)];
    else if (req.body && Array.isArray(req.body.slots)) targets = req.body.slots.map(Number);
    else targets = view.clovers.readySlots;

    const results = [];
    let fourLeaf = 0;
    const cloverBefore = Number(host.state.clover) || 0;
    for (const slot of targets) {
      const r = bot.call('clover_harvest', { clover_id: slot });
      const code = r.code;
      const granted = r.reply && r.reply.type;
      const entry = {
        slot,
        ok: code === 0,
        code,
        reason: explain('clover_harvest', code),
        granted: granted || undefined,
      };
      if (code === 0 && granted === 'four_leaf') fourLeaf++;
      results.push(entry);
    }
    const harvested = results.filter((r) => r.ok).length;
    res.json({
      ok: harvested > 0,
      harvested,
      requested: targets.length,
      fourLeaf,
      /** Read back from the engine rather than summed here: the ordinary slots
       *  credit a fixed amount the engine owns, and a four-leaf clover pays a
       *  house ITEM instead of clover, so `harvested` and this delta legitimately
       *  differ. */
      clover: host.state.clover,
      cloverGained: (Number(host.state.clover) || 0) - cloverBefore,
      results,
      message: harvested ? undefined : (targets.length ? '这些三叶草还不能收（没长好或编号无效）' : '没有可收的三叶草'),
    });
  }));

  // ------------------------------------------------------------- luggage
  router.get('/luggage', wrap((req, res) => {
    const s = host.state;
    res.json({
      slotCount: Array.isArray(s.items.bag) ? s.items.bag.length : 0,
      // Every slot carries `empty` explicitly, so a caller never has to infer
      // occupancy from the id -- item id 0 is a real item (奶油华夫饼) and a
      // `> 0` test would misread it.
      slots: (s.items.bag || []).map((id, i) => {
        const n = Number(id);
        return isEmptySlot(n)
          ? { slot: i + 1, itemId: -1, empty: true }
          : { slot: i + 1, itemId: n, empty: false, name: gd.itemName(n), type: (gd.item(n) || {}).type };
      }),
      /** The engine's slot-type rule: slot 0 is 便当, 1 护身符, 2-3 工具
       *  (BAG_SLOT_TYPE). A PUT that puts the wrong type in a slot is refused. */
      slotTypes: BAG_SLOT_TYPES,
      slotLabels: BAG_SLOT_TYPES.map((t) => SLOT_LABEL[t]),
      bagCompleted: Number(s.items.bagCompleted) || 0,
    });
  }));

  router.put('/luggage', wrap((req, res) => {
    const body = req.body || {};
    const ops = [];
    const place = (pos, itemId) => {
      if (isRealItem(itemId)) {
        const fit = slotAccepts(BAG_SLOT_TYPES, pos, itemId, gd);
        if (!fit.ok) {
          ops.push({ op: 'putin', pos, itemId, name: gd.itemName(itemId), ok: false, reason: fit.reason });
          return;
        }
      }
      const existing = Number((host.state.items.bag || [])[pos - 1]);
      if (!isEmptySlot(existing) && Number.isFinite(existing)) {
        const out = bot.call('item_takeout_bag', { pos });
        ops.push({ op: 'takeout', pos, ok: out.code === undefined || out.code === 0, code: out.code });
      }
      if (isRealItem(itemId)) {
        const put = bot.call('item_putin_bag', { pos, item_id: itemId });
        ops.push({
          op: 'putin', pos, itemId, name: gd.itemName(itemId),
          ok: put.code === undefined || put.code === 0, code: put.code,
        });
      }
    };
    if (body.slots && typeof body.slots === 'object' && !Array.isArray(body.slots)) {
      for (const [posRaw, itemRaw] of Object.entries(body.slots)) place(Number(posRaw), Number(itemRaw));
    } else if (body.items && Array.isArray(body.items)) {
      // Order form: items[i] goes to slot i+1. -1 (or null) means "leave empty".
      body.items.forEach((raw, i) => {
        const id = Number(raw);
        if (isRealItem(id)) place(i + 1, id);
      });
    } else {
      jsonError(res, 400, 'bad_request', '需要 {slots:{"1":itemId,...}} 或 {items:[itemId,...]}');
      return;
    }
    const failed = ops.filter((o) => !o.ok);
    res.json({
      ok: failed.length === 0,
      ops,
      failed: failed.length,
      bag: stateView(host.state, gd).storage.bag,
      message: failed.length ? failed[0].reason || '部分格位未放好（可能是类型不符或库存不足）' : undefined,
    });
  }));

  // --------------------------------------------------------------- table
  const tableGet = (req, res) => {
    const s = host.state;
    res.json({
      slotCount: Array.isArray(s.items.desk) ? s.items.desk.length : 0,
      slots: (s.items.desk || []).map((id, i) => {
        const n = Number(id);
        return isEmptySlot(n)
          ? { slot: i + 1, itemId: -1, empty: true }
          : { slot: i + 1, itemId: n, empty: false, name: gd.itemName(n), type: (gd.item(n) || {}).type };
      }),
      /** DESK_SLOT_TYPE: slots 1-2 便当, 3-4 护身符, 5-8 工具. */
      slotTypes: DESK_SLOT_TYPES,
      slotLabels: DESK_SLOT_TYPES.map((t) => SLOT_LABEL[t]),
      /** What is packed right now -- the frog leaves when something is on the
       *  table or in the bag, so this is what "prepared" means. */
      prepared: !!s.travel.plan || (s.items.desk || []).some((x) => !isEmptySlot(x))
        || (s.items.bag || []).some((x) => !isEmptySlot(x)),
    });
  };
  const tablePut = (req, res) => {
    const body = req.body || {};
    const ops = [];
    const place = (pos, itemId) => {
      if (isRealItem(itemId)) {
        const fit = slotAccepts(DESK_SLOT_TYPES, pos, itemId, gd);
        if (!fit.ok) {
          ops.push({ pos, itemId, name: gd.itemName(itemId), ok: false, reason: fit.reason });
          return;
        }
      }
      const existing = Number((host.state.items.desk || [])[pos - 1]);
      if (!isEmptySlot(existing) && Number.isFinite(existing)) bot.call('item_takeout_desk', { pos });
      if (isRealItem(itemId)) {
        const r = bot.call('item_putin_desk', { pos, item_id: itemId });
        ops.push({
          pos, itemId, name: gd.itemName(itemId),
          ok: r.code === undefined || r.code === 0, code: r.code, reason: r.reason,
        });
      }
    };
    if (body.slots && typeof body.slots === 'object' && !Array.isArray(body.slots)) {
      for (const [posRaw, itemRaw] of Object.entries(body.slots)) place(Number(posRaw), Number(itemRaw));
    } else if (body.items && Array.isArray(body.items)) {
      body.items.forEach((raw, i) => {
        const id = Number(raw);
        if (isRealItem(id)) place(i + 1, id);
      });
    } else {
      jsonError(res, 400, 'bad_request', '需要 {slots:{"1":itemId,...}} 或 {items:[itemId,...]}');
      return;
    }
    const failed = ops.filter((o) => !o.ok);
    res.json({
      ok: failed.length === 0,
      ops,
      failed: failed.length,
      message: failed.length ? failed[0].reason : undefined,
      table: tableGet2(),
    });
  };
  const tableGet2 = () => {
    const s = host.state;
    return {
      slots: (s.items.desk || []).map((id, i) => {
        const n = Number(id);
        return isEmptySlot(n)
          ? { slot: i + 1, itemId: -1, empty: true }
          : { slot: i + 1, itemId: n, empty: false, name: gd.itemName(n) };
      }),
    };
  };
  router.get('/table', wrap(tableGet));
  router.put('/table', wrap(tablePut));
  router.delete('/table', wrap((req, res) => {
    const desk = host.state.items.desk || [];
    let before = 0;
    for (let pos = 1; pos <= desk.length; pos++) {
      if (!isEmptySlot(Number(desk[pos - 1]))) {
        before++;
        bot.call('item_takeout_desk', { pos });
      }
    }
    res.json({ ok: true, cleared: before, table: tableGet2() });
  }));

  // ---------------------------------------------------------------- shop
  router.get('/shop', wrap((req, res) => {
    // Ownership across the three storages. Slot entries use the engine's -1
    // sentinel, so the test is "not -1" rather than "> 0": item id 0 is real.
    const owned = new Map();
    const addOwned = (id, n) => owned.set(Number(id), (owned.get(Number(id)) || 0) + n);
    for (const row of host.state.items.house || []) {
      owned.set(Number(row.item_id), Number(row.count) || 0);
    }
    for (const id of (host.state.items.bag || [])) {
      if (!isEmptySlot(id) && Number.isFinite(Number(id))) addOwned(id, 1);
    }
    for (const id of (host.state.items.desk || [])) {
      if (!isEmptySlot(id) && Number.isFinite(Number(id))) addOwned(id, 1);
    }
    const bought = host.state.shopBought || {};
    const list = gd.shopList().map((row) => {
      const boughtCount = Number(bought[row.shopId]) || 0;
      const ownLimit = gd.ownLimit(row.itemId);
      const have = owned.get(row.itemId) || 0;
      let available = true;
      if (row.limit > 0 && boughtCount >= row.limit) available = false;
      const it = gd.item(row.itemId);
      if (it && Number(it.spend) !== 1 && ownLimit > 0 && have >= ownLimit) available = false;
      if (row.beforeBuy && row.beforeBuy.length) {
        const [kind, id] = row.beforeBuy;
        if (kind === 'shop' && !(Number(bought[Number(id)]) > 0)) available = false;
      }
      return {
        ...row,
        type: it ? Number(it.type) : null,
        bought: boughtCount,
        owned: have,
        ownLimit: ownLimit || null,
        available,
        affordable: Number(host.state.clover) >= row.price,
      };
    });
    res.json({
      clover: host.state.clover,
      count: list.length,
      items: list,
      /** Slots the shop is happy to sell right now. */
      buyable: list.filter((x) => x.available && x.affordable).map((x) => x.shopId),
    });
  }));

  router.post('/shop/buy', wrap((req, res) => {
    const body = req.body || {};
    const shopId = Number(body.shopId !== undefined ? body.shopId : body.shop_id);
    const qty = body.qty === undefined ? 1 : Number(body.qty);
    if (!Number.isFinite(shopId)) { jsonError(res, 400, 'bad_request', '需要 {itemId|shopId, qty}'); return; }
    if (!Number.isFinite(qty) || qty < 1) { jsonError(res, 400, 'bad_request', 'qty 必须是 >= 1 的整数'); return; }
    if (qty > 99) { jsonError(res, 400, 'bad_request', 'qty 过大（上限 99）'); return; }

    // `itemId` is accepted as a convenience: it is resolved to a shop slot here,
    // because the wire command is keyed by slot (see protocol.md).
    let resolvedShopId = shopId;
    if (body.itemId !== undefined && body.shopId === undefined) {
      const want = Number(body.itemId);
      const found = gd.shopList().find((s) => s.itemId === want);
      if (!found) { jsonError(res, 404, 'not_found', '商店里没有 itemId=' + want); return; }
      resolvedShopId = found.shopId;
    }

    const results = [];
    for (let i = 0; i < qty; i++) {
      const r = bot.call('item_buy', { shop_id: resolvedShopId });
      const code = r.code;
      results.push({ ok: code === 0, code, reason: explain('item_buy', code) || r.reason });
      if (code !== 0) break;           // stop at the first refusal (limit/price)
    }
    const bought = results.filter((r) => r.ok).length;
    const last = results[results.length - 1] || {};
    const item = gd.shopById.get(resolvedShopId);
    res.json({
      ok: bought > 0,
      bought,
      requested: qty,
      shopId: resolvedShopId,
      itemId: item ? Number(item.itemId) : undefined,
      name: item ? gd.itemName(item.itemId) : undefined,
      clover: host.state.clover,
      results,
      message: bought ? undefined : (last.reason || '买不了（可能是三叶草不够、已到上限或前置未满足）'),
    });
  }));

  // ------------------------------------------------------------- visitor
  router.get('/visitor', wrap((req, res) => {
    res.json({ guest: stateView(host.state, gd).guest });
  }));

  router.post('/visitor/feed', wrap((req, res) => {
    const body = req.body || {};
    const s = host.state;
    const g = s.guest;
    if (!g) { jsonError(res, 409, 'conflict', '现在没有访客'); return; }
    const visitorId = body.visitorId === undefined ? Number(g.id) : Number(body.visitorId);
    if (Number(g.id) !== visitorId) {
      jsonError(res, 409, 'conflict', '访客已经换了（当前 id=' + g.id + '，请求 id=' + visitorId + '）');
      return;
    }
    if (g.served) { jsonError(res, 409, 'conflict', '这位访客已经招待过了（投喂只在每次到访结算一次）'); return; }

    let itemId = Number(body.itemId);
    if (body.auto === true || !Number.isFinite(itemId)) {
      // Pick the best liked specialty the player actually has IN THE HOUSE.
      //
      // The client does this too: GuestModel.sendGuestServed does
      // `getModel(ItemModel).consumeHouseItem(e, 1)` before sending guest_serve,
      // so the feedable pool is the HOUSE list, and the engine's own guard is
      // `getHaveItem(itemId) <= 0` (house + bag + desk). state.specialtys -- the
      // 特产 图鉴 list -- is a SEPARATE bucket that trips fill and that the feed
      // does NOT consume from; picking from there is why an "obviously owned"
      // souvenir could still be refused.
      const inHouse = new Set(
        (s.items.house || [])
          .filter((r) => Number(r.count) > 0)
          .map((r) => Number(r.item_id)));
      const fav = gd.guestFavourites(g.id, 64)
        .filter((f) => inHouse.has(Number(f.itemId))
          || (s.items.bag || []).indexOf(f.itemId) !== -1
          || (s.items.desk || []).indexOf(f.itemId) !== -1);
      if (!fav.length) {
        const anyOwned = gd.guestFavourites(g.id, 64).length
          ? '家里没有可投喂的特产（旅行带回来的特产要先在游戏里放进家里）'
          : '没有可投喂的特产';
        jsonError(res, 409, 'conflict', anyOwned);
        return;
      }
      itemId = fav[0].itemId;
    } else {
      // An explicit item must still be feedable; say so in the API's own words
      // rather than letting the engine's silent refusal look like a bug.
      const inHouse = (s.items.house || []).some((r) => Number(r.item_id) === itemId && Number(r.count) > 0);
      const inBag = (s.items.bag || []).indexOf(itemId) !== -1;
      const inDesk = (s.items.desk || []).indexOf(itemId) !== -1;
      const it = gd.item(itemId);
      if (!inHouse && !inBag && !inDesk) {
        const inCodex = (s.specialtys || []).some((x) => Number(x.item_id) === itemId);
        jsonError(res, 409, 'conflict',
          '家里没有这件特产' + (inCodex ? '（它在特产图鉴里，但投喂消耗的是家里的库存，请先在游戏里把它放进家里）' : ''));
        return;
      }
      if (!it || Number(it.type) !== 3) {
        jsonError(res, 409, 'conflict', '这件不是特产（type 3），访客只吃特产');
        return;
      }
    }

    // guest_serve is declared needResponse:false in the client's ProtocolList
    // (guest_serve:[["id","item_id"],!1]), so the engine NEVER returns a reply --
    // its refusal branches return `undefined` and so does its success path. The
    // only reliable signal is the guest's own `served` flag, which the engine sets
    // exactly when the feed was accepted.
    const servedBefore = !!s.guest.served;
    const ticketBefore = Number(host.state.ticket) || 0;
    const cloverBefore = Number(host.state.clover) || 0;
    bot.call('guest_serve', { id: visitorId, item_id: itemId });
    const servedAfter = !!(host.state.guest && host.state.guest.served);
    if (!servedAfter || servedAfter === servedBefore) {
      jsonError(res, 409, 'conflict',
        '投喂被拒绝（可能：家里没有这件特产 / 已经招待过 / 类型不是特产）');
      return;
    }
    const taste = gd.guestTaste(visitorId, itemId);
    res.json({
      ok: true,
      visitorId,
      itemId,
      name: gd.itemName(itemId),
      /** The engine's own reaction scale: >=80 delighted, >=60 pleased,
       *  >=20 indifferent, else put off. */
      taste,
      reaction: taste === null ? null
        : taste >= 80 ? 'delighted' : taste >= 60 ? 'pleased' : taste >= 20 ? 'indifferent' : 'put_off',
      ticketDelta: (Number(host.state.ticket) || 0) - ticketBefore,
      cloverDelta: (Number(host.state.clover) || 0) - cloverBefore,
      guest: stateView(host.state, gd).guest,
    });
  }));

  // ------------------------------------------------------------- lottery
  router.post('/lottery/draw', wrap((req, res) => {
    const cost = Number(gd.define.scalars.RAFFEL_NEEDTICKETS) || 5;
    const s = host.state;
    if (Number(s.ticket) < cost) {
      res.json({
        ok: false,
        ticket: s.ticket,
        cost,
        message: '抽奖券不够（需要 ' + cost + ' 张，现有 ' + s.ticket + ' 张）。券来自：旅行归来、信箱邮件、访客回礼。',
      });
      return;
    }
    const r = bot.call('item_gacha', { is_reward: false });
    const ball = r.reply && r.reply.ticket;
    if (ball === -1) {
      res.json({ ok: false, ticket: s.ticket, cost, message: '抽奖券不够' });
      return;
    }
    const prize = (gd.tables.Prize || []).find((p) => Number(p.id) === Number(ball));
    res.json({
      ok: true,
      ball: Number(ball),
      prizeName: prize ? prize.name : undefined,
      /** rank 0 is the white ball, a real prize (Define.PRIZE_WHITE_ID). */
      rank: Number(ball),
      ticket: host.state.ticket,
      cost,
      pendingBall: Number(host.state.gacha.colorBall),
      message: '已抽到一个扭蛋，在客户端里打开即可领取',
    });
  }));

  router.get('/lottery', wrap((req, res) => {
    const v = stateView(host.state, gd);
    res.json(v.lottery);
  }));

  // ---------------------------------------------------------------- mail
  router.get('/mail', wrap((req, res) => {
    const s = host.state;
    const mails = (s.mails || []).slice().reverse().map((m) => ({
      id: Number(m.id),
      type: Number(m.type),
      title: m.title,
      message: m.message,
      read: !!m.read,
      opened: !!m.opened,
      expire: Number(m.expire) || 0,
      clover: Number((m.resource || {}).clover_point) || 0,
      ticket: Number((m.resource || {}).ticket) || 0,
      gacha: Number((m.resource || {}).reward_gacha) || 0,
      items: (m.items || []).map((it) => ({
        itemId: Number(it.item_id), count: Number(it.count) || 1, name: gd.itemName(it.item_id),
      })),
      pictures: (m.pictures || []).length,
    }));
    res.json({ total: mails.length, unread: mails.filter((m) => !m.opened).length, mails });
  }));

  router.post('/mail/claim', wrap((req, res) => {
    const body = req.body || {};
    const s = host.state;
    const unopened = (s.mails || []).filter((m) => m && !m.opened);
    let ids;
    if (body.id !== undefined) ids = [Number(body.id)];
    else if (Array.isArray(body.ids)) ids = body.ids.map(Number);
    else ids = unopened.map((m) => Number(m.id));
    if (!ids.length) { res.json({ ok: true, claimed: 0, message: '没有未领取的邮件' }); return; }

    const before = { clover: Number(s.clover) || 0, ticket: Number(s.ticket) || 0 };
    const results = [];
    for (const id of ids) {
      const mail = (host.state.mails || []).find((m) => m && Number(m.id) === id);
      if (!mail) { results.push({ id, ok: false, reason: '邮件不存在（可能已领取或过期）' }); continue; }
      const snapshot = {
        clover: Number((mail.resource || {}).clover_point) || 0,
        ticket: Number((mail.resource || {}).ticket) || 0,
        gacha: Number((mail.resource || {}).reward_gacha) || 0,
        items: (mail.items || []).map((it) => ({ itemId: Number(it.item_id), count: Number(it.count) || 1 })),
      };
      const r = bot.call('mail_open', { id });
      results.push({ id, title: mail.title, ok: true, gained: snapshot, handled: r.handled });
    }
    res.json({
      ok: results.some((r) => r.ok),
      claimed: results.filter((r) => r.ok).length,
      gained: {
        clover: (Number(host.state.clover) || 0) - before.clover,
        ticket: (Number(host.state.ticket) || 0) - before.ticket,
      },
      results,
      remaining: (host.state.mails || []).length,
    });
  }));

  // --------------------------------------------------------- collections
  router.get('/collections', wrap((req, res) => {
    const s = host.state;
    const pictures = (s.pictures || []).map((p) => ({
      id: Number(p.id),
      picId: Number(p.pic_id),
      /** A player-facing label (destination name for Goal cards). A Picture row's
       *  raw `name` is an asset id like "back_n_roof1" and is never shown. */
      name: gd.pictureLabel(p.pic_id),
      picName: gd.picture(p.pic_id) ? gd.picture(p.pic_id).name : undefined,
      visit: !!p.visit,
    }));
    const specialtys = (s.specialtys || []).map((x) => ({
      itemId: Number(x.item_id), count: Number(x.count) || 0, name: gd.itemName(x.item_id),
    }));
    const handbook = s.handbook || {};
    const allSpecialty = gd.items.filter((i) => Number(i.type) === 3).map((i) => Number(i.id));
    const ownedSpecialty = new Set(specialtys.map((x) => x.itemId));
    const allPictures = gd.pictures.map((p) => Number(p.id));
    const ownedPicIds = new Set(pictures.map((p) => p.picId));
    const collections = gd.tables.Collection || [];
    const ownedCollections = new Set((handbook.collections || []).map(Number));

    res.json({
      album: {
        count: pictures.length,
        total: allPictures.length,
        pictures,
        pending: (s.albumPending || []).length,
        deleted: (s.albumDeleted || []).length,
        missingPicIds: allPictures.filter((id) => !ownedPicIds.has(id)),
      },
      specialtys: {
        count: specialtys.length,
        total: allSpecialty.length,
        items: specialtys,
        missingItemIds: allSpecialty.filter((id) => !ownedSpecialty.has(id)),
      },
      handbook: {
        collections: (handbook.collections || []).map((id) => {
          const row = collections.find((c) => Number(c.id) === Number(id));
          return { id: Number(id), name: row ? row.name : undefined };
        }),
        specialtys: (handbook.specialtys || []).map((id) => ({ itemId: Number(id), name: gd.itemName(id) })),
        totalCollections: collections.length,
        missingCollectionIds: collections.map((c) => Number(c.id)).filter((id) => !ownedCollections.has(id)),
      },
      achievements: {
        count: (s.achieves || []).length,
        ids: s.achieves || [],
        currentTitle: s.curAchieve || null,
      },
      /** The 图鉴 progress the brief asks for, as a single number pair. */
      progress: {
        pictures: { owned: pictures.length, total: allPictures.length },
        specialtys: { owned: specialtys.length, total: allSpecialty.length },
        collections: { owned: (handbook.collections || []).length, total: collections.length },
      },
    });
  }));

  // ------------------------------------------------------------- skills
  router.get('/skills', wrap((req, res) => {
    res.json(skillsIndex());
  }));

  router.get('/skills/:name', wrap((req, res) => {
    const s = SKILLS.find((x) => x.name === req.params.name);
    if (!s) { jsonError(res, 404, 'not_found', '没有这个技能：' + req.params.name); return; }
    res.json({ name: s.name, description: s.description, path: s.path, body: s.body, bytes: s.bytes });
  }));

  // --------------------------------------------------------------- push
  router.get('/settings/push', wrap((req, res) => {
    res.json(push.publicConfig());
  }));

  router.put('/settings/push', wrap((req, res) => {
    const patch = req.body || {};
    const updated = settings.update({ push: patch });
    push.reload(updated.push);
    res.json({ ok: true, push: push.publicConfig() });
  }));

  router.post('/push/test', wrap(async (req, res) => {
    const results = await push.test(req.body || {});
    res.json({ ok: results.ok, results });
  }));

  router.get('/logs/push', wrap((req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ entries: push.recentLogs(limit) });
  }));

  router.get('/logs/client', wrap((req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 2000);
    res.json({ lines: ctx.readClientLog(limit) });
  }));

  // ------------------------------------------------------------ debug (opt-in)
  //
  // The engine ships a GM console (client_gm) that doubles as a save editor: it
  // can add items, force travel, unlock the codex, reset the save. Exposing that
  // on the REST API would let any agent rewrite the world, so it is OFF unless
  // FROG_ENABLE_GM_API=1 is set on the container.
  //
  // It exists because it is the only supported way for a headless test to set up
  // a precondition the game itself would need hours of play to reach (a
  // specialty in the house, a specific visitor, a full ticket purse). Production
  // deployments leave it off; see docs/decisions.md.
  if (process.env.FROG_ENABLE_GM_API === '1') {
    router.post('/debug/gm', wrap((req, res) => {
      const cmd = String((req.body && req.body.cmd) || '').trim();
      if (!cmd) { jsonError(res, 400, 'bad_request', '需要 {cmd:"add_clover 10"}'); return; }
      const r = bot.call('client_gm', { cmd });
      res.json({ ok: !!(r.reply && r.reply.succeed), cmd, reply: r.reply, pushes: r.pushes.length });
    }));
    router.get('/debug/gm/help', wrap((req, res) => {
      const r = bot.call('client_gm', { cmd: 'help' });
      res.json({ help: (r.reply && r.reply.info) || '' });
    }));
  }

  // ------------------------------------------------------------ openapi
  router.get('/openapi.json', wrap((req, res) => {
    res.json(ctx.openapi);
  }));

  return router;
}

module.exports = { createApiRouter, CODE_MEANING, explain, jsonError, wrap };
