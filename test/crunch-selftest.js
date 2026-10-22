'use strict';
// Crunch decoder self-test.
//
// There is no reference .crn sample or reference decoder in this repo, so this test contains a small
// Crunch *encoder* for the Unity bitstream (fixed or hand-built Huffman codes, random palettes and block
// layouts) and checks that CrunchTexture reproduces exactly the blocks the encoder meant. It validates
// the bit reader, Huffman tables, header parsing, palette decoding, the reference/delta state machine and
// odd-sized mip levels. It cannot prove agreement with Unity's real files: that still needs a real sample.
const assert = require('assert');
const { CrunchTexture, CrunchError, Format, Codec, HuffModel } = require('../src/unity/crunch');
const blockdec = require('../src/unity/blockdec');

let seed = 12345;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };

// ---------------------------------------------------------------- encoder pieces

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  put(v, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >>> i) & 1);
      if (++this.n === 8) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  finish() {
    if (this.n) { this.bytes.push((this.acc << (8 - this.n)) & 0xFF); this.acc = 0; this.n = 0; }
    this.bytes.push(0, 0, 0, 0); // the decoder pre-reads a few bytes past the last symbol
    return Buffer.from(this.bytes);
  }
}

function canonicalCodes(sizes) {
  const count = new Array(17).fill(0);
  for (const s of sizes) if (s) count[s]++;
  const next = new Array(17).fill(0);
  let code = 0;
  for (let len = 1; len <= 16; len++) { code = (code + count[len - 1]) << 1; next[len] = code; }
  return sizes.map((s) => (s ? next[s]++ : -1));
}

// Writes a static Huffman table (code lengths, run-length coded) and returns encode(sym).
function writeModel(bw, sizes) {
  bw.put(sizes.length, 14);
  bw.put(21, 5);
  for (let i = 0; i < 21; i++) bw.put(5, 3); // every code-length symbol gets a 5-bit code equal to its index
  for (let i = 0; i < sizes.length;) {
    let run = 1;
    while (i + run < sizes.length && sizes[i + run] === sizes[i]) run++;
    const v = sizes[i];
    if (v === 0 && run >= 3) {
      const len = Math.min(run, 138);
      if (len <= 10) { bw.put(17, 5); bw.put(len - 3, 3); } else { bw.put(18, 5); bw.put(len - 11, 7); }
      i += len;
    } else if (v !== 0 && i > 0 && sizes[i - 1] === v && run >= 3) {
      const len = Math.min(run, 70);
      if (len <= 6) { bw.put(19, 5); bw.put(len - 3, 2); } else { bw.put(20, 5); bw.put(len - 7, 6); }
      i += len;
    } else { bw.put(v, 5); i++; }
  }
  const codes = canonicalCodes(sizes);
  return (sym) => { assert(sizes[sym], 'symbol has no code'); bw.put(codes[sym], sizes[sym]); };
}

const fixedSizes = (n) => new Array(n).fill(Math.max(1, Math.ceil(Math.log2(n))));
const fixedModel = (bw, n) => writeModel(bw, fixedSizes(n));

const evenUp = (n) => (n + 1) & ~1;

// Palettes -----------------------------------------------------------------

function dxtColorEndpoints(n) {
  const vals = [], bw = new BitWriter();
  const dm0 = fixedModel(bw, 32), dm1 = fixedModel(bw, 64);
  let p = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const q = [rnd(32), rnd(64), rnd(32), rnd(32), rnd(64), rnd(32)]; // a b c d e f
    dm0((q[0] - p[0]) & 31); dm1((q[1] - p[1]) & 63); dm0((q[2] - p[2]) & 31);
    dm0((q[3] - p[3]) & 31); dm1((q[4] - p[4]) & 63); dm0((q[5] - p[5]) & 31);
    vals.push((q[2] | (q[1] << 5) | (q[0] << 11) | (q[5] << 16) | (q[4] << 21) | (q[3] << 27)) >>> 0);
    p = q;
  }
  return { buf: bw.finish(), num: n, vals };
}

