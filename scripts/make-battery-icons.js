#!/usr/bin/env node
/*
 * Draw images/Battery0.png .. Battery6.png - the battery level icon, 0 to 6 bars.
 *
 * These were previously screenshots, which left four problems: a tooltip reading "battery icon" was
 * baked into the bottom-left corner of every one of them; Battery0 was 298x158 while the rest were
 * 68x35, so it rendered softer than its siblings at the same size; Battery5 and Battery6 had their
 * contents swapped, so the fullest icon showed five bars and the one below it six; and the whole
 * image was opaque near-white, which shows as a white box on a coloured card.
 *
 * Drawing them instead fixes all four and makes the set reproducible. Run from the client directory:
 *   node scripts/make-battery-icons.js
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 68, H = 35, SS = 4;              // supersample, then box-filter down, so edges are smooth
const BLACK = [0, 0, 0];
const BAR = [0x35, 0x35, 0x36];            // the grey the originals used for a bar

// Geometry, in final pixels, taken from the icons being replaced
const BODY = { x0: 0, y0: 0, x1: 60, y1: 34, stroke: 4 };
const NUB = { x0: 64, y0: 10, x1: 67, y1: 24 };   // detached from the body, as the originals had it
const BARS = { x: 8, w: 4, pitch: 8, y0: 6, y1: 28 };

function draw(bars) {
  const w = W * SS, h = H * SS;
  const px = new Uint8Array(w * h * 4);            // transparent, so the card colour shows through
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0 * SS; y < (y1 + 1) * SS; y++) {
      for (let x = x0 * SS; x < (x1 + 1) * SS; x++) {
        const i = (y * w + x) * 4;
        px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = 255;
      }
    }
  };
  const s = BODY.stroke - 1;
  fill(BODY.x0, BODY.y0, BODY.x1, BODY.y0 + s, BLACK);          // top
  fill(BODY.x0, BODY.y1 - s, BODY.x1, BODY.y1, BLACK);          // bottom
  fill(BODY.x0, BODY.y0, BODY.x0 + s, BODY.y1, BLACK);          // left
  fill(BODY.x1 - s, BODY.y0, BODY.x1, BODY.y1, BLACK);          // right
  fill(NUB.x0, NUB.y0, NUB.x1, NUB.y1, BLACK);
  for (let i = 0; i < bars; i++) {
    const x = BARS.x + (i * BARS.pitch);
    fill(x, BARS.y0, x + BARS.w - 1, BARS.y1, BAR);
  }

  // Box-filter down: the average of each SSxSS block, alpha included so edges fade rather than jag
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = (((y * SS) + dy) * w + (x * SS) + dx) * 4;
          const alpha = px[i+3];
          r += px[i] * alpha; g += px[i+1] * alpha; b += px[i+2] * alpha; a += alpha;
        }
      }
      const o = (y * W + x) * 4;
      out[o]   = a ? Math.round(r / a) : 0;    // un-premultiply, so a soft edge keeps its colour
      out[o+1] = a ? Math.round(g / a) : 0;
      out[o+2] = a ? Math.round(b / a) : 0;
      out[o+3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

// ---- PNG ----
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}
function png(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA, no interlace
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0;                                          // filter 0: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (let bars = 0; bars <= 6; bars++) {
  const file = `images/Battery${bars}.png`;
  writeFileSync(file, png(draw(bars)));
  console.log(`${file}  ${W}x${H}  ${bars} bar${bars === 1 ? '' : 's'}`);
}
