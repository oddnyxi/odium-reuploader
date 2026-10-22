'use strict';
// Block-compressed texture decoders -> RGBA8.
//
// Row 0 of the output is the FIRST row stored in the block data. Unity stores textures
// bottom-up, which matches WebGL's texture origin, so callers upload the result unflipped.
//
// BC1 (DXT1), BC3 (DXT5), BC4 (single channel), BC5 (two channel),
// ETC1 (also what the Crunch ETC modes emit) and ETC2 RGBA8 (EAC alpha + ETC1 colour).

const blocks = (n) => Math.max(1, (n + 3) >> 2);

// ---------- BC1 / BC3 ----------

function c565(v, out, o) {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2);
}

function colorBlock(src, p, pal, forceFour) {
  const c0 = src[p] | (src[p + 1] << 8), c1 = src[p + 2] | (src[p + 3] << 8);
  c565(c0, pal, 0); c565(c1, pal, 4); pal[3] = 255; pal[7] = 255;
  if (c0 > c1 || forceFour) {
    for (let k = 0; k < 3; k++) {
      pal[8 + k] = ((2 * pal[k] + pal[4 + k]) / 3) | 0;
      pal[12 + k] = ((pal[k] + 2 * pal[4 + k]) / 3) | 0;
    }
    pal[11] = 255; pal[15] = 255;
  } else {
    for (let k = 0; k < 3; k++) { pal[8 + k] = (pal[k] + pal[4 + k]) >> 1; pal[12 + k] = 0; }
    pal[11] = 255; pal[15] = 0;
  }
  return (src[p + 4] | (src[p + 5] << 8) | (src[p + 6] << 16) | (src[p + 7] << 24)) >>> 0;
}

// fills al[0..7] with the 8-entry alpha/BC4 palette for endpoints a0,a1
function alphaPalette(a0, a1, al) {
  al[0] = a0; al[1] = a1;
  if (a0 > a1) for (let k = 1; k <= 6; k++) al[k + 1] = (((7 - k) * a0 + k * a1) / 7) | 0;
  else { for (let k = 1; k <= 4; k++) al[k + 1] = (((5 - k) * a0 + k * a1) / 5) | 0; al[6] = 0; al[7] = 255; }
}

// reads the 16 x 3-bit indices that follow the two endpoint bytes of a BC3/BC4 alpha block
function alphaIndices(src, p, ai) {
  const lo = src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16), hi = src[p + 5] | (src[p + 6] << 8) | (src[p + 7] << 16);
  for (let k = 0; k < 8; k++) { ai[k] = (lo >> (k * 3)) & 7; ai[k + 8] = (hi >> (k * 3)) & 7; }
}

function decodeDXT(src, w, h, hasAlpha) {
  const out = new Uint8Array(w * h * 4);
  const bw = blocks(w), bh = blocks(h);
  const stride = hasAlpha ? 16 : 8;
  const pal = new Uint8Array(16), al = new Uint8Array(8), ai = new Uint8Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const p = (by * bw + bx) * stride;
      if (p + stride > src.length) return out;
      if (hasAlpha) { alphaPalette(src[p], src[p + 1], al); alphaIndices(src, p, ai); }
      let bits = colorBlock(src, p + (hasAlpha ? 8 : 0), pal, hasAlpha);
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y; if (py >= h) { bits >>>= 8; continue; }
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x, sel = bits & 3; bits >>>= 2;
          if (px >= w) continue;
          const o = (py * w + px) * 4;
          out[o] = pal[sel * 4]; out[o + 1] = pal[sel * 4 + 1]; out[o + 2] = pal[sel * 4 + 2];
          out[o + 3] = hasAlpha ? al[ai[y * 4 + x]] : pal[sel * 4 + 3];
        }
      }
    }
  }
  return out;
}

const decodeBC1 = (src, w, h) => decodeDXT(src, w, h, false);
const decodeBC3 = (src, w, h) => decodeDXT(src, w, h, true);

// ---------- BC4 / BC5 ----------

// channels: array of [blockByteOffset, outputChannel] pairs; unlisted channels get fill
function decodeBCn(src, w, h, stride, channels, fill) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; out[i + 3] = fill[3]; }
  const bw = blocks(w), bh = blocks(h);
  const al = new Uint8Array(8), ai = new Uint8Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const p = (by * bw + bx) * stride;
      if (p + stride > src.length) return out;
      for (const [off, ch] of channels) {
        alphaPalette(src[p + off], src[p + off + 1], al); alphaIndices(src, p + off, ai);
        for (let y = 0; y < 4; y++) {
          const py = by * 4 + y; if (py >= h) continue;
          for (let x = 0; x < 4; x++) {
            const px = bx * 4 + x; if (px >= w) continue;
            out[(py * w + px) * 4 + ch] = al[ai[y * 4 + x]];
          }
        }
      }
    }
  }
  return out;
}

// BC4: one channel, shown as grey
function decodeBC4(src, w, h) {
  const out = decodeBCn(src, w, h, 8, [[0, 0]], [0, 0, 0, 255]);
  for (let i = 0; i < out.length; i += 4) { out[i + 1] = out[i]; out[i + 2] = out[i]; }
  return out;
}

// BC5: first block half -> R, second -> G, B left at 0 (swap=true for YX order)
function decodeBC5(src, w, h, swap) {
  return decodeBCn(src, w, h, 16, swap ? [[0, 1], [8, 0]] : [[0, 0], [8, 1]], [0, 0, 0, 255]);
}

