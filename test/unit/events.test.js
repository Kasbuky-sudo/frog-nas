'use strict';
/**
 * Event derivation: given two engine-state snapshots, which notifications fire?
 * These run against hand-built states so each rule is pinned independently of the
 * engine's pacing.
 */
const test = require('node:test');
const assert = require('node:assert');

const { derive, snapshot, mailKey } = require('../../src/push/events');

/** A minimal state shaped like the engine's. */
function baseState(over) {
  return {
    clover: 100, ticket: 3,
    frog: { status: 0, motion: 0 },
    travel: { departAt: 0, returnAt: 0, tripCount: 0 },
    mails: [],
    // A garden with nothing ready and nothing growing, so clover_ready cannot
    // fire in tests that are about something else.
    clovers: [
      { clover_id: 1, element: 0, sprite: 1, last_harvest: -1, rebirth_span: 300 },
      { clover_id: 2, element: 0, sprite: 1, last_harvest: -1, rebirth_span: 300 },
    ],
    pictures: [], albumPending: [], albumPendingVisit: [], specialtys: [],
    guest: null,
    gacha: { colorBall: -1 },
    achieves: [], curAchieve: 0,
    furniture: { craft: null },
    handbook: { collections: [], specialtys: [] },
    giftBox: { pictures: [], specialtys: [] },
    ...over,
  };
}

/** A fake GameData with just the lookups the derive() path uses. */
const GD = {
  itemName: (id) => 'Item' + id,
  pictureLabel: (id) => 'PA' + '1'.length && ('明信片' + id),
  picture: (id) => ({ id, name: 'pic' + id }),
  guestFavourites: (id) => [{ itemId: 3001, taste: 99 }],
  character: { data: [{ name: '困困' }, { name: '胖胖' }, { name: '跳跳' }], rowItemId: [] },
  define: { scalars: { RAFFEL_NEEDTICKETS: 5 } },
  tables: { Achieve: [{ id: 5, name: '旅行家' }], Collection: [] },
};

/** Derive using states (not snapshots) -- convenience for the diff tests. */
const eventsOf = (prevState, nextState, gd) => derive(
  prevState === null ? null : snapshot(prevState),
  snapshot(nextState), nextState, gd || GD, []
).map((e) => e.event);

test('derive: no baseline means no events (first run must be silent)', () => {
  const s = baseState();
  assert.deepEqual(derive(null, snapshot(s), s, GD, []), []);
});

test('derive: identical snapshots produce nothing', () => {
  const s = baseState();
  const a = snapshot(s);
  assert.deepEqual(derive(a, snapshot(s), s, GD, []), []);
});

test('derive: home -> away is a depart', () => {
  const before = baseState();
  const after = baseState({
    frog: { status: 1, motion: 0 },
    travel: { departAt: 1000, returnAt: 2000, tripCount: 1 },
  });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  assert.deepEqual(evs.map((e) => e.event), ['depart']);
  assert.equal(evs[0].data.tripCount, 1);
});

test('derive: away -> home is a return, with the haul summarised', () => {
  const before = baseState({
    frog: { status: 1 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 },
  });
  const after = baseState({
    frog: { status: 0 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 },
    clover: 110, ticket: 4,
    pictures: [{ id: 1, pic_id: 55 }],
    specialtys: [{ item_id: 3001, count: 1 }],
  });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  const ret = evs.find((e) => e.event === 'return');
  assert.ok(ret, 'return fired');
  assert.equal(ret.data.cloverDelta, 10);
  assert.equal(ret.data.ticketDelta, 1);
  assert.deepEqual(ret.data.newPictureIds, [55]);
  assert.match(ret.body, /带了 1 张照片/);
  assert.match(ret.body, /三叶草 \+10/);
  // The body should NAME what came back, not just count it -- that is the part a
  // player actually reads in a notification.
  assert.match(ret.body, /Item3001/);
  assert.deepEqual(ret.data.newSpecialtyIds, [3001]);
});

