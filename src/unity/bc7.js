
'use strict';
// BC7 (BPTC) decoder, all eight modes. Output is RGBA8, row 0 = bottom row (Unity's origin).

// Partition maps: 16 pixels x 2 bits per subset index, packed into one number per partition.
const PART2 = [1347440720, 1077952576, 1414812756, 1414549568, 1346387968, 1431589968, 1431588928, 1414545408, 1346371584, 1431655504, 1431584768, 1413480448, 1431655488, 1431633920, 1431655680, 1426063360, 1427439872, 16468, 352387072, 4214868, 16464, 352649472, 83951616, 1079005268, 4210768, 83951872, 336860180, 85202000, 18175040, 5592320, 352403540, 88162640, 1145324612, 1426085120, 289673540, 84234320, 89130320, 286344260, 1091846420, 1141969220, 352669780, 17125440, 84152400, 88428880, 339820820, 1342506320, 1094784020, 1315840, 267524, 1070096, 273944576, 68486144, 1346438420, 1090851920, 88166420, 335888720, 1090848020, 1095782420, 1073812820, 1410662720, 1347441920, 5591120, 353701904, 1414792196];
const PART3 = [2858963024, 1784303680, 1515864576, 1414570152, 2779054080, 2694860880, 1431675040, 1515868240, 2857697280, 2857719040, 2863289600, 2425393296, 2492765332, 2762253476, 2846200912, 705315408, 2777960512, 172118100, 2779096320, 1436590240, 2829603924, 1785348160, 2762231808, 437912832, 5285028, 2862977168, 342452500, 1768494080, 2693105056, 2860651540, 1352967248, 1784283648, 2846195712, 1351655592, 2829094992, 606348324, 11162880, 613566756, 608801316, 1352993360, 1342874960, 2863285316, 1717960704, 2778768800, 1352683680, 1764256040, 1152035396, 1717986816, 2856600644, 1420317864, 2508232064, 2526451200, 2824098984, 2157286784, 2853442580, 2526412800, 2863272980, 2689618080, 2695210400, 2516582400, 1082146944, 2846402984, 2863311428, 709513812];
// Index of the pixel whose index has an implied leading zero, per partition.
const ANCHOR2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const ANCHOR3A = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const ANCHOR3B = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];

const W2 = [0, 21, 43, 64];
const W3 = [0, 9, 18, 27, 37, 46, 55, 64];
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const WEIGHTS = [null, null, W2, W3, W4];

// ns subsets, partition bits, rotation bits, index-select bit, colour bits, alpha bits,
// per-endpoint p-bit, shared p-bit, index bits, secondary index bits
const MODES = [
  { ns: 3, pb: 4, rb: 0, isb: 0, cb: 4, ab: 0, epb: 1, spb: 0, ib: 3, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 6, ab: 0, epb: 0, spb: 1, ib: 3, ib2: 0 },
  { ns: 3, pb: 6, rb: 0, isb: 0, cb: 5, ab: 0, epb: 0, spb: 0, ib: 2, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 7, ab: 0, epb: 1, spb: 0, ib: 2, ib2: 0 },
  { ns: 1, pb: 0, rb: 2, isb: 1, cb: 5, ab: 6, epb: 0, spb: 0, ib: 2, ib2: 3 },
  { ns: 1, pb: 0, rb: 2, isb: 0, cb: 7, ab: 8, epb: 0, spb: 0, ib: 2, ib2: 2 },
  { ns: 1, pb: 0, rb: 0, isb: 0, cb: 7, ab: 7, epb: 1, spb: 0, ib: 4, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 5, ab: 5, epb: 1, spb: 0, ib: 2, ib2: 0 },
];

const lerp = (a, b, w) => (((64 - w) * a + w * b + 32) >> 6);
const unquant = (v, bits) => (bits >= 8 ? v : ((v << (8 - bits)) | (v >> (2 * bits - 8))));

