/**
 * make-icons.mjs — generate the app icons, with no image libraries.
 *
 *   node tools/make-icons.mjs
 *
 * The icons are rendered here rather than committed as opaque binaries, so the
 * artwork stays reviewable and reproducible. PNG encoding is done by hand on top
 * of Node's zlib: an 8-bit RGBA image is just filtered scanlines wrapped in
 * IHDR/IDAT/IEND chunks.
 *
 * Artwork: the same eight-pointed khatim star as the brand mark, gold on deep
 * emerald. The maskable variant insets the art so Android's adaptive masks
 * (circle, squircle, rounded square) can never crop it.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'icons');

/* ── PNG encoding ──────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {Uint8Array} rgba length must be width*height*4 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: truecolour with alpha
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── Drawing ───────────────────────────────────────────────────────────── */

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** Vertices of an n-pointed star, matching the mark used across the UI. */
function starVertices(cx, cy, outer, inner, points, rotationDeg) {
  const pts = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((i * 180) / points + rotationDeg - 90) * (Math.PI / 180);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Standard even-odd ray cast. */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const BG_INNER = [13, 59, 46];     // #0d3b2e
const BG_OUTER = [4, 20, 15];      // #04140f
const GOLD_HI = [247, 231, 187];   // #f7e7bb
const GOLD_MID = [217, 178, 95];   // #d9b25f
const GOLD_LO = [150, 104, 42];    // #96682a
const RING = [217, 178, 95];

/**
 * @param {number} size
 * @param {{art: number, flatten?: boolean}} opts
 *   art     — art radius as a fraction of size (smaller = more maskable padding)
 *   flatten — drop the alpha channel to fully opaque (iOS ignores nothing, but
 *             transparent apple-touch icons render with a black plate)
 */
function render(size, { art = 0.36, flatten = false } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const ss = 3;                                   // 3x3 supersampling
  const cx = size / 2;
  const cy = size / 2;

  const outer = size * art;
  const inner = outer * 0.425;
  const star = starVertices(cx, cy, outer, inner, 8, 22.5);
  const ringR = outer * 1.19;
  const ringW = size * 0.016;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;

      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;

          const dist = Math.hypot(px - cx, py - cy);
          // Radial emerald background.
          let col = mix(BG_INNER, BG_OUTER, Math.min(1, (dist / (size * 0.72)) ** 1.15));
          let alpha = 1;

          if (Math.abs(dist - ringR) <= ringW / 2) col = mix(col, RING, 0.55);

          if (inPolygon(px, py, star)) {
            // Gold, lighter at the top so the star reads as a solid object.
            const t = (py - (cy - outer)) / (2 * outer);
            col = t < 0.5 ? mix(GOLD_HI, GOLD_MID, t * 2) : mix(GOLD_MID, GOLD_LO, (t - 0.5) * 2);
          }

          if (flatten && alpha === 1) col = mix(col, BG_OUTER, 0);   // no-op, keeps intent explicit
          r += col[0]; g += col[1]; b += col[2]; a += alpha;
        }
      }

      const n = ss * ss;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = flatten ? 255 : Math.round((a / n) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ── Emit ──────────────────────────────────────────────────────────────── */

mkdirSync(OUT, { recursive: true });

const files = [
  // Standard "any" icons: full-bleed art, the OS applies its own shape.
  ['icon-192.png', 192, { art: 0.36 }],
  ['icon-512.png', 512, { art: 0.36 }],
  // Maskable: art inset to sit inside the 80% safe circle, opaque all the way out.
  ['maskable-192.png', 192, { art: 0.27, flatten: true }],
  ['maskable-512.png', 512, { art: 0.27, flatten: true }],
  // iOS home-screen icon: 180px, must be opaque.
  ['apple-touch-icon.png', 180, { art: 0.36, flatten: true }],
  // Favicon for browsers without manifest support.
  ['favicon-64.png', 64, { art: 0.38 }],
];

let total = 0;
for (const [name, size, opts] of files) {
  const png = render(size, opts);
  writeFileSync(resolve(OUT, name), png);
  total += png.length;
  console.log(`  ${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

console.log(`\n${files.length} ikon ditulis ke icons/ (${(total / 1024).toFixed(1)} KB)`);
