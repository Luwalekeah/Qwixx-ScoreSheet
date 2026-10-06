// One-off placeholder icon generator. Produces flat solid-colour PNGs so the
// PWA manifest and service worker precache have real files to point at.
// Replace with real artwork before shipping to users.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makePng(size, [r, g, b], padding = 0, fg = null) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = size * 3;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  const innerStart = padding;
  const innerEnd = size - padding;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type none
    for (let x = 0; x < size; x++) {
      const isInner = fg && x >= innerStart && x < innerEnd && y >= innerStart && y < innerEnd;
      const color = isInner ? fg : [r, g, b];
      const px = rowStart + 1 + x * 3;
      raw[px] = color[0];
      raw[px + 1] = color[1];
      raw[px + 2] = color[2];
    }
  }

  const idat = deflateSync(raw);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const navy = [15, 23, 42]; // #0f172a, matches theme_color
const white = [248, 250, 252]; // #f8fafc

writeFileSync(join(outDir, 'icon-192.png'), makePng(192, navy, 40, white));
writeFileSync(join(outDir, 'icon-512.png'), makePng(512, navy, 106, white));
// Maskable icons need extra safe-zone padding so the OS mask never clips
// the foreground.
writeFileSync(join(outDir, 'maskable-512.png'), makePng(512, navy, 128, white));

console.log('Generated placeholder icons in', outDir);