test('derive: a return with nothing to show says so plainly', () => {
  const before = baseState({ frog: { status: 1 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 } });
  const after = baseState({ frog: { status: 0 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 } });
  const ret = derive(snapshot(before), snapshot(after), after, GD, []).find((e) => e.event === 'return');
  assert.ok(ret);
  assert.match(ret.body, /没带什么/);
});

test('derive: a trip postcard is reported even though it lands in albumPending', () => {
  // The engine files a trip's photo into albumPending (the client's 新照片 list),
  // not into `pictures`, so watching only `pictures` would miss it entirely.
  const before = baseState({ frog: { status: 1 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 } });
  const after = baseState({
    frog: { status: 0 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 },
    pictures: [],
    albumPending: [{ id: 1, pic_id: 77 }],
  });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  const cards = evs.filter((e) => e.event === 'postcard');
  assert.equal(cards.length, 1, 'exactly one postcard event for the trip photo');
  assert.equal(cards[0].data.picId, 77);
  assert.match(cards[0].body, /新照片|归档/);
});

test('derive: a postcard already reported by the return branch is not reported twice', () => {
  const before = baseState({ frog: { status: 1 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 } });
  const after = baseState({
    frog: { status: 0 }, travel: { departAt: 1, returnAt: 2, tripCount: 1 },
    pictures: [{ id: 9, pic_id: 88 }],
  });
  const cards = derive(snapshot(before), snapshot(after), after, GD, [])
    .filter((e) => e.event === 'postcard');
  assert.equal(cards.length, 1);
});

test('derive: a postcard arriving with no trip at all still fires', () => {
  const before = baseState();
  const after = baseState({ pictures: [{ id: 3, pic_id: 90 }] });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  assert.deepEqual(evs.map((e) => e.event), ['postcard']);
  assert.equal(evs[0].data.picId, 90);
});

test('derive: a new mail reports its contents', () => {
  const before = baseState();
  const after = baseState({
    mails: [{
      id: 7, type: 3, title: '谢谢你的帮忙', message: '小小的心意',
      resource: { clover_point: 500, ticket: 2, reward_gacha: 0 },
      items: [{ item_id: 1001, count: 1 }], pictures: [],
    }],
  });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  const mail = evs.find((e) => e.event === 'mail');
  assert.ok(mail, 'mail event fired');
  assert.match(mail.body, /三叶草 500/);
  assert.match(mail.body, /抽奖券 2/);
  assert.match(mail.body, /Item1001 x1/);
  assert.equal(mail.data.mailId, 7);
});

test('derive: an already-seen mail does not fire again', () => {
  const m = { id: 1, type: 3, title: 't', resource: {}, items: [], pictures: [] };
  const before = baseState({ mails: [m] });
  const after = baseState({ mails: [{ ...m, read: true }] });
  assert.deepEqual(eventsOf(before, after), []);
});

test('derive: nobody -> somebody is a visitor arrival, with a name', () => {
  const before = baseState();
  const after = baseState({ guest: { id: 1, served: false, expire_time: 9 } });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  assert.deepEqual(evs.map((e) => e.event), ['visitor_arrive']);
  assert.equal(evs[0].data.visitorId, 1);
  assert.match(evs[0].body, /胖胖/);
});

test('derive: served false -> true on the SAME visitor is a gift', () => {
  const before = baseState({ guest: { id: 2, served: false, expire_time: 9 }, ticket: 1 });
  // Tickets rise but stay below the draw cost, so only the gift fires.
  const after = baseState({ guest: { id: 2, served: true, expire_time: 9 }, ticket: 2 });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  assert.deepEqual(evs.map((e) => e.event), ['visitor_gift']);
  assert.equal(evs[0].data.ticketDelta, 1);
});

test('derive: a DIFFERENT visitor being already served is not a gift', () => {
  const before = baseState({ guest: { id: 0, served: false, expire_time: 9 } });
  const after = baseState({ guest: { id: 1, served: true, expire_time: 9 } });
  const evs = eventsOf(before, after);
  assert.ok(!evs.includes('visitor_gift'));
});

