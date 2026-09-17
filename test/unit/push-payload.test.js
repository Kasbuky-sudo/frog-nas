'use strict';
/**
 * Push payload rendering: the webhook body template and the MeoW request shape.
 */
const test = require('node:test');
const assert = require('node:assert');

const { render, renderJsonTemplate, renderWebhookBody, DEFAULT_TEMPLATE } =
  require('../../src/push/webhook');

const NOTE = {
  event: 'depart',
  title: '青蛙出发了',
  body: '蛙背上行囊出门了。',
  data: { departAt: 1700000000, tripCount: 3 },
  at: 1700000000,
  url: 'http://nas:8980/',
  image: 'http://nas:8980/asset/postcard/100',
};

test('webhook: the default template emits parseable JSON with a nested data object', () => {
  const { body, contentType } = renderWebhookBody(NOTE, {});
  assert.match(contentType, /application\/json/);
  const parsed = JSON.parse(body);
  assert.equal(parsed.event, 'depart');
  assert.equal(parsed.title, '青蛙出发了');
  assert.equal(parsed.body, '蛙背上行囊出门了。');
  assert.deepEqual(parsed.data, { departAt: 1700000000, tripCount: 3 },
    'data must arrive as a JSON object, not a stringified one');
  assert.equal(parsed.image, 'http://nas:8980/asset/postcard/100');
});

test('webhook: the timestamp is ISO, from the event time', () => {
  const parsed = JSON.parse(renderWebhookBody(NOTE, {}).body);
  assert.equal(parsed.timestamp, new Date(NOTE.at * 1000).toISOString());
});

test('webhook: values containing quotes and newlines stay valid JSON', () => {
  const nasty = {
    event: 'return', title: '带"引号"的标题', body: '第一行\n第二行\t带制表符',
    data: { note: 'a "quoted" value' }, at: 1700000000,
  };
  const { body } = renderWebhookBody(nasty, {});
  const parsed = JSON.parse(body);
  assert.equal(parsed.title, '带"引号"的标题');
  assert.equal(parsed.body, '第一行\n第二行\t带制表符');
  assert.deepEqual(parsed.data, { note: 'a "quoted" value' });
});

test('webhook: a placeholder inside a quoted string is escaped, not raw-spliced', () => {
  const { body, contentType } = renderWebhookBody(NOTE, {
    template: '{"text":"{{title}}: {{body}}","e":"{{event}}"}',
  });
  assert.match(contentType, /application\/json/);
  const parsed = JSON.parse(body);
  assert.equal(parsed.text, '青蛙出发了: 蛙背上行囊出门了。');
  assert.equal(parsed.e, 'depart');
});

test('webhook: a placeholder standing alone as a value takes the raw JSON', () => {
  const { body } = renderWebhookBody(NOTE, { template: '{"event":"{{event}}","data":{{data}}}' });
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.data, { departAt: 1700000000, tripCount: 3 });
});

test('webhook: a non-JSON template goes out as text/plain, unescaped', () => {
  const { body, contentType } = renderWebhookBody(NOTE, { template: '{{title}} / {{body}}' });
  assert.match(contentType, /text\/plain/);
  assert.equal(body, '青蛙出发了 / 蛙背上行囊出门了。');
});

test('webhook: contentType:"text" forces text even for a JSON-looking template', () => {
  const { body, contentType } = renderWebhookBody(NOTE, {
    template: '{"a":"{{title}}"}', contentType: 'text',
  });
  assert.match(contentType, /text\/plain/);
  assert.equal(body, '{"a":"青蛙出发了"}');
});

test('webhook: an unknown placeholder is left alone rather than blanked', () => {
  const { body } = renderWebhookBody(NOTE, { template: '{"x":"{{nope}}"}', contentType: 'text' });
  assert.match(body, /\{\{nope\}\}/);
});

test('webhook: dataJson is available as an explicit string', () => {
  const { body } = renderWebhookBody(NOTE, { template: '{"d":{{dataJson}}}' });
  const parsed = JSON.parse(body);
  assert.equal(typeof parsed.d, 'string');
  assert.deepEqual(JSON.parse(parsed.d), { departAt: 1700000000, tripCount: 3 });
});

test('webhook: the default template documents the placeholders the brief names', () => {
  for (const key of ['event', 'title', 'body', 'timestamp', 'url', 'image']) {
    assert.ok(DEFAULT_TEMPLATE.includes('{{' + key + '}}'), 'default template has ' + key);
  }
});

test('render(): plain substitution leaves unknown keys untouched', () => {
  assert.equal(render('{{a}}-{{b}}', { a: '1' }), '1-{{b}}');
});

test('renderJsonTemplate(): an unquoted string value gets quotes added', () => {
  assert.equal(renderJsonTemplate('{"a":{{v}}}', { v: 'x' }), '{"a":"x"}');
  assert.equal(renderJsonTemplate('{"a":{{v}}}', { v: 5 }), '{"a":5}');
  assert.equal(renderJsonTemplate('{"a":{{v}}}', { v: null }), '{"a":null}');
});

test('renderJsonTemplate(): an escaped quote inside a string does not end it', () => {
  // The scanner must not treat \" as the closing quote of the JSON string.
  const out = renderJsonTemplate('{"a":"x\\"{{v}}\\"y"}', { v: 'Z' });
  assert.equal(out, '{"a":"x\\"Z\\"y"}');
  assert.doesNotThrow(() => JSON.parse(out));
});

test('renderJsonTemplate(): arrays survive as arrays', () => {
  const { body } = renderWebhookBody({ ...NOTE, data: { ids: [1, 2, 3] } },
    { template: '{"ids":{{data}}}' });
  assert.deepEqual(JSON.parse(body).ids, { ids: [1, 2, 3] });
});
