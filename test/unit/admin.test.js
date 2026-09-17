'use strict';
/**
 * The settings page must always offer a way back to the game.
 *
 * This is a regression guard: the 公告 button navigates the SAME tab to /admin,
 * so a settings page without a return link traps the player there (reported).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ADMIN = path.join(__dirname, '..', '..', 'public', 'admin.html');
const html = fs.readFileSync(ADMIN, 'utf8');

test('admin: has a link back to the game', () => {
  assert.match(html, /id="back-to-game"/);
  assert.match(html, /href="\/"/);
  assert.ok(html.includes('返回游戏'), 'the link is labelled in Chinese');
});

test('admin: the back link is at the TOP, not only in a footer', () => {
  // It must appear before the first settings card, so it is reachable without
  // scrolling on a page with 19 engine knobs and a log viewer.
  const backAt = html.indexOf('id="back-to-game"');
  const firstCard = html.indexOf('<div class="card">');
  assert.ok(backAt > 0, 'back link present');
  assert.ok(firstCard > 0, 'settings cards present');
  assert.ok(backAt < firstCard, 'the back link precedes the cards');
});

test('admin: a second back affordance follows the scroll', () => {
  // The header button scrolls out of view on this long page, so there is a fixed
  // one too, shown only once the page has scrolled.
  assert.match(html, /id="back-float"/);
  const floatAt = html.indexOf('id="back-float"');
  assert.ok(floatAt > 0, 'floating back link present');
  // It is hidden at the top and revealed by scroll position.
  assert.match(html, /back-float[\s\S]{0,400}display:none/);
  assert.match(html, /window\.scrollY > 320/);
  assert.match(html, /addEventListener\('scroll'/);
});

test('admin: every back link points at the game root, not a deep path', () => {
  // Extract each back-link element by its id, wherever href sits relative to it.
  const ids = ['back-to-game', 'back-float'];
  const hrefs = ids.map((id) => {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > 0, id + ' present');
    // Look at the whole opening tag for that element.
    const tagStart = html.lastIndexOf('<', at);
    const tagEnd = html.indexOf('>', at);
    const tag = html.slice(tagStart, tagEnd);
    const m = /href="([^"]+)"/.exec(tag);
    return m ? m[1] : null;
  });
  assert.equal(hrefs.length, 2);
  for (const h of hrefs) assert.equal(h, '/', 'back link must go to / (got ' + h + ')');
});

test('admin: still credits all three parties', () => {
  assert.ok(html.includes('Kasbuky'), 'port author');
  assert.ok(html.includes('Hit-Point'), 'copyright holder');
  assert.ok(html.includes('Balticx'), 'offline build author');
});