/** A field of `n` slots, each with the given last_harvest / span. */
function field(n, lh, span, over) {
  return Array.from({ length: n }, (_, i) => ({
    clover_id: i + 1, element: 0, sprite: 1,
    last_harvest: lh, rebirth_span: span, ...(over || {}),
  }));
}

test('derive: the garden fires only when the LAST slot finishes, not the first', () => {
  // The reported bug: 20 slots each regrow on their own timer, so the first one
  // ripens hours before the batch is done. Firing there announced "1 株长好了"
  // and then said nothing about the other 19.
  const now = Math.floor(Date.now() / 1000);

  // BEFORE: the whole field was just harvested -> every slot is growing.
  const allGrowing = baseState({ clovers: field(20, now, 7200) });
  // AFTER the first slot ripens: 1 ready, 19 still growing. Must stay silent.
  const oneRipe = baseState({
    clovers: field(1, 0, 300).concat(field(19, now, 7200)),
  });
  assert.ok(
    !eventsOf(allGrowing, oneRipe).includes('clover_ready'),
    'one ripening clover must NOT notify while the rest are still growing');

  // AFTER the last slot ripens: nothing growing, everything ready -> NOW notify.
  const full = baseState({ clovers: field(20, 0, 300) });
  const evs = derive(snapshot(oneRipe), snapshot(full), full, GD, []);
  const ready = evs.find((e) => e.event === 'clover_ready');
  assert.ok(ready, 'the last slot ripening fires clover_ready');
  assert.equal(ready.data.ready, 20);
  assert.equal(ready.data.total, 20);
  assert.equal(ready.data.empty, 0);
  assert.equal(ready.data.fourLeaf, false);
  assert.match(ready.body, /全部长好了/);

  // ...and it does not repeat while the field merely stays full.
  assert.ok(!eventsOf(full, full).includes('clover_ready'));
});

test('derive: a four-leaf clover in the finished batch is called out', () => {
  const now = Math.floor(Date.now() / 1000);
  const before = baseState({ clovers: field(2, now, 7200) });
  const after = baseState({
    clovers: [
      { clover_id: 1, element: 0, sprite: 1, last_harvest: 0, rebirth_span: 300 },
      { clover_id: 2, element: 1, sprite: 1, last_harvest: 0, rebirth_span: 300 },
    ],
  });
  const ready = derive(snapshot(before), snapshot(after), after, GD, [])
    .find((e) => e.event === 'clover_ready');
  assert.ok(ready, 'clover_ready fired when the field filled');
  assert.equal(ready.data.fourLeaf, true);
  assert.equal(ready.data.ready, 2);
  assert.match(ready.body, /四叶草/);
});

test('derive: a garden that STAYS full does not re-notify', () => {
  const ripe = field(2, 0, 300);
  // Still full -> no event; the crossing already happened.
  assert.ok(!eventsOf(baseState({ clovers: ripe }), baseState({ clovers: ripe })).includes('clover_ready'));
});

test('derive: harvesting one slot out of a full field re-arms the notification', () => {
  const now = Math.floor(Date.now() / 1000);
  const full = baseState({ clovers: field(3, 0, 300) });
  // One slot picked: it starts regrowing, so the field is no longer full.
  const picked = baseState({
    clovers: field(1, now, 7200).concat(field(2, 0, 300)),
  });
  assert.ok(!eventsOf(full, picked).includes('clover_ready'), 'picking a slot is not an event');
  // It comes back -> the field is full again -> one more notification.
  assert.ok(eventsOf(picked, full).includes('clover_ready'));
});

test('derive: an empty garden does not fire clover_ready', () => {
  const empty = field(2, -1, 300);
  assert.ok(!eventsOf(baseState({ clovers: empty }), baseState({ clovers: empty })).includes('clover_ready'));
  // A field that was cleared slot by slot is not "full" either.
  assert.ok(!eventsOf(baseState({ clovers: field(2, 0, 300) }), baseState({ clovers: empty }))
    .includes('clover_ready'));
});

