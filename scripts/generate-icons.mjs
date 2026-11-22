// Zero-dependency Apple Squircle Stopwatch Icon Generator (PNG + multi-res Windows ICO).
// Generates 32x32, 64x64, 128x128, 256x256 anti-aliased RGBA PNGs and src-tauri/icons/icon.ico.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------ Minimal Valid PNG Encoder --

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([len, tag, data, crcBuf]);
}

function encodePngRgba(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------- Anti-Aliased Apple Stopwatch SDF --

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4; // 4x4 supersampling for silky Apple edges
  const invN = 1 / (samples * samples);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = ((x + (sx + 0.5) / samples) / size) * 2 - 1; // [-1, 1]
          const v = ((y + (sy + 0.5) / samples) / size) * 2 - 1;

          // Apple squircle outer body
          const dBox = sdRoundedBox(u, v, 0.90, 0.90, 0.40);
          if (dBox > 0) continue;

          // Deep charcoal gradient (#2c2c2e top -> #161618 bottom)
          const grad = clamp01((v + 0.9) / 1.8);
          let cr = 46 - 24 * grad;
          let cg = 46 - 24 * grad;
          let cb = 50 - 25 * grad;

          // Subtle top hairline sheen inside squircle
          if (dBox > -0.045 && v < 0) {
            const sheen = clamp01((-v) * 0.45);
            cr += 28 * sheen;
            cg += 28 * sheen;
            cb += 32 * sheen;
          }

          // Stopwatch body centered slightly lower (cx=0, cy=0.07)
          const cx = 0.0;
          const cy = 0.07;
          const distCenter = Math.hypot(u - cx, v - cy);

          // Top crown button & stem
          const dCrown = sdRoundedBox(u, v + 0.57, 0.145, 0.055, 0.045);
          const dStem = sdRoundedBox(u, v + 0.47, 0.042, 0.065, 0.01);
          // Angled side pusher (top-right ~45 deg)
          const dPush = sdSegment(u, v, 0.34, -0.27, 0.45, -0.38) - 0.048;

          // Main white bezel ring
          const dRing = Math.abs(distCenter - 0.44) - 0.062;

          // Stopwatch precision hand pointing to ~1:30
          const dHand = sdSegment(u, v, cx, cy, cx + 0.22, cy - 0.22) - 0.042;
          // 12 o'clock tick inside dial
          const dTick = sdSegment(u, v, cx, cy - 0.30, cx, cy - 0.23) - 0.025;
          // Center Apple Blue pivot dot (#0071e3)
          const dPivot = distCenter - 0.095;

          const whiteMask = Math.min(dRing, dCrown, dStem, dPush, dTick);
          if (whiteMask <= 0) {
            cr = 250; cg = 250; cb = 252;
          }
          if (dHand <= 0) {
            cr = 10; cg = 132; cb = 255; // Apple Blue hand (#0a84ff)
          }
          if (dPivot <= 0) {
            cr = 255; cg = 255; cb = 255;
            if (distCenter < 0.052) {
              cr = 10; cg = 132; cb = 255;
            }
          }

          rAcc += cr;
          gAcc += cg;
          bAcc += cb;
          aAcc += 255;
        }
      }

      const idx = (y * size + x) * 4;
      const alpha = aAcc * invN;
      if (alpha > 0.5) {
        const invA = 255 / aAcc;
        rgba[idx] = Math.round(clamp01((rAcc * invA) / 255) * 255);
        rgba[idx + 1] = Math.round(clamp01((gAcc * invA) / 255) * 255);
        rgba[idx + 2] = Math.round(clamp01((bAcc * invA) / 255) * 255);
        rgba[idx + 3] = Math.round(alpha);
      }
    }
  }
  return encodePngRgba(size, size, rgba);
}

// ------------------------------------------------- Multi-Res Windows ICO -----

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type = 1 (ICO)
  header.writeUInt16LE(count, 4);

  let offset = header.length;
  for (let i = 0; i < count; i++) {
    const { size, png } = entries[i];
    const base = 6 + i * 16;
    header[base] = size >= 256 ? 0 : size;
    header[base + 1] = size >= 256 ? 0 : size;
    header[base + 2] = 0; // palette
    header[base + 3] = 0;
    header.writeUInt16LE(1, base + 4);  // planes
    header.writeUInt16LE(32, base + 6); // bpp
    header.writeUInt32LE(png.length, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

const p32 = renderIcon(32);
const p64 = renderIcon(64);
const p128 = renderIcon(128);
const p256 = renderIcon(256);

fs.writeFileSync(path.join(OUT_DIR, '32x32.png'), p32);
fs.writeFileSync(path.join(OUT_DIR, '128x128.png'), p128);
fs.writeFileSync(path.join(OUT_DIR, '128x128@2x.png'), p256);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), p256);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco([
  { size: 32, png: p32 },
  { size: 64, png: p64 },
  { size: 128, png: p128 },
  { size: 256, png: p256 },
]));

console.log('Generated Apple Stopwatch icons in', OUT_DIR);