function dxtColorSelectors(n) {
  const vals = [], bw = new BitWriter();
  const dm = fixedModel(bw, 16);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = ((rnd(65536) << 16) | rnd(65536)) >>> 0; // desired DXT1 selector word
    let s = 0;
    for (let k = 0; k < 16; k++) {
      const v1 = (v >>> (2 * k + 1)) & 1, v0 = (v >>> (2 * k)) & 1;
      s |= (v0 << (2 * k + 1)) | ((v1 ^ v0) << (2 * k));
    }
    s >>>= 0;
    for (let j = 0; j < 8; j++) dm(((s >>> (4 * j)) & 15) ^ ((prev >>> (4 * j)) & 15));
    vals.push(v); prev = s;
  }
  return { buf: bw.finish(), num: n, vals };
}

function alphaEndpoints(n) {
  const vals = [], bw = new BitWriter();
  const dm = fixedModel(bw, 256);
  let pa = 0, pb = 0;
  for (let i = 0; i < n; i++) {
    const a = rnd(256), b = rnd(256);
    dm((a - pa) & 255); dm((b - pb) & 255);
    vals.push(a | (b << 8)); pa = a; pb = b;
  }
  return { buf: bw.finish(), num: n, vals };
}

const TO_LINEAR = [0, 7, 1, 2, 3, 4, 5, 6]; // inverse of the DXT5 selector remap

function alphaSelectors(n) {
  const vals = [], bw = new BitWriter();
  const dm = fixedModel(bw, 64);
  let l0 = 0, l1 = 0;
  for (let i = 0; i < n; i++) {
    const halves = [rnd(1 << 24), rnd(1 << 24)]; // 8 x 3-bit DXT5 indices each
    for (let h = 0; h < 2; h++) {
      for (let j = 0; j < 24; j += 6) {
        const g = (halves[h] >>> j) & 63;
        const lin = TO_LINEAR[g & 7] | (TO_LINEAR[g >> 3] << 3);
        const cur = h === 0 ? l0 : l1;
        const sym = lin ^ ((cur >>> j) & 63);
        dm(sym);
        if (h === 0) l0 ^= sym << j; else l1 ^= sym << j;
      }
    }
    vals.push(halves);
  }
  return { buf: bw.finish(), num: n, vals };
}

// Level streams --------------------------------------------------------------

// Simulates the decoder's reference/delta state machine while emitting symbols.
// kind: 'dxt1' | 'dxt5'. Returns the stream plus the expected (endpoint, selector) choice for each real block.
function encodeLevel(kind, outW, outH, refDM, ep, sel, nC, nA, nCS, nAS) {
  const bw = new BitWriter(), width = evenUp(outW), height = evenUp(outH);
  const writers = { ref: refDM(bw), ep0: ep[0] && ep[0](bw), ep1: ep[1] && ep[1](bw), sel0: sel[0] && sel[0](bw), sel1: sel[1] && sel[1](bw) };
  const refs = [];
  for (let y = 0; y < height; y++) { refs.push([]); for (let x = 0; x < width; x++) refs[y].push(rnd(3)); }
  const bbC = new Array(width).fill(0), bbA = new Array(width).fill(0);
  let c = 0, a = 0;
  const expected = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y % 2 === 0 && x % 2 === 0) writers.ref(refs[y][x] | (refs[y + 1][x] << 2) | (refs[y][x + 1] << 4) | (refs[y + 1][x + 1] << 6));
      const r = refs[y][x];
      if (r === 0) {
        const dc = rnd(nC); writers.ep0((dc - c + nC) % nC); c = dc; bbC[x] = c;
        if (kind === 'dxt5') { const da = rnd(nA); writers.ep1((da - a + nA) % nA); a = da; bbA[x] = a; }
      } else if (r === 1) { bbC[x] = c; bbA[x] = a; } else { c = bbC[x]; a = bbA[x]; }
      const cs = rnd(nCS); writers.sel0(cs);
      let as = 0;
      if (kind === 'dxt5') { as = rnd(nAS); writers.sel1(as); }
      if (x < outW && y < outH) expected.push({ x, y, c, a, cs, as });
    }
  }
  return { buf: bw.finish(), expected };
}

