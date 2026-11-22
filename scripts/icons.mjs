#!/usr/bin/env node
// Genera le icone PNG della PWA (stesso disegno di public/icons/icon.svg: goccia bianca
// con fiamma verde su fondo verde) senza dipendenze, con un piccolo encoder PNG.
//   node scripts/icons.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'public', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Goccia in coordinate 0..512: cerchio (centro 256,304 raggio r) + punta verso l'alto in (256,top)
function inDrop(x, y, r, top) {
  const cx = 256, cy = 304;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  if (y < top || y > cy) return false;
  // punta: le tangenti dal vertice al cerchio
  const h = cy - top;
  const half = (r * (y - top)) / h;
  return Math.abs(x - cx) <= half;
}

function draw(size, { maskable }) {
  const GREEN = [15, 107, 63, 255], WHITE = [255, 255, 255, 255], LIGHT = [47, 168, 106, 255];
  const ss = 3; // supersampling per bordi morbidi
  const scale = maskable ? 0.72 : 1; // le icone maskable tengono il disegno nella zona sicura
  return png(size, (px, py) => {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) {
      for (let sx = 0; sx < ss; sx++) {
        const u = ((px + (sx + 0.5) / ss) / size) * 512;
        const v = ((py + (sy + 0.5) / ss) / size) * 512;
        let c;
        // sfondo: quadrato arrotondato (pieno per le maskable)
        const rr = 96, inBg = maskable ||
          (Math.max(Math.abs(u - 256) - (256 - rr), 0) ** 2 + Math.max(Math.abs(v - 256) - (256 - rr), 0) ** 2 <= rr * rr);
        if (!inBg) c = [0, 0, 0, 0];
        else {
          const x = 256 + (u - 256) / scale, y = 256 + (v - 256) / scale;
          if (inDrop(x, y, 58, 214)) c = LIGHT;
          else if (inDrop(x, y, 120, 84)) c = WHITE;
          else c = GREEN;
        }
        acc = acc.map((a, i) => a + c[i]);
      }
    }
    return acc.map((a) => Math.round(a / (ss * ss)));
  });
}

await mkdir(OUT, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false], ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true], ['icon-180.png', 180, true],
]) {
  await writeFile(join(OUT, name), draw(size, { maskable }));
  console.log(`public/icons/${name}`);
}
