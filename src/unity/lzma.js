'use strict';

function lzmaDecode(src, outSize) {
  const d = src[0];
  if (d >= 225) throw new Error('Corrupt LZMA properties.');
  const lc = d % 9, lp = ((d / 9) | 0) % 5, pb = (((d / 9) | 0) / 5) | 0;
  let p = 5;
  const out = Buffer.allocUnsafe(outSize);
  let o = 0;

  let range = 0xffffffff, code = 0;
  if (src[p] !== 0) throw new Error('Corrupt LZMA data.');
  p++;
  for (let i = 0; i < 4; i++) code = ((code << 8) | src[p++]) >>> 0;

  const probs = new Uint16Array(0x300 << (lc + lp)).fill(1024);
  const isMatch = new Uint16Array(12 << 4).fill(1024);
  const isRep = new Uint16Array(12).fill(1024);
  const isRepG0 = new Uint16Array(12).fill(1024);
  const isRepG1 = new Uint16Array(12).fill(1024);
  const isRepG2 = new Uint16Array(12).fill(1024);
  const isRep0Long = new Uint16Array(12 << 4).fill(1024);
  const posSlot = new Uint16Array(4 << 6).fill(1024);
  const posSpec = new Uint16Array(115).fill(1024);
  const align = new Uint16Array(16).fill(1024);
  const mkLen = () => ({ choice: new Uint16Array(2).fill(1024), low: new Uint16Array(16 << 3).fill(1024), mid: new Uint16Array(16 << 3).fill(1024), high: new Uint16Array(256).fill(1024) });
  const lenDec = mkLen(), repLenDec = mkLen();

  function bit(arr, i) {
    const pr = arr[i];
    const bound = (range >>> 11) * pr;
    let b;
    if ((code >>> 0) < (bound >>> 0)) { range = bound >>> 0; arr[i] = pr + ((2048 - pr) >> 5); b = 0; }
    else { range = (range - bound) >>> 0; code = (code - bound) >>> 0; arr[i] = pr - (pr >> 5); b = 1; }
    if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | src[p++]) >>> 0; }
    return b;
  }
  function direct(n) {
    let r = 0;
    while (n--) {
      range >>>= 1;
      code = (code - range) >>> 0;
      const t = 0 - (code >>> 31);
      code = (code + (range & t)) >>> 0;
      r = ((r << 1) + (t + 1)) >>> 0;
      if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | src[p++]) >>> 0; }
    }
    return r;
  }
  function tree(arr, base, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | bit(arr, base + m);
    return m - (1 << bits);
  }
  function revTree(arr, base, bits) {
    let m = 1, r = 0;
    for (let i = 0; i < bits; i++) { const b = bit(arr, base + m); m = (m << 1) | b; r |= b << i; }
    return r;
  }
  function decLen(l, ps) {
    if (!bit(l.choice, 0)) return tree(l.low, ps << 3, 3);
    if (!bit(l.choice, 1)) return 8 + tree(l.mid, ps << 3, 3);
    return 16 + tree(l.high, 0, 8);
  }

  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;

  while (o < outSize) {
    const ps = o & pbMask;
    if (!bit(isMatch, (state << 4) + ps)) {
      const prev = o ? out[o - 1] : 0;
      const base = 0x300 * ((((o & lpMask) << lc) + (prev >> (8 - lc))));
      let sym = 1;
      if (state >= 7) {
        let mb = out[o - rep0 - 1];
        do {
          const mbit = (mb >> 7) & 1; mb <<= 1;
          const b = bit(probs, base + ((1 + mbit) << 8) + sym);
          sym = (sym << 1) | b;
          if (mbit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | bit(probs, base + sym);
      out[o++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len;
    if (bit(isRep, state)) {
      if (!o) throw new Error('Corrupt LZMA data.');
      if (!bit(isRepG0, state)) {
        if (!bit(isRep0Long, (state << 4) + ps)) { state = state < 7 ? 9 : 11; out[o] = out[o - rep0 - 1]; o++; continue; }
      } else {
        let dist;
        if (!bit(isRepG1, state)) dist = rep1;
        else if (!bit(isRepG2, state)) { dist = rep2; rep2 = rep1; }
        else { dist = rep3; rep3 = rep2; rep2 = rep1; }
        rep1 = rep0; rep0 = dist;
      }
      len = decLen(repLenDec, ps);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = decLen(lenDec, ps);
      state = state < 7 ? 7 : 10;
      const lenState = len < 4 ? len : 3;
      const slot = tree(posSlot, lenState << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const nb = (slot >> 1) - 1;
        rep0 = ((2 | (slot & 1)) << nb) >>> 0;
        if (slot < 14) rep0 = (rep0 + revTree(posSpec, rep0 - slot, nb)) >>> 0;
        else {
          rep0 = (rep0 + (direct(nb - 4) << 4)) >>> 0;
          rep0 = (rep0 + revTree(align, 0, 4)) >>> 0;
          if (rep0 === 0xffffffff) break;
        }
      }
    }
    len += 2;
    if (rep0 >= o) throw new Error('Corrupt LZMA data.');
    const end = Math.min(o + len, outSize);
    for (; o < end; o++) out[o] = out[o - rep0 - 1];
  }
  if (o !== outSize) throw new Error('Corrupt LZMA data.');
  return out;
}

module.exports = { lzmaDecode };

/**
 * LZMA encoder producing the format Unity's bundles use: 5 property bytes (lc=3, lp=0, pb=2,
 * dictionary size) followed by a raw range-coded stream with no size header. It is a greedy
 * hash-chain matcher with rep0 matches: not as tight as the reference encoder, but a valid stream
 * that every LZMA decoder (including Unity's) reads.
 */
function lzmaEncode(src) {
  const n = src.length;
  const LC = 3, PB = 2, PBMASK = 3, DICT = 1 << 19; // 512 KB, the dictionary size Unity's SDK builds use
  let out = Buffer.allocUnsafe(n + (n >> 1) + 1024);
  let o = 0;
  const put = (b) => { if (o === out.length) { const g = Buffer.allocUnsafe(out.length * 2); out.copy(g); out = g; } out[o++] = b; };

  out[o++] = (PB * 5) * 9 + LC; // props byte: (pb*5 + lp)*9 + lc
  out.writeUInt32LE(DICT, o); o += 4;

  let low = 0, range = 0xffffffff, cache = 0, cacheSize = 1;
  function shiftLow() {
    const lo = low >>> 0;
    if (lo < 0xff000000 || low >= 4294967296) {
      const carry = low >= 4294967296 ? 1 : 0;
      let t = cache;
      do { put((t + carry) & 0xff); t = 0xff; } while (--cacheSize);
      cache = lo >>> 24;
    }
    cacheSize++;
    low = (lo << 8) >>> 0;
  }
  function bit(arr, i, b) {
    const pr = arr[i];
    const bound = (range >>> 11) * pr;
    if (!b) { range = bound; arr[i] = pr + ((2048 - pr) >> 5); }
    else { low += bound; range = (range - bound) >>> 0; arr[i] = pr - (pr >> 5); }
    while (range < 0x1000000) { range = (range << 8) >>> 0; shiftLow(); }
  }
  function direct(v, count) {
    for (let i = count - 1; i >= 0; i--) {
      range >>>= 1;
      if ((v >>> i) & 1) low += range;
      while (range < 0x1000000) { range = (range << 8) >>> 0; shiftLow(); }
    }
  }
  function tree(arr, base, bits, v) {
    let m = 1;
    for (let i = bits - 1; i >= 0; i--) { const b = (v >>> i) & 1; bit(arr, base + m, b); m = (m << 1) | b; }
  }
  function revTree(arr, base, bits, v) {
    let m = 1;
    for (let i = 0; i < bits; i++) { const b = (v >>> i) & 1; bit(arr, base + m, b); m = (m << 1) | b; }
  }

  const probs = new Uint16Array(0x300 << LC).fill(1024);
  const mk = (len) => new Uint16Array(len).fill(1024);
  const isMatch = mk(12 << 4), isRep = mk(12), isRepG0 = mk(12), isRep0Long = mk(12 << 4);
  const posSlot = mk(4 << 6), posSpec = mk(115), align = mk(16);
  const mkLen = () => ({ choice: mk(2), low: mk(16 << 3), mid: mk(16 << 3), high: mk(256) });
  const lenEnc = mkLen(), repLenEnc = mkLen();
  function encLen(l, len, ps) {
    len -= 2;
    if (len < 8) { bit(l.choice, 0, 0); tree(l.low, ps << 3, 3, len); }
    else if (len < 16) { bit(l.choice, 0, 1); bit(l.choice, 1, 0); tree(l.mid, ps << 3, 3, len - 8); }
    else { bit(l.choice, 0, 1); bit(l.choice, 1, 1); tree(l.high, 0, 8, len - 16); }
  }

  const HASH = 1 << 20;
  const head = new Int32Array(HASH).fill(-1);
  const prev = new Int32Array(n);
  const hash = (i) => (Math.imul(src.readUInt32LE(i), 2654435761) >>> 12);
  const insert = (i) => { if (i + 4 <= n) { const h = hash(i); prev[i] = head[h]; head[h] = i; } };

  let state = 0, rep0 = 0, i = 0;
  while (i < n) {
    const ps = i & PBMASK;
    const maxLen = Math.min(273, n - i);

    // rep0 candidate
    let repLen = 0;
    if (i > rep0 && maxLen >= 2) {
      const r = i - rep0 - 1;
      while (repLen < maxLen && src[r + repLen] === src[i + repLen]) repLen++;
    }
    // hash-chain candidate
    let bestLen = 0, bestDist = 0;
    if (i + 4 <= n && maxLen >= 3) {
      let c = head[hash(i)], depth = 24;
      while (c >= 0 && depth-- && i - c <= DICT) {
        if (src[c + bestLen] === src[i + bestLen]) {
          let l = 0;
          while (l < maxLen && src[c + l] === src[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = i - c - 1; if (l === maxLen) break; }
        }
        c = prev[c];
      }
    }

    let advance;
    if (repLen >= 2 && repLen + 1 >= bestLen) {
      bit(isMatch, (state << 4) + ps, 1);
      bit(isRep, state, 1);
      bit(isRepG0, state, 0);
      bit(isRep0Long, (state << 4) + ps, 1);
      encLen(repLenEnc, repLen, ps);
      state = state < 7 ? 8 : 11;
      advance = repLen;
    } else if (bestLen >= 4 || (bestLen === 3 && bestDist < 4096)) {
      bit(isMatch, (state << 4) + ps, 1);
      bit(isRep, state, 0);
      encLen(lenEnc, bestLen, ps);
      const d = bestDist;
      let slot;
      if (d < 4) slot = d;
      else { const nb = 31 - Math.clz32(d); slot = (nb << 1) | ((d >>> (nb - 1)) & 1); }
      tree(posSlot, (bestLen - 2 < 4 ? bestLen - 2 : 3) << 6, 6, slot);
      if (slot >= 4) {
        const nb = (slot >> 1) - 1;
        const base = ((2 | (slot & 1)) << nb) >>> 0;
        const red = d - base;
        if (slot < 14) revTree(posSpec, base - slot, nb, red);
        else { direct(red >>> 4, nb - 4); revTree(align, 0, 4, red & 15); }
      }
      rep0 = d;
      state = state < 7 ? 7 : 10;
      advance = bestLen;
    } else {
      bit(isMatch, (state << 4) + ps, 0);
      const pv = i ? src[i - 1] : 0;
      const base = 0x300 * (pv >> (8 - LC));
      const byte = src[i];
      let sym = 1;
      if (state >= 7) {
        const mb = src[i - rep0 - 1];
        let matching = true;
        for (let k = 7; k >= 0; k--) {
          const b = (byte >> k) & 1;
          if (matching) {
            const mbit = (mb >> k) & 1;
            bit(probs, base + ((1 + mbit) << 8) + sym, b);
            if (mbit !== b) matching = false;
          } else bit(probs, base + sym, b);
          sym = (sym << 1) | b;
        }
      } else {
        for (let k = 7; k >= 0; k--) { const b = (byte >> k) & 1; bit(probs, base + sym, b); sym = (sym << 1) | b; }
      }
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      advance = 1;
    }
    for (let k = 0; k < advance; k++) insert(i + k);
    i += advance;
  }
  // End-of-stream marker, as Unity's own encoder writes it: a match with distance 0xFFFFFFFF
  // (pos slot 63, all direct and align bits set). Without it the stream only "maybe" finishes,
  // and strict decoders that require LZMA_STATUS_FINISHED_WITH_MARK reject the block.
  {
    const ps = n & PBMASK;
    bit(isMatch, (state << 4) + ps, 1);
    bit(isRep, state, 0);
    encLen(lenEnc, 2, ps);
    tree(posSlot, 0, 6, 63);
    direct((1 << 26) - 1, 26);
    revTree(align, 0, 4, 15);
  }
  for (let k = 0; k < 5; k++) shiftLow();
  return out.subarray(0, o);
}

module.exports.lzmaEncode = lzmaEncode;