// Container -------------------------------------------------------------------

function buildCrn({ width, height, levels, format, tables, cEP, cSel, aEP, aSel, levelBufs }) {
  const headerSize = 70 + 4 * levels;
  const parts = [tables, cEP && cEP.buf, cSel && cSel.buf, aEP && aEP.buf, aSel && aSel.buf, ...levelBufs].filter(Boolean);
  const offs = [];
  let at = headerSize;
  for (const p of parts) { offs.push(at); at += p.length; }
  const total = at;
  const h = Buffer.alloc(headerSize);
  const w16 = (o, v) => h.writeUInt16BE(v, o);
  const w24 = (o, v) => { h[o] = (v >>> 16) & 255; h[o + 1] = (v >>> 8) & 255; h[o + 2] = v & 255; };
  w16(0, 0x4878); w16(2, headerSize); h.writeUInt32BE(total, 6);
  w16(12, width); w16(14, height); h[16] = levels; h[17] = 1; h[18] = format;
  let k = 0;
  const tablesOfs = offs[k++];
  const pal = (o, p) => { if (!p) return; w24(o, offs[k]); w24(o + 3, p.buf.length); w16(o + 6, p.num); k++; };
  pal(33, cEP); pal(41, cSel); pal(49, aEP); pal(57, aSel);
  w16(65, tables.length); w24(67, tablesOfs);
  for (let i = 0; i < levels; i++) h.writeUInt32BE(offs[k + i], 70 + 4 * i);
  return Buffer.concat([h, ...parts]);
}

// ---------------------------------------------------------------- tests

function testHuffman() {
  // mixed code lengths: 4 x len3 + 16 x len5 (lookup-table path), and a 10 symbol / len 2+4 code (slow path),
  // and a very skewed 16 symbol code with lengths 1..15,15
  const cases = [
    [...new Array(4).fill(3), ...new Array(16).fill(5)],
    [2, 2, ...new Array(8).fill(4)],
    [...Array.from({ length: 15 }, (_, i) => i + 1), 15],
    [0, 0, 0, 0, 0, 3, 3, 3, 3, ...new Array(12).fill(0), 2, 2, 2, 2, 2, 2, 2, 2, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4],
  ];
  for (const sizes of cases) {
    // fix Kraft sum for the last hand-written case by letting the encoder check completeness only for the others
    const syms = sizes.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    const kraft = sizes.reduce((a, s) => a + (s ? 2 ** -s : 0), 0);
    if (Math.abs(kraft - 1) > 1e-9) continue; // incomplete codes are not produced by the real encoder
    const bw = new BitWriter();
    const enc = writeModel(bw, sizes);
    const seq = Array.from({ length: 500 }, () => syms[rnd(syms.length)]);
    seq.forEach(enc);
    const buf = bw.finish();
    const codec = new Codec(), m = new HuffModel();
    assert(codec.start(buf, 0, buf.length));
    assert(codec.receiveModel(m), 'model should decode');
    assert.deepStrictEqual(Array.from(m.codeSizes), sizes);
    for (const s of seq) assert.strictEqual(codec.decode(m), s);
  }
  console.log('huffman tables ok');
}

