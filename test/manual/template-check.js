const path = require('path');
const w = require(path.join(__dirname, '..', '..', 'src', 'push', 'webhook.js'));

const note = { event: 'depart', title: '青蛙出发了', body: '蛙背上行囊出门了。', at: 1, data: { departAt: 5, tripCount: 2 } };

console.log('=== default template ===');
let r = w.renderWebhookBody(note, {});
console.log('contentType:', r.contentType);
console.log(r.body);
try { console.log('PARSES:', JSON.stringify(JSON.parse(r.body))); } catch (e) { console.log('PARSE FAIL', e.message); }

console.log('\n=== plain-text template ===');
r = w.renderWebhookBody(note, { template: '{{title}}: {{body}}' });
console.log('contentType:', r.contentType, '| body:', r.body);

console.log('\n=== quoted placeholder must stay valid JSON ===');
r = w.renderWebhookBody(note, { template: '{"text":"{{title}} - {{body}}","e":"{{event}}"}' });
console.log('contentType:', r.contentType);
console.log(r.body);
try { console.log('PARSES:', JSON.stringify(JSON.parse(r.body))); } catch (e) { console.log('PARSE FAIL', e.message); }

console.log('\n=== nested data placeholder ===');
r = w.renderWebhookBody(note, { template: '{"event":"{{event}}","data":{{data}}}' });
console.log('contentType:', r.contentType);
console.log(r.body);
try { const j = JSON.parse(r.body); console.log('PARSES, data.tripCount =', j.data.tripCount); } catch (e) { console.log('PARSE FAIL', e.message); }

console.log('\n=== template with quotes/newlines in the value ===');
r = w.renderWebhookBody({ event: 'return', title: '带"引号"的标题', body: '第一行\n第二行', at: 1, data: {} }, {});
try { const j = JSON.parse(r.body); console.log('PARSES, title =', j.title, '| body =', JSON.stringify(j.body)); } catch (e) { console.log('PARSE FAIL', e.message); }
