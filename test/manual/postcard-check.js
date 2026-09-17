const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const { GameData } = require(path.join(ROOT, 'src', 'gamedata.js'));
const { PostcardRenderer } = require(path.join(ROOT, 'src', 'postcard.js'));

const gd = new GameData(path.join(ROOT, 'vendor', 'game', '__offline-engine.js'));
const r = new PostcardRenderer({
  gd,
  imageRoot: path.join(ROOT, 'vendor', 'resource', 'China', 'images'),
  cacheDir: path.join(ROOT, '.audit-tmp', 'cards'),
});

for (const picId of [100, 101, 102, 201, 3000]) {
  const t0 = Date.now();
  const png = r.render(picId);
  if (!png) { console.log(picId, 'no recipe'); continue; }
  const out = path.join(ROOT, '.audit-tmp', 'cards', 'pic-' + picId + '.png');
  console.log('pic', picId, '->', png.length + 'B', png.readUInt32BE(16) + 'x' + png.readUInt32BE(20),
    (Date.now() - t0) + 'ms');
}
console.log('stats:', JSON.stringify(r.stats));