function testLevels(kind) {
  const width = 20, height = 12, levels = 5; // blocks 5x3, 3x2, 2x1, 1x1, 1x1 : odd sizes everywhere
  const nCE = 37, nCS = 53, nAE = 29, nAS = 41;
  const cEP = dxtColorEndpoints(nCE), cSel = dxtColorSelectors(nCS);
  const aEP = kind === 'dxt5' ? alphaEndpoints(nAE) : null, aSel = kind === 'dxt5' ? alphaSelectors(nAS) : null;

  // tables: reference model (256 syms) + endpoint / selector index models
  const tb = new BitWriter();
  const refDM = (bw) => { const e = fixedModel(bw, 256); return e; };
  writeModel(tb, fixedSizes(256));
  const ep0Sizes = fixedSizes(nCE), sel0Sizes = fixedSizes(nCS);
  writeModel(tb, ep0Sizes); writeModel(tb, sel0Sizes);
  if (kind === 'dxt5') { writeModel(tb, fixedSizes(nAE)); writeModel(tb, fixedSizes(nAS)); }
  const tables = tb.finish();

  const levelBufs = [], expectedPerLevel = [];
  for (let l = 0; l < levels; l++) {
    const bx = Math.max(1, (width >> l + 3) >> 2); // placeholder, recomputed below
    const w = Math.max(width >> l, 1), h = Math.max(height >> l, 1);
    const blocksX = (w + 3) >> 2, blocksY = (h + 3) >> 2;
    // encoders bound to this level's bit writer: each returns a symbol writer for that model
    const mk = (sizes) => (bw) => { const codes = canonicalCodes(sizes); return (s) => bw.put(codes[s], sizes[s]); };
    const r = encodeLevel(kind, blocksX, blocksY, mk(fixedSizes(256)),
      [mk(ep0Sizes), kind === 'dxt5' ? mk(fixedSizes(nAE)) : null],
      [mk(sel0Sizes), kind === 'dxt5' ? mk(fixedSizes(nAS)) : null], nCE, nAE, nCS, nAS);
    void bx; void refDM;
    levelBufs.push(r.buf); expectedPerLevel.push({ blocksX, blocksY, w, h, expected: r.expected });
  }

  const crn = buildCrn({ width, height, levels, format: kind === 'dxt5' ? Format.DXT5 : Format.DXT1, tables, cEP, cSel, aEP, aSel, levelBufs });
  const tex = new CrunchTexture(crn);
  assert.strictEqual(tex.info.width, width);
  assert.strictEqual(tex.info.levels, levels);
  assert.strictEqual(tex.info.formatName, kind === 'dxt5' ? 'DXT5' : 'DXT1');

  const bpb = kind === 'dxt5' ? 16 : 8;
  expectedPerLevel.forEach((lv, l) => {
    const u = tex.unpackLevel(l);
    assert.strictEqual(u.blocksX, lv.blocksX); assert.strictEqual(u.blocksY, lv.blocksY);
    const out = Buffer.from(u.faces[0]);
    assert.strictEqual(out.length, bpb * lv.blocksX * lv.blocksY);
    for (const e of lv.expected) {
      const o = (e.y * lv.blocksX + e.x) * bpb;
      let c0 = o;
      if (kind === 'dxt5') {
        const [s0, s1] = aSel.vals[e.as];
        const payload = BigInt(s0) | (BigInt(s1) << 24n);
        assert.strictEqual(out.readUInt16LE(o), aEP.vals[e.a], `alpha endpoint l${l} (${e.x},${e.y})`);
        for (let i = 0; i < 6; i++) assert.strictEqual(out[o + 2 + i], Number((payload >> BigInt(8 * i)) & 255n), `alpha selector l${l} (${e.x},${e.y}) byte ${i}`);
        c0 = o + 8;
      }
      assert.strictEqual(out.readUInt32LE(c0), cEP.vals[e.c], `colour endpoint l${l} (${e.x},${e.y})`);
      assert.strictEqual(out.readUInt32LE(c0 + 4), cSel.vals[e.cs], `colour selector l${l} (${e.x},${e.y})`);
    }
    const rgba = tex.decodeLevelRGBA(l);
    assert.strictEqual(rgba.w, lv.w); assert.strictEqual(rgba.h, lv.h);
    assert.strictEqual(rgba.data.length, lv.w * lv.h * 4);
  });
  console.log(`${kind} round trip ok (${levels} levels, odd block counts)`);
  return crn;
}

