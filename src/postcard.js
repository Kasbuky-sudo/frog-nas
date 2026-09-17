'use strict';
/**
 * Postcard composer: renders a 500x350 PNG from a Picture id, using the game's own
 * artwork, so a push notification can carry an actual postcard image.
 *
 * Why this exists: the CLIENT never composes a postcard. Its album code reads
 * `ResourcesDB[layer[0]]`, sets each bitmap's x/y from the layer entry and calls
 * drawToTexture(500x350). The composition table (data/picture-layers.json) is a
 * reconstruction the offline engine ships, and the artwork is the shipped PNGs --
 * so the same recipe can be run here.
 *
 * Dependency-free on purpose (the image is a nice-to-have, not a dependency
 * budget): a small PNG reader for the formats this game actually ships
 * (8-bit RGB/RGBA, non-interlaced -- 2850 + 338 of 3231 files) plus zlib, which
 * is in Node's standard library. Anything the reader cannot handle is skipped
 * rather than throwing, so a postcard may come out with a missing layer instead of
 * failing the notification.
 *
 * Rendering is cached in data/cache/postcards/ because a postcard's bytes depend
 * only on its pic_id.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WIDTH = 500;
const HEIGHT = 350;

/** Minimal PNG decode for 8-bit truecolour (type 2) and truecolour+alpha (type 6). */
function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let w = 0, h = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length - 8) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!w || !h || interlace !== 0) return null;
  if (depth !== 8 && !(colorType === 3 && depth <= 8)) return null;
  if (![0, 2, 3, 6].includes(colorType)) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); }
  catch (e) { return null; }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride);
    rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xff;
          break;
        }
        default: return null;
      }
      cur[x] = v;
    }
  }

  // Normalise to RGBA.
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp, d = i * 4;
    if (colorType === 6) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3];
    } else if (colorType === 2) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = 255;
    } else if (colorType === 3 && palette) {
      const idx = out[s];
      rgba[d] = palette[idx * 3] || 0;
      rgba[d + 1] = palette[idx * 3 + 1] || 0;
      rgba[d + 2] = palette[idx * 3 + 2] || 0;
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255;
    }
  }
  return { w, h, rgba };
}

/** Alpha-composite `src` onto `dst` at (ox, oy). */
function blit(dst, dstW, dstH, src, ox, oy) {
  for (let y = 0; y < src.h; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dstH) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dstW) continue;
      const s = (y * src.w + x) * 4;
      const d = (dy * dstW + dx) * 4;
      const sa = src.rgba[s + 3] / 255;
      if (sa === 0) continue;
      // The game blends with normal alpha (Egret's default blend mode).
      dst[d] = Math.round(src.rgba[s] * sa + dst[d] * (1 - sa));
      dst[d + 1] = Math.round(src.rgba[s + 1] * sa + dst[d + 1] * (1 - sa));
      dst[d + 2] = Math.round(src.rgba[s + 2] * sa + dst[d + 2] * (1 - sa));
      dst[d + 3] = Math.min(255, Math.round(255 * sa + dst[d + 3] * (1 - sa)));
    }
  }
}

/** Encode RGBA bytes as a PNG (filter 0 on every row). */
function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

class PostcardRenderer {
  /**
   * @param {object} opts
   * @param {import('./gamedata').GameData} opts.gd
   * @param {string} opts.imageRoot   vendor/resource/China/images
   * @param {string} [opts.cacheDir]  where rendered PNGs are kept
   */
  constructor(opts) {
    this.gd = opts.gd;
    this.imageRoot = opts.imageRoot;
    this.cacheDir = opts.cacheDir || null;
    if (this.cacheDir) fs.mkdirSync(this.cacheDir, { recursive: true });
    // The layer table is not exposed through GameData (it is engine data, not a
    // game table), so it is read here from the same bundle the engine runs.
    this.layers = null;
    this.resourceList = null;
    this.stats = { rendered: 0, cached: 0, skipped: 0 };
  }

  ensureLayers() {
    if (this.layers) return;
    const fsMod = require('./gamedata');
    const src = fs.readFileSync(
      path.join(this.imageRoot, '..', '..', '..', 'game', '__offline-engine.js'), 'utf8');
    this.layers = fsMod.extractModuleLiteral(src, './data/picture-layers.json');
    const table = this.gd.tables.resources || {};
    // ResourcesDB is an object keyed by index; the client indexes it positionally.
    this.resourceList = Object.keys(table)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => table[k]);
  }

  resourceName(layerId) {
    this.ensureLayers();
    return this.resourceList[Number(layerId)] || null;
  }

  /** Decoded-image cache, keyed by resource path: a postcard shares many layers. */
  loadImage(resourceName) {
    this.imgCache = this.imgCache || new Map();
    if (this.imgCache.has(resourceName)) return this.imgCache.get(resourceName);
    const file = path.join(this.imageRoot, resourceName + '.png');
    let img = null;
    try {
      img = decodePng(fs.readFileSync(file));
    } catch (e) {
      img = null;
    }
    if (!img) this.stats.skipped++;
    this.imgCache.set(resourceName, img);
    if (this.imgCache.size > 600) {
      // Keep the cache bounded; postcards share a small working set.
      const first = this.imgCache.keys().next().value;
      this.imgCache.delete(first);
    }
    return img;
  }

  /** @returns {Buffer|null} PNG bytes for a Picture id. */
  render(picId) {
    const id = String(picId);
    if (this.cacheDir) {
      const cached = path.join(this.cacheDir, 'pic-' + id + '.png');
      try {
        const buf = fs.readFileSync(cached);
        this.stats.cached++;
        return buf;
      } catch (e) { /* render it */ }
    }
    this.ensureLayers();
    const recipe = this.layers[id];
    if (!recipe) return null;

    const canvas = Buffer.alloc(WIDTH * HEIGHT * 4);   // transparent, like drawToTexture
    for (const entry of recipe.layers || []) {
      const spec = entry.layer || entry;
      const name = this.resourceName(spec[0]);
      if (!name) continue;
      const img = this.loadImage(name);
      if (!img) continue;
      const scale = Number(entry.scale) > 0 ? Number(entry.scale) : 1;
      const draw = scale === 1 ? img : scaleImage(img, scale);
      blit(canvas, WIDTH, HEIGHT, draw, Number(spec[1]) || 0, Number(spec[2]) || 0);
    }
    const png = encodePng(canvas, WIDTH, HEIGHT);
    this.stats.rendered++;
    if (this.cacheDir) {
      try { fs.writeFileSync(path.join(this.cacheDir, 'pic-' + id + '.png'), png); }
      catch (e) { /* a cache miss next time is fine */ }
    }
    return png;
  }
}

/** Nearest-neighbour scale (only used when a layer carries an explicit scale). */
function scaleImage(img, scale) {
  const w = Math.max(1, Math.round(img.w * scale));
  const h = Math.max(1, Math.round(img.h * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.h - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.w - 1, Math.floor(x / scale));
      const s = (sy * img.w + sx) * 4, d = (y * w + x) * 4;
      out[d] = img.rgba[s]; out[d + 1] = img.rgba[s + 1];
      out[d + 2] = img.rgba[s + 2]; out[d + 3] = img.rgba[s + 3];
    }
  }
  return { w, h, rgba: out };
}

module.exports = { PostcardRenderer, decodePng, encodePng, WIDTH, HEIGHT };