test('derive: a bare patch does not block the field from counting as full', () => {
  // An empty slot has nothing growing in it, so it cannot be "still coming".
  // 19 planted slots, all ripe -> the field is as grown as it can be.
  const now = Math.floor(Date.now() / 1000);
  const before = baseState({
    clovers: field(19, now, 7200).concat([{ clover_id: 20, element: 0, sprite: 1, last_harvest: 0, rebirth_span: 300 }]),
  });
  const after = baseState({
    clovers: field(19, 0, 300).concat([{ clover_id: 20, element: 0, sprite: 1, last_harvest: -1, rebirth_span: 300 }]),
  });
  const ready = derive(snapshot(before), snapshot(after), after, GD, [])
    .find((e) => e.event === 'clover_ready');
  assert.ok(ready, 'the last growing slot finishing is the trigger, bare patch or not');
  assert.equal(ready.data.ready, 19);
  assert.equal(ready.data.total, 20);
  assert.equal(ready.data.empty, 1, 'the bare patch is reported, so 19/20 is distinguishable from 20/20');
});

test('derive: a garden still growing does not fire clover_ready', () => {
  const now = Math.floor(Date.now() / 1000);
  const growing = field(1, now, 7200);
  assert.ok(!eventsOf(baseState({ clovers: growing }), baseState({ clovers: growing })).includes('clover_ready'));
});

test('derive: tickets crossing the draw cost fires the lottery hint', () => {
  const before = baseState({ ticket: 4 });
  const after = baseState({ ticket: 5 });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  assert.deepEqual(evs.map((e) => e.event), ['lottery']);
  assert.equal(evs[0].data.cost, 5);
});

test('derive: tickets already above the cost do not re-fire', () => {
  assert.deepEqual(eventsOf(baseState({ ticket: 7 }), baseState({ ticket: 9 })), []);
});

test('derive: a new achievement with a new title fires title_unlock', () => {
  const before = baseState({ achieves: [], curAchieve: 0 });
  const after = baseState({ achieves: [0], curAchieve: 5 });
  const evs = derive(snapshot(before), snapshot(after), after, GD, []);
  const t = evs.find((e) => e.event === 'title_unlock');
  assert.ok(t);
  assert.match(t.body, /旅行家/);
});

test('derive: a craft finishing fires furniture_finish', () => {
  const before = baseState({ furniture: { craft: { furnitureId: 1, finishAt: 500 } } });
  const after = baseState({ furniture: { craft: null } });
  assert.deepEqual(eventsOf(before, after), ['furniture_finish']);
});

test('derive: an empty event set is the normal case for a quiet tick', () => {
  const s = baseState({ guest: { id: 1, served: true, expire_time: 9 } });
  assert.deepEqual(eventsOf(s, s), []);
});

test('derive: works with no GameData at all (names fall back, ids survive)', () => {
  const before = baseState();
  const after = baseState({ mails: [{ id: 1, title: 'hi', resource: { clover_point: 5 }, items: [], pictures: [] }] });
  const evs = derive(snapshot(before), snapshot(after), after, null, []);
  assert.deepEqual(evs.map((e) => e.event), ['mail']);
  assert.equal(evs[0].data.clover, 5);
});

test('derive: a mail key is its id, so an edit in place is not a new mail', () => {
  assert.equal(mailKey({ id: 5 }), '5');
  const m = { id: 5, type: 3, title: 'a', resource: {}, items: [], pictures: [] };
  const before = baseState({ mails: [m] });
  const after = baseState({ mails: [{ ...m, title: 'b' }] });
  assert.deepEqual(eventsOf(before, after), []);
});

test('derive: multiple simultaneous changes all report, once each', () => {
  const before = baseState();
  const after = baseState({
    frog: { status: 1 }, travel: { departAt: 5, returnAt: 6, tripCount: 1 },
    guest: { id: 0, served: false, expire_time: 9 },
    ticket: 5,
    mails: [{ id: 1, type: 3, title: 'm', resource: {}, items: [], pictures: [] }],
  });
  const evs = eventsOf(before, after);
  assert.deepEqual([...evs].sort(), ['depart', 'lottery', 'mail', 'visitor_arrive'].sort());
  assert.equal(new Set(evs).size, evs.length, 'each event appears once');
});