function testBlockDecoders() {
  const px = (buf, w, h, fn) => { const o = fn(buf, w, h); return o; };
  // ETC1 differential, base 5-bit 16 -> 132, table 0 index 0 -> +2
  let o = px(Buffer.from([0x80, 0x80, 0x80, 0x02, 0, 0, 0, 0]), 4, 4, blockdec.decodeETC1);
  for (let i = 0; i < 16; i++) assert.deepStrictEqual(Array.from(o.subarray(i * 4, i * 4 + 4)), [134, 134, 134, 255]);
  // ETC1 individual, 4-bit 8 -> 136, table 0 index 3 -> -8
  o = px(Buffer.from([0x88, 0x88, 0x88, 0x00, 255, 255, 255, 255]), 4, 4, blockdec.decodeETC1);
  assert.deepStrictEqual(Array.from(o.subarray(0, 4)), [128, 128, 128, 255]);
  // ETC1 flip=0, left half index 0 (+2), right half index 3 (-8): pixels j = x*4+y, x>=2 are bits 8..15 / 24..31
  o = px(Buffer.from([0x88, 0x88, 0x88, 0x00, 0xFF, 0x00, 0xFF, 0x00]), 4, 4, blockdec.decodeETC1);
  assert.strictEqual(o[0], 138); assert.strictEqual(o[(0 * 4 + 3) * 4], 128);
  // ETC2 RGBA8: EAC base 100, multiplier 2, table 0, all indices 4 (+2*2) then an ETC1 block
  const eac = [100, 0x20, 0x92, 0x49, 0x24, 0x92, 0x49, 0x24];
  o = px(Buffer.from([...eac, 0x80, 0x80, 0x80, 0x02, 0, 0, 0, 0]), 4, 4, blockdec.decodeETC2RGBA8);
  assert.deepStrictEqual(Array.from(o.subarray(0, 4)), [134, 134, 134, 104]);
  // BC1 solid red, BC4 ramp endpoint
  o = px(Buffer.from([0x00, 0xF8, 0x00, 0xF8, 0, 0, 0, 0]), 4, 4, blockdec.decodeBC1);
  assert.deepStrictEqual(Array.from(o.subarray(0, 4)), [255, 0, 0, 255]);
  o = px(Buffer.from([200, 10, 0, 0, 0, 0, 0, 0]), 4, 4, blockdec.decodeBC4);
  assert.deepStrictEqual(Array.from(o.subarray(0, 4)), [200, 200, 200, 255]);
  console.log('block decoders ok');
}

function testRobustness(crn) {
  assert.throws(() => new CrunchTexture(Buffer.alloc(10)), CrunchError);
  assert.throws(() => new CrunchTexture(Buffer.alloc(200)), /signature/);
  assert.throws(() => new CrunchTexture(crn.subarray(0, crn.length >> 1)), CrunchError);
  const tex = new CrunchTexture(crn);
  assert.throws(() => tex.unpackLevel(99), CrunchError);
  // random corruption must either decode (to garbage) or throw CrunchError, never hang or throw anything else
  let thrown = 0;
  for (let n = 0; n < 300; n++) {
    const bad = Buffer.from(crn);
    for (let k = 0; k < 1 + rnd(6); k++) bad[74 + rnd(bad.length - 74)] = rnd(256);
    try { const t = new CrunchTexture(bad); for (let l = 0; l < t.info.levels; l++) t.unpackLevel(l); } catch (e) {
      assert(e instanceof CrunchError, `unexpected ${e && e.constructor.name}: ${e && e.message}`); thrown++;
    }
  }
  console.log(`robustness ok (${thrown}/300 corrupted files rejected cleanly)`);
}

testHuffman();
testLevels('dxt1');
const crn5 = testLevels('dxt5');
testBlockDecoders();
testRobustness(crn5);