// ---------- ETC1 + EAC ----------

const ETC_MOD = [[2, 8, -2, -8], [5, 17, -5, -17], [9, 29, -9, -29], [13, 42, -13, -42],
  [18, 60, -18, -60], [24, 80, -24, -80], [33, 106, -33, -106], [47, 183, -47, -183]];

const EAC_MOD = [
  [-3, -6, -9, -15, 2, 5, 8, 14], [-3, -7, -10, -13, 2, 6, 9, 12], [-2, -5, -8, -13, 1, 4, 7, 12], [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11], [-3, -7, -9, -11, 2, 6, 8, 10], [-4, -7, -8, -11, 3, 6, 7, 10], [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9], [-2, -5, -8, -10, 1, 4, 7, 9], [-2, -4, -8, -10, 1, 3, 7, 9], [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9], [-1, -2, -3, -10, 0, 1, 2, 9], [-4, -6, -8, -9, 3, 5, 7, 8], [-3, -5, -7, -9, 2, 4, 6, 8],
];

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp5 = (v) => (v < 0 ? 0 : v > 31 ? 31 : v);
const ext5 = (v) => (v << 3) | (v >> 2);
const sext3 = (v) => (v < 4 ? v : v - 8);

// Decodes one ETC1 block at src[p..p+8] into px (16 * 3 bytes, index = y * 4 + x).
// Only the individual and differential modes exist in ETC1. Crunch never produces the
// extra ETC2 modes (T / H / planar), so a differential overflow is clamped rather than reinterpreted.
function etc1Block(src, p, px) {
  const b0 = src[p], b1 = src[p + 1], b2 = src[p + 2], b3 = src[p + 3];
  const flip = b3 & 1, diff = (b3 >> 1) & 1, cw0 = (b3 >> 5) & 7, cw1 = (b3 >> 2) & 7;
  let r0, g0, bl0, r1, g1, bl1;
  if (diff) {
    const R = b0 >> 3, G = b1 >> 3, B = b2 >> 3;
    r0 = ext5(R); g0 = ext5(G); bl0 = ext5(B);
    r1 = ext5(clamp5(R + sext3(b0 & 7))); g1 = ext5(clamp5(G + sext3(b1 & 7))); bl1 = ext5(clamp5(B + sext3(b2 & 7)));
  } else {
    r0 = (b0 >> 4) * 17; r1 = (b0 & 15) * 17;
    g0 = (b1 >> 4) * 17; g1 = (b1 & 15) * 17;
    bl0 = (b2 >> 4) * 17; bl1 = (b2 & 15) * 17;
  }
  const sel = ((src[p + 4] << 24) | (src[p + 5] << 16) | (src[p + 6] << 8) | src[p + 7]) >>> 0;
  for (let j = 0; j < 16; j++) {
    const x = j >> 2, y = j & 3;
    const idx = ((sel >>> j) & 1) | (((sel >>> (j + 16)) & 1) << 1);
    const second = flip ? (y >> 1) : (x >> 1);
    const m = ETC_MOD[second ? cw1 : cw0][idx];
    const o = (y * 4 + x) * 3;
    px[o] = clamp8((second ? r1 : r0) + m);
    px[o + 1] = clamp8((second ? g1 : g0) + m);
    px[o + 2] = clamp8((second ? bl1 : bl0) + m);
  }
}

// Decodes one EAC alpha block at src[p..p+8] into a (16 bytes, index = y * 4 + x)
function eacBlock(src, p, a) {
  const base = src[p], mult = src[p + 1] >> 4, table = EAC_MOD[src[p + 1] & 15];
  const hi = (src[p + 2] << 16) | (src[p + 3] << 8) | src[p + 4];
  const lo = (src[p + 5] << 16) | (src[p + 6] << 8) | src[p + 7];
  for (let i = 0; i < 16; i++) {
    const idx = i < 8 ? (hi >> (21 - 3 * i)) & 7 : (lo >> (21 - 3 * (i - 8))) & 7;
    const x = i >> 2, y = i & 3; // pixels are stored column-major
    a[y * 4 + x] = clamp8(base + mult * table[idx]);
  }
}

function decodeETC(src, w, h, withAlpha) {
  const out = new Uint8Array(w * h * 4);
  const bw = blocks(w), bh = blocks(h), stride = withAlpha ? 16 : 8;
  const px = new Uint8Array(48), al = new Uint8Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const p = (by * bw + bx) * stride;
      if (p + stride > src.length) return out;
      if (withAlpha) eacBlock(src, p, al);
      etc1Block(src, p + (withAlpha ? 8 : 0), px);
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y; if (py >= h) continue;
        for (let x = 0; x < 4; x++) {
          const pxx = bx * 4 + x; if (pxx >= w) continue;
          const o = (py * w + pxx) * 4, s = (y * 4 + x) * 3;
          out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2];
          out[o + 3] = withAlpha ? al[y * 4 + x] : 255;
        }
      }
    }
  }
  return out;
}

const decodeETC1 = (src, w, h) => decodeETC(src, w, h, false);
const decodeETC2RGBA8 = (src, w, h) => decodeETC(src, w, h, true);

module.exports = { decodeBC1, decodeBC3, decodeBC4, decodeBC5, decodeETC1, decodeETC2RGBA8, etc1Block, eacBlock };
