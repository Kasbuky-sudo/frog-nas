// A tiny push receiver for manual verification: logs every request to a file.
const http = require('http');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'received.jsonl');
fs.writeFileSync(OUT, '');
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => b += c);
  req.on('end', () => {
    fs.appendFileSync(OUT, JSON.stringify({
      at: new Date().toISOString(), method: req.method, url: req.url,
      contentType: req.headers['content-type'], body: b,
    }) + '\n');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    console.log('[' + new Date().toLocaleTimeString() + '] ' + req.method + ' ' + req.url + ' <- ' + b.slice(0, 120));
  });
}).listen(8899, '127.0.0.1', () => console.log('push receiver listening on http://127.0.0.1:8899/hook'));
