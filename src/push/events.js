'use strict';
/**
 * Event derivation: engine pushes + state snapshots -> the events a player wants
 * notified about.
 *
 * The engine tells us a lot of things ("client.load_role changed", "mail.load"),
 * but almost none of it is an event: a push fires on every login and on every
 * unrelated action. So the dispatcher works in two stages, and this module is the
 * second one:
 *
 *   1. wire pushes (from ws-bridge / bot) are sampled into a diff of the fields
 *      the brief names: frog status, mail list, guest, album, titles, tickets;
 *   2. a periodic snapshot tick compares the current state against the last one,
 *      which catches changes that arrived while nobody was connected at all --
 *      the case that matters for external push, because the whole point is to
 *      notify a player whose browser is closed.
 *
 * Both stages funnel into the same `derive()` so an event cannot be delivered
 * twice: `derive` is pure w.r.t. the previous snapshot, and the snapshot is only
 * advanced by `commit()`.
 *
 * The wire push is preferred when it exists, because it carries data the state
 * does not keep (the mail that just arrived is inside the payload, and the engine
 * drops it from state once opened).
 */

/** The mail `type` values that mean "a postcard arrived" (see engine's makeMail /
 *  deliverAdsGift; Mail.EvtId.Gift === 3). */
const MAIL_TYPE_PICTURE = new Set([1, 2, 5]);

function nowSec() { return Math.floor(Date.now() / 1000); }

/** A stable identity for a mail, so "same mail seen twice" is not two events. */
function mailKey(m) {
  return String(m && m.id);
}

/**
 * Build the snapshot we diff on. Kept small on purpose: only the fields the event
 * list needs, so a busy save does not make every tick expensive.
 */
function snapshot(state) {
  const mails = Array.isArray(state.mails) ? state.mails : [];
  /* Classified once per pass: the four clover fields all read from this, so the
     20-slot scan is not repeated five times every tick. */
  const cl = cloverCounts(state);
  return {
    frogStatus: Number((state.frog || {}).status),
    tripCount: Number((state.travel || {}).tripCount) || 0,
    departAt: Number((state.travel || {}).departAt) || 0,
    returnAt: Number((state.travel || {}).returnAt) || 0,
    mailIds: mails.map(mailKey).sort(),
    mailCount: mails.length,
    unopened: mails.filter((m) => m && !m.opened).length,
    guestId: state.guest ? Number(state.guest.id) : null,
    guestServed: state.guest ? !!state.guest.served : false,
    /** Every picture the player now has, from all four places one can live.
     *  A trip's postcard does NOT go straight into `pictures`: it lands in
     *  `albumPending` and waits for the player to file it (`album_save_new`), so
     *  watching only `pictures` misses the moment the postcard actually arrives. */
    pictureIds: pictureIdsIn(state).sort((a, b) => a - b),
    pictureCount: (state.pictures || []).length,
    pendingPictures: (state.albumPending || []).length + (state.albumPendingVisit || []).length,
    specialtyCount: (state.specialtys || []).length,
    /** Ready-to-harvest clovers, so "the garden is full" can be reported without
     *  re-deriving the engine's ripeness rule here. */
    cloverReady: cl.ready.length,
    /** Slots still regrowing. Carried in the snapshot because "长满了" is the
     *  crossing of THIS to zero -- not of `cloverReady` away from zero. */
    cloverGrowing: cl.growing,
    /** True only when nothing is left growing and there is something to pick.
     *  Precomputed so `derive` compares one boolean instead of re-deriving the
     *  engine's rule, and so the API and logs expose the same notion of "full". */
    cloverFull: cloverFull(cl),
    /** ...and how many of those are the four-leaf kind, which yields a house ITEM
     *  instead of clover -- worth calling out separately in the notification. */
    fourLeafReady: cl.ready.filter((s) => Number(s.element) === 1).length,
    cloverTotal: cl.total,
    cloverEmpty: cl.empty,
    specialtyIds: specialtyIdsIn(state),
    ticket: Number(state.ticket) || 0,
    clover: Number(state.clover) || 0,
    achievements: (state.achieves || []).length,
    currentTitle: state.curAchieve || null,
    craftFinishAt: state.furniture && state.furniture.craft
      ? Number(state.furniture.craft.finishAt) || 0 : 0,
  };
}