function decodeBlock(src, p, px) {
  let pos = 0;
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v |= ((src[p + (pos >> 3)] >> (pos & 7)) & 1) << i;
    return v;
  };
  let mode = 0;
  while (mode < 8 && !bits(1)) mode++;
  if (mode >= 8) { px.fill(0); return; } // reserved: transparent black, as the spec requires
  const m = MODES[mode];
  const part = bits(m.pb);
  const rot = bits(m.rb);
  const sel = bits(m.isb);

  const ep = []; // ep[subset*2 + end] = [r, g, b, a]
  for (let i = 0; i < m.ns * 2; i++) ep.push([0, 0, 0, 255]);
  for (let ch = 0; ch < 3; ch++) for (let i = 0; i < m.ns * 2; i++) ep[i][ch] = bits(m.cb);
  if (m.ab) for (let i = 0; i < m.ns * 2; i++) ep[i][3] = bits(m.ab);
  const pbit = [];
  if (m.epb) for (let i = 0; i < m.ns * 2; i++) pbit.push(bits(1));
  else if (m.spb) for (let i = 0; i < m.ns; i++) { const b = bits(1); pbit.push(b, b); }
  const hasP = pbit.length > 0;
  const cbits = m.cb + (hasP ? 1 : 0);
  const abits = m.ab + (hasP && m.ab ? 1 : 0);
  for (let i = 0; i < m.ns * 2; i++) {
    const e = ep[i];
    for (let ch = 0; ch < 3; ch++) e[ch] = unquant(hasP ? (e[ch] << 1) | pbit[i] : e[ch], cbits);
    if (m.ab) e[3] = unquant(hasP ? (e[3] << 1) | pbit[i] : e[3], abits);
  }

  const subsetOf = (i) => (m.ns === 1 ? 0 : m.ns === 2 ? (PART2[part] >>> (2 * i)) & 3 : (PART3[part] >>> (2 * i)) & 3);
  const anchor = (s) => (s === 0 ? 0 : m.ns === 2 ? ANCHOR2[part] : s === 1 ? ANCHOR3A[part] : ANCHOR3B[part]);
  const readIdx = (nbits) => {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { const s = subsetOf(i); out[i] = bits(i === anchor(s) ? nbits - 1 : nbits); }
    return out;
  };
  const idx = readIdx(m.ib);
  const idx2 = m.ib2 ? readIdx(m.ib2) : null;

  for (let i = 0; i < 16; i++) {
    const s = subsetOf(i);
    const e0 = ep[s * 2], e1 = ep[s * 2 + 1];
    let ci = idx[i], cw = WEIGHTS[m.ib], ai = ci, aw = cw;
    if (idx2) {
      if (sel) { ci = idx2[i]; cw = WEIGHTS[m.ib2]; ai = idx[i]; aw = WEIGHTS[m.ib]; }
      else { ai = idx2[i]; aw = WEIGHTS[m.ib2]; }
    }
    let r = lerp(e0[0], e1[0], cw[ci]), g = lerp(e0[1], e1[1], cw[ci]), b = lerp(e0[2], e1[2], cw[ci]);
    let a = m.ab ? lerp(e0[3], e1[3], aw[ai]) : 255;
    if (rot === 1) [r, a] = [a, r];
    else if (rot === 2) [g, a] = [a, g];
    else if (rot === 3) [b, a] = [a, b];
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a;
  }
}

/** @returns {Uint8Array} RGBA8, row 0 = bottom (the order Unity stores block rows in). */
function decodeBC7(src, w, h) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const out = new Uint8Array(w * h * 4);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      decodeBlock(src, (by * bw + bx) * 16, px);
      for (let y = 0; y < 4; y++) {
        const oy = by * 4 + y;
        if (oy >= h) break;
        for (let x = 0; x < 4; x++) {
          const ox = bx * 4 + x;
          if (ox >= w) break;
          // within a block, row 0 of the block is its lowest row, like the rest of the file
          const o = (oy * w + ox) * 4, s = (y * 4 + x) * 4;
          out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = px[s + 3];
        }
      }
    }
  }
  return out;
}

module.exports = { decodeBC7 };
