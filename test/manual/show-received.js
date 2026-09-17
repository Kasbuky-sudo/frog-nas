const fs = require('fs');
const path = require('path');
const lines = fs.readFileSync(path.join(__dirname, 'received.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
console.log('接收端共收到 ' + lines.length + ' 条：\n');
for (const l of lines) {
  const o = JSON.parse(l);
  console.log('=== ' + o.at + '  ' + o.method + ' ' + o.url + '  (' + o.contentType + ') ===');
  console.log(o.body);
  console.log('');
}