/**
 * Classify every clover slot the way the engine's own `cloverStatus` does:
 * `last_harvest === -1` is an empty slot, a `last_harvest + rebirth_span` still in
 * the future is growing, and anything else is ready.
 *
 * One classifier for all three questions the events ask (how many are ready, how
 * many are still growing, is the field full), so the rule cannot drift between
 * them -- and so `derive` never re-derives engine behaviour.
 *
 * @returns {{ready: Array, growing: number, empty: number, total: number}}
 */
function cloverCounts(state) {
  const slots = Array.isArray(state.clovers) ? state.clovers : [];
  const now = Math.floor(Date.now() / 1000);
  const out = { ready: [], growing: 0, empty: 0, total: 0 };
  for (const s of slots) {
    if (!s) continue;                                                  // a hole
    out.total++;
    const lh = Number(s.last_harvest);
    if (lh === -1) { out.empty++; continue; }                          // empty
    if (lh > 0 && lh + Number(s.rebirth_span || 0) > now) { out.growing++; continue; }
    out.ready.push(s);                                                 // ripe
  }
  return out;
}

/**
 * Is the garden FULL -- nothing left growing, and something to pick?
 *
 * This is what the notification fires on. Empty slots deliberately do not block
 * it: an empty slot has nothing growing in it, so it cannot be "still coming", and
 * a fully cleared field has nothing ready either -- it stays silent on its own.
 *
 * @param {{ready: Array, growing: number}} counts from cloverCounts()
 */
function cloverFull(counts) {
  return counts.growing === 0 && counts.ready.length > 0;
}

/** Item ids of the souvenirs the player owns, for diffing between snapshots. */
function specialtyIdsIn(state) {
  return (state.specialtys || [])
    .filter((s) => Number(s.count) > 0)
    .map((s) => Number(s.item_id))
    .filter((id) => Number.isFinite(id));
}

/**
 * Name the souvenirs that appeared between two snapshots, or '' when there is
 * nothing to name or the list is too long to read in a notification.
 *
 * @param {object} prev snapshot
 * @param {object} next snapshot
 * @param {object|null} gd GameData, for names
 */
function describeNewSpecialtys(prev, next, gd) {
  if (!gd) return '';
  const before = new Set(prev.specialtyIds || []);
  const added = (next.specialtyIds || []).filter((id) => !before.has(id));
  if (!added.length) return '';
  const names = added.slice(0, 4).map((id) => gd.itemName(id));
  const more = added.length > names.length ? ' 等 ' + added.length + ' 件' : '';
  return '（' + names.join('、') + more + '）';
}

/**
 * Picture-table ids the player owns right now, from every bucket that holds one.
 * `state.pictures` are filed cards; `albumPending` / `albumPendingVisit` are the
 * new ones the client shows in its "新照片" list; `giftBox.pictures` are held in
 * the 礼品盒 until the player moves them to the album.
 */
function pictureIdsIn(state) {
  const out = [];
  const push = (p) => {
    const id = Number(p && p.pic_id);
    if (Number.isFinite(id) && id > 0 && out.indexOf(id) === -1) out.push(id);
  };
  for (const p of state.pictures || []) push(p);
  for (const p of state.albumPending || []) push(p);
  for (const p of state.albumPendingVisit || []) push(p);
  for (const p of ((state.giftBox || {}).pictures || [])) push(p);
  return out;
}

/** Human labels, used as the notification title. Chinese, because that is what
 *  the game itself speaks and what the operator's phone should show. */
const EVENT_LABELS = {
  depart: '青蛙出发了',
  postcard: '收到新的明信片',
  return: '青蛙回家了',
  visitor_arrive: '有访客来了',
  visitor_gift: '访客留下了回礼',
  clover_ready: '三叶草长满了',
  lottery: '抽奖券够了',
  title_unlock: '解锁了新称号',
  furniture_finish: '家具做好了',
  mail: '收到了新邮件',
};

/**
 * Compare two snapshots and produce events.
 *
 * @param {object} prev   previous snapshot (or null on first call -> no events)
 * @param {object} next   current snapshot
 * @param {object} state  live engine state (for details the snapshot omits)
 * @param {object} [gd]   GameData for names
 * @param {Array}  [recentPushes] wire pushes seen since the last call, preferred
 *                  as the source for postcard/return details
 * @returns {Array<{event: string, title: string, body: string, data: object}>}
 */
function derive(prev, next, state, gd, recentPushes) {
  const events = [];
  if (!prev) return events;

  const pushes = recentPushes || [];
  const pushByCmd = new Map();
  for (const p of pushes) if (p && p.cmd) pushByCmd.set(p.cmd, p);

  const gdOrNull = gd || null;
  const itemName = (id) => (gdOrNull ? gdOrNull.itemName(id) : '物品' + id);

  // ---- depart: home -> away
  if (prev.frogStatus !== 1 && next.frogStatus === 1) {
    events.push({
      event: 'depart',
      title: EVENT_LABELS.depart,
      body: '蛙背上行囊出门了，去哪儿还不知道——等它的明信片吧。',
      data: { departAt: next.departAt, tripCount: next.tripCount },
    });
  }

  // ---- return: away -> home
  if (prev.frogStatus === 1 && next.frogStatus !== 1) {
    const newPics = next.pictureIds.filter((id) => !prev.pictureIds.includes(id));
    const lines = [];
    if (newPics.length) lines.push(newPics.length + ' 张照片');
    const newSpecialtys = next.specialtyCount - prev.specialtyCount;
    if (newSpecialtys > 0) lines.push(newSpecialtys + ' 件特产');
    const cloverDelta = next.clover - prev.clover;
    if (cloverDelta > 0) lines.push('三叶草 +' + cloverDelta);
    const ticketDelta = next.ticket - prev.ticket;
    if (ticketDelta > 0) lines.push('抽奖券 +' + ticketDelta);
    /* Name the souvenirs when there are only a few: "带了双皮奶、豆腐乳回来" is the
       notification a player actually wants, and it is knowable here because the
       specialty list is diffed above. With many, the count is more readable. */
    const detail = describeNewSpecialtys(prev, next, gdOrNull);
    let body;
    if (lines.length) {
      body = '蛙回来了，带了 ' + lines.join('、') + '。';
      if (detail) body += detail;
    } else {
      body = '蛙回来了（这次没带什么）。';
    }
    events.push({
      event: 'return',
      title: EVENT_LABELS.return,
      body,
      data: {
        newPictureIds: newPics,
        newSpecialtyIds: (next.specialtyIds || []).filter((id) => !(prev.specialtyIds || []).includes(id)),
        cloverDelta,
        ticketDelta,
        tripCount: next.tripCount,
        /** New postcards are normally waiting in 新照片 to be filed, not yet in
         *  the album -- say so, because the player has to act on it in-game. */
        pendingPictures: next.pendingPictures,
      },
    });
    // The postcard that came home with it is its own notification: it is the part
    // the player actually wants to see, and it can now be rendered.
    for (const picId of newPics.slice(-3)) {
      const label = gdOrNull ? gdOrNull.pictureLabel(picId) : null;
      events.push({
        event: 'postcard',
        title: EVENT_LABELS.postcard,
        body: (label || '明信片') + '，在“新照片”里等着你归档。',
        data: { picId, name: label || undefined },
      });
    }
  }

  // ---- postcard arriving by any other route (mail attachment, visitor, gift
  //      box). Guarded against the return branch above so a trip's postcard is
  //      reported once, not twice.
  const alreadyReported = new Set(
    events.filter((e) => e.event === 'postcard').map((e) => String(e.data.picId)));
  for (const picId of next.pictureIds) {
    if (prev.pictureIds.includes(picId) || alreadyReported.has(String(picId))) continue;
    const label = gdOrNull ? gdOrNull.pictureLabel(picId) : null;
    events.push({
      event: 'postcard',
      title: EVENT_LABELS.postcard,
      body: (label || '明信片') + ' 已经到手了。',
      data: { picId, name: label || undefined },
    });
  }

  // ---- mail: anything new that is not already a postcard event
  const prevMailIds = new Set(prev.mailIds);
  const newMails = (state.mails || []).filter((m) => m && !prevMailIds.has(mailKey(m)));
  const postcardMailIds = new Set(events.filter((e) => e.event === 'postcard').map((e) => String(e.data.picId)));
  for (const m of newMails) {
    const res = m.resource || {};
    const gained = [];
    if (Number(res.clover_point) > 0) gained.push('三叶草 ' + res.clover_point);
    if (Number(res.ticket) > 0) gained.push('抽奖券 ' + res.ticket);
    for (const it of m.items || []) gained.push(itemName(it.item_id) + ' x' + (Number(it.count) || 1));
    if ((m.pictures || []).length) gained.push('照片 ' + m.pictures.length + ' 张');
    const type = Number(m.type);
    events.push({
      event: 'mail',
      title: EVENT_LABELS.mail,
      body: (m.title || '新邮件') + (m.message ? '：' + m.message : '')
        + (gained.length ? '（内含 ' + gained.join('、') + '）' : ''),
      data: {
        mailId: Number(m.id), mailType: type, title: m.title, message: m.message,
        clover: Number(res.clover_point) || 0, ticket: Number(res.ticket) || 0,
        items: m.items || [], pictures: (m.pictures || []).length,
        postcard: MAIL_TYPE_PICTURE.has(type),
      },
    });
  }

  // ---- visitor arrival / gift
  if (prev.guestId === null && next.guestId !== null) {
    const row = gdOrNull ? ((gdOrNull.character.data || [])[next.guestId] || {}) : {};
    events.push({
      event: 'visitor_arrive',
      title: EVENT_LABELS.visitor_arrive,
      body: (row.name ? row.name : '访客') + '来串门了，看看它想吃什么。',
      data: { visitorId: next.guestId, name: row.name },
    });
  }
  if (prev.guestServed === false && next.guestServed === true && prev.guestId === next.guestId) {
    // The回礼 lands in the mail/ticket counters, so report the delta.
    const ticketDelta = next.ticket - prev.ticket;
    events.push({
      event: 'visitor_gift',
      title: EVENT_LABELS.visitor_gift,
      body: '招待完成' + (ticketDelta > 0 ? '，收到 ' + ticketDelta + ' 张抽奖券。' : '，客人心满意足地走了。'),
      data: { visitorId: next.guestId, ticketDelta },
    });
  }

  // ---- the garden is FULLY grown (三叶草长满了)
  //
  // Fired on the crossing "something is still growing -> nothing is", NOT on
  // "nothing was ready -> something is" as it used to be.
  //
  // Why: the field has 20 slots (CLOVER_SLOTS) and each one regrows on its OWN
  // timer (mean 2h, sd 30m -- the engine's rollCloverRebirth). So after a harvest
  // the first slot ripens hours before the batch is done, and reporting that
  // crossing told the player "院子里的三叶草长好了" while 19 were still growing --
  // premature, and then silent about the rest. Waiting for the last slot makes the
  // message actionable: go pick the whole field. It still fires exactly once per
  // harvest cycle, because a garden that STAYS full never crosses again, and a
  // garden that is just never harvested never crosses either.
  //
  // This remains the only event that fires purely from the world's clock with
  // nothing else happening, which makes it the most useful one to have running
  // unattended.
  if (next.cloverFull && !prev.cloverFull) {
    const fourLeaf = Number(next.fourLeafReady) > 0;
    events.push({
      event: 'clover_ready',
      title: EVENT_LABELS.clover_ready,
      body: '院子里的三叶草全部长好了（' + next.cloverReady + ' 株'
        + (fourLeaf ? '，含四叶草' : '') + '），可以去收了。',
      data: {
        ready: next.cloverReady,
        fourLeaf,
        total: next.cloverTotal,
        /** Slots that were empty (never planted) when it filled, so a caller can
         *  tell "20 of 20" from "19 of 20 with one bare patch". */
        empty: next.cloverEmpty,
      },
    });
  }

  // ---- lottery: enough tickets to draw
  const lotteryCost = gdOrNull
    ? Number((gdOrNull.define.scalars || {}).RAFFEL_NEEDTICKETS) || 5 : 5;
  if (prev.ticket < lotteryCost && next.ticket >= lotteryCost) {
    events.push({
      event: 'lottery',
      title: EVENT_LABELS.lottery,
      body: '抽奖券已经攒够 ' + lotteryCost + ' 张了，可以去抽一次扭蛋。',
      data: { ticket: next.ticket, cost: lotteryCost },
    });
  }

  // ---- title unlock
  if (next.achievements > prev.achievements && next.currentTitle !== prev.currentTitle) {
    const achieve = gdOrNull
      ? ((gdOrNull.tables.Achieve || []).find((a) => Number(a.id) === Number(next.currentTitle)) || {})
      : {};
    events.push({
      event: 'title_unlock',
      title: EVENT_LABELS.title_unlock,
      body: '获得称号「' + (achieve.name || next.currentTitle) + '」。',
      data: { achieveId: next.currentTitle, name: achieve.name },
    });
  }

  // ---- furniture finished
  if (prev.craftFinishAt && !next.craftFinishAt) {
    events.push({
      event: 'furniture_finish',
      title: EVENT_LABELS.furniture_finish,
      body: '工作台上的家具做好了，去家具库看看。',
      data: { furnitureId: null },
    });
  }

  return events;
}

module.exports = { derive, snapshot, EVENT_LABELS, mailKey };
