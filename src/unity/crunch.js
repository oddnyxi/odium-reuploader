'use strict';
// Crunch (.crn) transcoder, Unity variant.
//
// Unity stores DXT1Crunched / DXT5Crunched / ETC_RGB4Crunched / ETC2_RGBA8Crunched textures as a
// complete .crn file (all mip levels) in the Texture2D's image data. This is a JavaScript port of the
// decoder half of Unity's crunch fork (Unity-Technologies/crunch, crn_decomp.h, ZLIB licence), itself
// derived from Richard Geldreich's public-domain crunch. The Unity bitstream is NOT compatible with
// the original Binomial crunch, so original-format .crn files are not supported here.
//
//   const tex = new CrunchTexture(bytes);
//   tex.info                      -> { width, height, levels, faces, format, formatName, ... }
//   tex.unpackLevel(2)            -> raw block data (DXT / ETC) for mip level 2
//   tex.decodeLevelRGBA(2)        -> { w, h, data } RGBA8, row 0 = first stored row
//
// All integers in the header are big-endian. The entropy stream is MSB-first, canonical Huffman.

const blockdec = require('./blockdec');

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('crunch.js assumes a little-endian platform');

class CrunchError extends Error {}

const SIG = 0x4878; // 'H','x'
const HEADER_MIN = 74;
const MAX_LEVELS = 16;
const MAX_SYMS = 8192;
const MAX_TABLE_BITS = 11;
const MAX_CODE_SIZE = 16;
const CODELEN_CODES = 21;
const MOST_PROBABLE_CODELEN = [17, 18, 19, 20, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15, 16];
const DXT5_FROM_LINEAR = [0, 2, 3, 4, 5, 6, 7, 1];

const Format = {
  DXT1: 0, DXT3: 1, DXT5: 2, DXT5_CCXY: 3, DXT5_XGXR: 4, DXT5_XGBR: 5, DXT5_AGBR: 6,
  DXN_XY: 7, DXN_YX: 8, DXT5A: 9, ETC1: 10, ETC2: 11, ETC2A: 12, ETC1S: 13, ETC2AS: 14,
};
const FORMAT_NAMES = Object.keys(Format);

const isEtcColor = (f) => f === Format.ETC1 || f === Format.ETC2 || f === Format.ETC2A || f === Format.ETC1S || f === Format.ETC2AS;
const hasSubblocks = (f) => f === Format.ETC1 || f === Format.ETC2 || f === Format.ETC2A;
const bytesPerBlock = (f) => (f === Format.DXT1 || f === Format.DXT5A || f === Format.ETC1 || f === Format.ETC2 || f === Format.ETC1S ? 8 : 16);

const ceilLog2 = (v) => (v <= 1 ? 0 : 32 - Math.clz32(v - 1));
const totalBits = (v) => (v === 0 ? 0 : 32 - Math.clz32(v));

// ---------------------------------------------------------------- header

function parseHeader(buf) {
  if (buf.length < HEADER_MIN) throw new CrunchError('Crunch data is too short for a header');
  const u8 = (o) => buf[o];
  const u16 = (o) => (buf[o] << 8) | buf[o + 1];
  const u24 = (o) => (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
  const u32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  const pal = (o) => ({ ofs: u24(o), size: u24(o + 3), num: u16(o + 6) });
  if (u16(0) !== SIG) throw new CrunchError('Not a Crunch file (bad signature)');
  const h = {
    headerSize: u16(2), headerCrc16: u16(4), dataSize: u32(6), dataCrc16: u16(10),
    width: u16(12), height: u16(14), levels: u8(16), faces: u8(17), format: u8(18), flags: u16(19),
    reserved: u32(21), userdata0: u32(25), userdata1: u32(29),
    colorEndpoints: pal(33), colorSelectors: pal(41), alphaEndpoints: pal(49), alphaSelectors: pal(57),
    tablesSize: u16(65), tablesOfs: u24(67), levelOfs: [],
  };
  if (h.headerSize < HEADER_MIN) throw new CrunchError('Crunch header size is invalid');
  if (h.dataSize > buf.length) throw new CrunchError('Crunch data is truncated');
  if (!h.width || !h.height) throw new CrunchError('Crunch texture has zero size');
  if (h.levels < 1 || h.levels > MAX_LEVELS) throw new CrunchError(`Crunch level count ${h.levels} is invalid`);
  if (h.faces < 1 || h.faces > 6) throw new CrunchError(`Crunch face count ${h.faces} is invalid`);
  if (70 + 4 * h.levels > buf.length) throw new CrunchError('Crunch level table is truncated');
  for (let i = 0; i < h.levels; i++) h.levelOfs.push(u32(70 + 4 * i));
  for (const [name, p] of [['color endpoint', h.colorEndpoints], ['color selector', h.colorSelectors], ['alpha endpoint', h.alphaEndpoints], ['alpha selector', h.alphaSelectors]]) {
    if (p.num && (p.ofs + p.size > buf.length)) throw new CrunchError(`Crunch ${name} palette lies outside the data`);
  }
  if (h.tablesOfs + h.tablesSize > buf.length) throw new CrunchError('Crunch tables lie outside the data');
  return h;
}

// ---------------------------------------------------------------- static Huffman model

class HuffModel {
  constructor() {
    this.codeSizes = new Uint8Array(0);
    this.totalSyms = 0;
  }

  // Builds the canonical decoding tables from this.codeSizes. Returns false for invalid input.
  prepare() {
    const total = this.codeSizes.length;
    if (total < 1 || total > MAX_SYMS) return false;
    this.totalSyms = total;
    const tableBits = total > 16 ? Math.min(1 + ceilLog2(total), MAX_TABLE_BITS) : 0;
    return this._init(total, this.codeSizes, tableBits);
  }

  _init(numSyms, codeSizes, tableBits) {
    const minCodes = new Array(MAX_CODE_SIZE).fill(0);
    const numCodes = new Array(MAX_CODE_SIZE + 1).fill(0);
    for (let i = 0; i < numSyms; i++) {
      const c = codeSizes[i];
      if (c > MAX_CODE_SIZE) return false;
      if (c) numCodes[c]++;
    }
    this.maxCodes = new Float64Array(MAX_CODE_SIZE + 1);
    this.valPtrs = new Int32Array(MAX_CODE_SIZE + 1);
    const sortedPos = new Array(MAX_CODE_SIZE + 1).fill(0);
    let curCode = 0, totalUsed = 0, maxSize = 0, minSize = 0xFFFFFFFF;
    for (let i = 1; i <= MAX_CODE_SIZE; i++) {
      const n = numCodes[i];
      if (n === 0) {
        this.maxCodes[i - 1] = 0;
      } else {
        minSize = Math.min(minSize, i); maxSize = Math.max(maxSize, i);
        minCodes[i - 1] = curCode;
        const top = curCode + n - 1;
        this.maxCodes[i - 1] = 1 + (((top << (16 - i)) | ((1 << (16 - i)) - 1)) >>> 0);
        this.valPtrs[i - 1] = totalUsed;
        sortedPos[i] = totalUsed;
        curCode += n; totalUsed += n;
      }
      curCode <<= 1;
    }
    if (totalUsed === 0) return false;
    this.sorted = new Uint16Array(totalUsed);
    for (let i = 0; i < numSyms; i++) {
      const c = codeSizes[i];
      if (!c) continue;
      const pos = sortedPos[c]++;
      if (pos >= totalUsed) return false;
      this.sorted[pos] = i;
    }
    if (tableBits <= minSize) tableBits = 0;
    this.tableBits = tableBits;
    this.lookup = null;
    if (tableBits) {
      this.lookup = new Uint32Array(1 << tableBits).fill(0xFFFFFFFF);
      for (let size = 1; size <= tableBits; size++) {
        if (numCodes[size] === 0) continue;
        const fillSize = tableBits - size, fillNum = 1 << fillSize;
        const minCode = minCodes[size - 1];
        const maxCode = (this.maxCodes[size - 1] - 1) >>> (16 - size);
        const valPtr = this.valPtrs[size - 1];
        for (let code = minCode; code <= maxCode; code++) {
          const sym = this.sorted[valPtr + code - minCode];
          if (codeSizes[sym] !== size) return false;
          for (let j = 0; j < fillNum; j++) {
            const t = j + (code << fillSize);
            if (t >= (1 << tableBits)) return false;
            this.lookup[t] = (sym | (size << 16)) >>> 0;
          }
        }
      }
    }
    for (let i = 0; i < MAX_CODE_SIZE; i++) this.valPtrs[i] -= minCodes[i];
    this.tableMaxCode = 0;
    this.decodeStartCodeSize = minSize;
    if (tableBits) {
      let i = tableBits;
      while (i >= 1) {
        if (numCodes[i]) { this.tableMaxCode = this.maxCodes[i - 1]; break; }
        i--;
      }
      if (i >= 1) {
        this.decodeStartCodeSize = tableBits + 1;
        for (let j = tableBits + 1; j <= maxSize; j++) {
          if (numCodes[j]) { this.decodeStartCodeSize = j; break; }
        }
      }
    }
    this.maxCodes[MAX_CODE_SIZE] = 0xFFFFFFFF; // sentinel
    this.valPtrs[MAX_CODE_SIZE] = 0xFFFFF;
    return true;
  }
}

// ---------------------------------------------------------------- bit reader / symbol decoder

class Codec {
  constructor() { this.buf = null; this.pos = 0; this.end = 0; this.bitBuf = 0; this.bitCount = 0; }

  start(buf, ofs, size) {
    if (!size || ofs < 0 || ofs >= buf.length) return false;
    this.buf = buf; this.pos = ofs; this.end = Math.min(buf.length, ofs + size);
    this.bitBuf = 0; this.bitCount = 0;
    return true;
  }

  _byte() { return this.pos < this.end ? this.buf[this.pos++] : 0; } // reads past the end return zero bits

  bits(n) {
    if (n === 0) return 0;
    while (this.bitCount < n) {
      const c = this._byte();
      this.bitCount += 8;
      if (this.bitCount > 32) throw new CrunchError('Crunch bit buffer overflow');
      this.bitBuf = (this.bitBuf | (c << (32 - this.bitCount))) >>> 0;
    }
    const r = this.bitBuf >>> (32 - n);
    this.bitBuf = (this.bitBuf << n) >>> 0;
    this.bitCount -= n;
    return r;
  }

  decode(m) {
    if (this.bitCount < 24) {
      if (this.bitCount < 16) {
        const c0 = this._byte(), c1 = this._byte();
        this.bitCount += 16;
        this.bitBuf = (this.bitBuf | (((c0 << 8) | c1) << (32 - this.bitCount))) >>> 0;
      } else {
        const c = this._byte();
        this.bitCount += 8;
        this.bitBuf = (this.bitBuf | (c << (32 - this.bitCount))) >>> 0;
      }
    }
    const k = (this.bitBuf >>> 16) + 1;
    let sym, len;
    if (k <= m.tableMaxCode) {
      const t = m.lookup[this.bitBuf >>> (32 - m.tableBits)];
      if (t === 0xFFFFFFFF) throw new CrunchError('Invalid Huffman code in Crunch stream');
      sym = t & 0xFFFF; len = t >>> 16;
      if (m.codeSizes[sym] !== len) throw new CrunchError('Corrupt Huffman table in Crunch stream');
    } else {
      len = m.decodeStartCodeSize;
      while (k > m.maxCodes[len - 1]) {
        len++;
        if (len > MAX_CODE_SIZE + 1) throw new CrunchError('Invalid Huffman code in Crunch stream');
      }
      const vp = m.valPtrs[len - 1] + (this.bitBuf >>> (32 - len));
      if (len > MAX_CODE_SIZE || vp < 0 || vp >= m.totalSyms || vp >= m.sorted.length) throw new CrunchError('Invalid Huffman code in Crunch stream');
      sym = m.sorted[vp];
    }
    this.bitBuf = (this.bitBuf << len) >>> 0;
    this.bitCount -= len;
    return sym;
  }

  // Reads a Huffman table that was stored as run-length-coded code lengths.
  receiveModel(model) {
    const total = this.bits(totalBits(MAX_SYMS));
    if (total === 0 || total > MAX_SYMS) return false;
    model.codeSizes = new Uint8Array(total);
    const numCl = this.bits(5);
    if (numCl < 1 || numCl > CODELEN_CODES) return false;
    const dm = new HuffModel();
    dm.codeSizes = new Uint8Array(CODELEN_CODES);
    for (let i = 0; i < numCl; i++) dm.codeSizes[MOST_PROBABLE_CODELEN[i]] = this.bits(3);
    if (!dm.prepare()) return false;
    let ofs = 0;
    while (ofs < total) {
      const remaining = total - ofs;
      const code = this.decode(dm);
      if (code <= 16) {
        model.codeSizes[ofs++] = code;
      } else if (code === 17 || code === 18) {
        const len = code === 17 ? this.bits(3) + 3 : this.bits(7) + 11; // zero runs
        if (len > remaining) return false;
        ofs += len;
      } else if (code === 19 || code === 20) {
        const len = code === 19 ? this.bits(2) + 3 : this.bits(6) + 7; // repeat previous non-zero size
        if (ofs === 0 || len > remaining) return false;
        const prev = model.codeSizes[ofs - 1];
        if (prev === 0) return false;
        for (const end = ofs + len; ofs < end; ofs++) model.codeSizes[ofs] = prev;
      } else {
        return false;
      }
    }
    return model.prepare();
  }
}

// ---------------------------------------------------------------- texture

class CrunchTexture {
  constructor(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.buf = buf;
    this.header = parseHeader(buf);
    const h = this.header;
    if (h.format >= FORMAT_NAMES.length) throw new CrunchError(`Unknown Crunch format ${h.format}`);
    this.format = h.format;
    this.codec = new Codec();
    this._initTables();
    this._decodePalettes();
  }

  get info() {
    const h = this.header;
    return {
      width: h.width, height: h.height, levels: h.levels, faces: h.faces,
      format: h.format, formatName: FORMAT_NAMES[h.format], bytesPerBlock: bytesPerBlock(h.format),
      flags: h.flags, userdata0: h.userdata0, userdata1: h.userdata1, dataSize: h.dataSize,
      colorEndpoints: h.colorEndpoints.num, colorSelectors: h.colorSelectors.num,
      alphaEndpoints: h.alphaEndpoints.num, alphaSelectors: h.alphaSelectors.num,
    };
  }

  _fail(what) { throw new CrunchError(`Crunch ${what} could not be decoded`); }

  _start(ofs, size, what) {
    if (!this.codec.start(this.buf, ofs, size)) this._fail(what);
  }

  _model(what) {
    const m = new HuffModel();
    if (!this.codec.receiveModel(m)) this._fail(what);
    return m;
  }

  _initTables() {
    const h = this.header;
    this._start(h.tablesOfs, h.tablesSize, 'table block');
    this.refDM = this._model('reference table');
    this.epDM = [null, null]; this.selDM = [null, null];
    if (!h.colorEndpoints.num && !h.alphaEndpoints.num) this._fail('palettes (none present)');
    if (h.colorEndpoints.num) { this.epDM[0] = this._model('colour endpoint table'); this.selDM[0] = this._model('colour selector table'); }
    if (h.alphaEndpoints.num) { this.epDM[1] = this._model('alpha endpoint table'); this.selDM[1] = this._model('alpha selector table'); }
  }

  _decodePalettes() {
    const h = this.header;
    if (h.colorEndpoints.num) { this._colorEndpoints(); this._colorSelectors(); }
    if (h.alphaEndpoints.num) {
      this._alphaEndpoints();
      if (this.format === Format.ETC2AS) this._alphaSelectorsEtcs();
      else if (this.format === Format.ETC2A) this._alphaSelectorsEtc();
      else this._alphaSelectors();
    }
  }

  _colorEndpoints() {
    const p = this.header.colorEndpoints, codec = this.codec, n = p.num;
    const etc = isEtcColor(this.format), sub = hasSubblocks(this.format);
    const out = (this.colorEndpointsArr = new Uint32Array(n));
    this._start(p.ofs, p.size, 'colour endpoints');
    const dm0 = this._model('colour endpoint deltas');
    const dm1 = etc ? null : this._model('colour endpoint deltas');
    let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
    for (let i = 0; i < n; i++) {
      if (etc) {
        for (let sh = 0; sh < 32; sh += 8) a = (a + codec.decode(dm0) * (2 ** sh)) >>> 0;
        a = (a & 0x1F1F1F1F) >>> 0;
        out[i] = sub ? a : (((a & 0x07000000) << 5) | ((a & 0x07000000) << 2) | 0x02000000 | ((a & 0x001F1F1F) << 3)) >>> 0;
      } else {
        a = (a + codec.decode(dm0)) & 31;
        b = (b + codec.decode(dm1)) & 63;
        c = (c + codec.decode(dm0)) & 31;
        d = (d + codec.decode(dm0)) & 31;
        e = (e + codec.decode(dm1)) & 63;
        f = (f + codec.decode(dm0)) & 31;
        out[i] = (c | (b << 5) | (a << 11) | (f << 16) | (e << 21) | (d << 27)) >>> 0;
      }
    }
  }

  _colorSelectors() {
    const p = this.header.colorSelectors, codec = this.codec, n = p.num;
    const etc = isEtcColor(this.format), sub = hasSubblocks(this.format);
    this._start(p.ofs, p.size, 'colour selectors');
    const dm = this._model('colour selector deltas');
    const out = (this.colorSelectorsArr = new Uint32Array(sub ? n * 2 : n));
    let s = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 32; j += 4) s ^= codec.decode(dm) << j;
      if (etc) {
        const sel = ((~s & 0xAAAAAAAA) | (~(s ^ (s >>> 1)) & 0x55555555)) >>> 0;
        let t = 8;
        for (let hh = 0; hh < 4; hh++) {
          for (let w = 0; w < 4; w++) {
            if (sub) {
              const s0 = sel >>> ((w << 3) | (hh << 1));
              out[i << 1] |= (((s0 >> 1) & 1) | ((s0 & 1) << 16)) << (t & 15);
            }
            const s1 = sel >>> ((hh << 3) | (w << 1));
            const v = (((s1 >> 1) & 1) | ((s1 & 1) << 16)) << (t & 15);
            if (sub) out[(i << 1) | 1] |= v; else out[i] |= v;
            t += 4;
          }
          t -= 15;
        }
      } else {
        out[i] = (((s ^ (s << 1)) & 0xAAAAAAAA) | ((s >>> 1) & 0x55555555)) >>> 0;
      }
    }
  }

  _alphaEndpoints() {
    const p = this.header.alphaEndpoints, codec = this.codec, n = p.num;
    this._start(p.ofs, p.size, 'alpha endpoints');
    const dm = this._model('alpha endpoint deltas');
    const out = (this.alphaEndpointsArr = new Uint16Array(n));
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const sa = codec.decode(dm), sb = codec.decode(dm);
      a = (sa + a) & 0xFF; b = (sb + b) & 0xFF;
      out[i] = a | (b << 8);
    }
  }

  // BC3 / BC4 / BC5 style: 8 symbols of two 3-bit linear selectors each
  _alphaSelectors() {
    const p = this.header.alphaSelectors, codec = this.codec, n = p.num;
    this._start(p.ofs, p.size, 'alpha selectors');
    const dm = this._model('alpha selector deltas');
    const out = (this.alphaSelectorsArr = new Uint16Array(n * 3));
    const table = new Uint8Array(64);
    for (let i = 0; i < 64; i++) table[i] = DXT5_FROM_LINEAR[i & 7] | (DXT5_FROM_LINEAR[i >> 3] << 3);
    let l0 = 0, l1 = 0;
    for (let i = 0; i < n; i++) {
      let s0 = 0, s1 = 0;
      for (let j = 0; j < 24; j += 6) { l0 ^= codec.decode(dm) << j; s0 |= table[(l0 >>> j) & 0x3F] << j; }
      for (let j = 0; j < 24; j += 6) { l1 ^= codec.decode(dm) << j; s1 |= table[(l1 >>> j) & 0x3F] << j; }
      out[i * 3] = s0 & 0xFFFF;
      out[i * 3 + 1] = ((s0 >>> 16) | (s1 << 8)) & 0xFFFF;
      out[i * 3 + 2] = (s1 >>> 8) & 0xFFFF;
    }
  }

  // Fills the 3-bit EAC selector bits for one pixel into byte array `data` (see the ETC2 alpha layout).
  static _eacBits(data, at, s, d, bias) {
    const byteOfs = d >> 3, bitOfs = d & 7;
    data[at + byteOfs + bias] |= (s << (8 - bitOfs)) & 0xFF;
    if (bitOfs < 3) data[at + byteOfs + bias - 1] |= s >> bitOfs;
  }

  // ETC2 RGBA8 (two alpha selector sets per entry, one per flip orientation)
  _alphaSelectorsEtc() {
    const p = this.header.alphaSelectors, codec = this.codec, n = p.num;
    this._start(p.ofs, p.size, 'alpha selectors');
    const dm = this._model('alpha selector deltas');
    const u16 = (this.alphaSelectorsArr = new Uint16Array(n * 6 + 1));
    const data = new Uint8Array(u16.buffer);
    const lin = new Uint8Array(8);
    for (let i = 0, at = 0; i < n * 6; i += 6, at += 12) {
      let group = 0;
      for (let q = 0; q < 16; q++) {
        if (q & 1) group >>= 3;
        else { lin[q >> 1] ^= codec.decode(dm); group = lin[q >> 1]; }
        let s = group & 7;
        if (s <= 3) s = 3 - s;
        CrunchTexture._eacBits(data, at, s, 3 * (q + 1), 0);
        CrunchTexture._eacBits(data, at, s, 3 * (q + 1) + 9 * ((q & 3) - (q >> 2)), 6);
      }
    }
  }

  // ETC2 RGBA8 "S" mode (single orientation)
  _alphaSelectorsEtcs() {
    const p = this.header.alphaSelectors, codec = this.codec, n = p.num;
    this._start(p.ofs, p.size, 'alpha selectors');
    const dm = this._model('alpha selector deltas');
    const u16 = (this.alphaSelectorsArr = new Uint16Array(n * 3 + 1));
    const data = new Uint8Array(u16.buffer);
    const lin = new Uint8Array(8);
    for (let at = 0; at < n * 6; at += 6) {
      let group = 0;
      for (let q = 0; q < 16; q++) {
        if (q & 1) group >>= 3;
        else { lin[q >> 1] ^= codec.decode(dm); group = lin[q >> 1]; }
        let s = group & 7;
        if (s <= 3) s = 3 - s;
        CrunchTexture._eacBits(data, at, s, 3 * (q + 1) + 9 * ((q & 3) - (q >> 2)), 0);
      }
    }
  }

  // ------------------------------------------------------------ level unpacking

  /**
   * Transcodes one mip level to its native block format.
   * @returns {{format:number, formatName:string, width:number, height:number, blocksX:number, blocksY:number,
   *            bytesPerBlock:number, faces:Uint8Array[]}}
   */
  unpackLevel(level) {
    const h = this.header;
    if (!Number.isInteger(level) || level < 0 || level >= h.levels) throw new CrunchError(`Crunch level ${level} is out of range`);
    const cur = h.levelOfs[level];
    const next = level + 1 < h.levels ? h.levelOfs[level + 1] : this.buf.length;
    if (next <= cur || cur >= this.buf.length) throw new CrunchError('Crunch level offsets are inconsistent');
    const width = Math.max(h.width >> level, 1), height = Math.max(h.height >> level, 1);
    const blocksX = (width + 3) >> 2, blocksY = (height + 3) >> 2;
    const bpb = bytesPerBlock(this.format);
    const pitchDw = (bpb * blocksX) >> 2;
    if (!this.codec.start(this.buf, cur, next - cur)) throw new CrunchError('Crunch level stream is empty');
    const unpack = this._unpacker();
    const faces = [];
    for (let f = 0; f < h.faces; f++) {
      const dst = new Uint32Array(pitchDw * blocksY);
      unpack.call(this, dst, pitchDw, blocksX, blocksY);
      faces.push(new Uint8Array(dst.buffer));
    }
    return { format: this.format, formatName: FORMAT_NAMES[this.format], width, height, blocksX, blocksY, bytesPerBlock: bpb, faces };
  }

  _unpacker() {
    switch (this.format) {
      case Format.DXT1: case Format.ETC1S: return this._unpackDxt1;
      case Format.DXT5: case Format.DXT5_CCXY: case Format.DXT5_XGXR: case Format.DXT5_XGBR: case Format.DXT5_AGBR: case Format.ETC2AS: return this._unpackDxt5;
      case Format.DXT5A: return this._unpackDxt5a;
      case Format.DXN_XY: case Format.DXN_YX: return this._unpackDxn;
      case Format.ETC1: case Format.ETC2: return this._unpackEtc1;
      case Format.ETC2A: return this._unpackEtc2a;
      default: throw new CrunchError(`Crunch format ${FORMAT_NAMES[this.format]} cannot be unpacked`);
    }
  }

  // Reads the 2-bit endpoint reference for a block (DXT-style, one 2x2 group symbol per 2 blocks).
  // Shared bookkeeping: per-column state for the row above lives in the bb* arrays.

  _unpackDxt1(dst, pitchDw, outW, outH) {
    const codec = this.codec, refDM = this.refDM, epDM = this.epDM[0], selDM = this.selDM[0];
    const ce = this.colorEndpointsArr, cs = this.colorSelectorsArr, nCE = ce.length;
    const width = (outW + 1) & ~1, height = (outH + 1) & ~1;
    const delta = pitchDw - (width << 1);
    const bbRef = new Uint8Array(width), bbCol = new Uint16Array(width);
    let ci = 0, group = 0, dp = 0;
    for (let y = 0; y < height; y++) {
      let visible = y < outH;
      for (let x = 0; x < width; x++) {
        visible = visible && x < outW;
        if ((y & 1) === 0 && (x & 1) === 0) group = codec.decode(refDM);
        let ref;
        if (y & 1) ref = bbRef[x];
        else { ref = group & 3; group >>= 2; bbRef[x] = group & 3; group >>= 2; }
        if (ref === 0) { ci += codec.decode(epDM); if (ci >= nCE) ci -= nCE; bbCol[x] = ci; }
        else if (ref === 1) bbCol[x] = ci;
        else ci = bbCol[x];
        const si = codec.decode(selDM);
        if (visible) { dst[dp] = ce[ci]; dst[dp + 1] = cs[si]; }
        dp += 2;
      }
      dp += delta;
    }
  }

  _unpackDxt5(dst, pitchDw, outW, outH) {
    const codec = this.codec, refDM = this.refDM;
    const epC = this.epDM[0], epA = this.epDM[1], selC = this.selDM[0], selA = this.selDM[1];
    const ce = this.colorEndpointsArr, cs = this.colorSelectorsArr, ae = this.alphaEndpointsArr, as = this.alphaSelectorsArr;
    const nCE = ce.length, nAE = ae.length;
    const width = (outW + 1) & ~1, height = (outH + 1) & ~1;
    const delta = pitchDw - (width << 2);
    const bbRef = new Uint8Array(width), bbCol = new Uint16Array(width), bbAlpha = new Uint16Array(width);
    let ci = 0, ai = 0, group = 0, dp = 0;
    for (let y = 0; y < height; y++) {
      let visible = y < outH;
      for (let x = 0; x < width; x++) {
        visible = visible && x < outW;
        if ((y & 1) === 0 && (x & 1) === 0) group = codec.decode(refDM);
        let ref;
        if (y & 1) ref = bbRef[x];
        else { ref = group & 3; group >>= 2; bbRef[x] = group & 3; group >>= 2; }
        if (ref === 0) {
          ci += codec.decode(epC); if (ci >= nCE) ci -= nCE; bbCol[x] = ci;
          ai += codec.decode(epA); if (ai >= nAE) ai -= nAE; bbAlpha[x] = ai;
        } else if (ref === 1) { bbCol[x] = ci; bbAlpha[x] = ai; }
        else { ci = bbCol[x]; ai = bbAlpha[x]; }
        const si = codec.decode(selC), asi = codec.decode(selA) * 3;
        if (visible) {
          dst[dp] = (ae[ai] | (as[asi] << 16)) >>> 0;
          dst[dp + 1] = (as[asi + 1] | (as[asi + 2] << 16)) >>> 0;
          dst[dp + 2] = ce[ci];
          dst[dp + 3] = cs[si];
        }
        dp += 4;
      }
      dp += delta;
    }
  }

  _unpackDxt5a(dst, pitchDw, outW, outH) {
    const codec = this.codec, refDM = this.refDM, epA = this.epDM[1], selA = this.selDM[1];
    const ae = this.alphaEndpointsArr, as = this.alphaSelectorsArr, nAE = ae.length;
    const width = (outW + 1) & ~1, height = (outH + 1) & ~1;
    const delta = pitchDw - (width << 1);
    const bbRef = new Uint8Array(width), bbAlpha = new Uint16Array(width);
    let ai = 0, group = 0, dp = 0;
    for (let y = 0; y < height; y++) {
      let visible = y < outH;
      for (let x = 0; x < width; x++) {
        visible = visible && x < outW;
        if ((y & 1) === 0 && (x & 1) === 0) group = codec.decode(refDM);
        let ref;
        if (y & 1) ref = bbRef[x];
        else { ref = group & 3; group >>= 2; bbRef[x] = group & 3; group >>= 2; }
        if (ref === 0) { ai += codec.decode(epA); if (ai >= nAE) ai -= nAE; bbAlpha[x] = ai; }
        else if (ref === 1) bbAlpha[x] = ai;
        else ai = bbAlpha[x];
        const asi = codec.decode(selA) * 3;
        if (visible) {
          dst[dp] = (ae[ai] | (as[asi] << 16)) >>> 0;
          dst[dp + 1] = (as[asi + 1] | (as[asi + 2] << 16)) >>> 0;
        }
        dp += 2;
      }
      dp += delta;
    }
  }

  _unpackDxn(dst, pitchDw, outW, outH) {
    const codec = this.codec, refDM = this.refDM, epA = this.epDM[1], selA = this.selDM[1];
    const ae = this.alphaEndpointsArr, as = this.alphaSelectorsArr, nAE = ae.length;
    const width = (outW + 1) & ~1, height = (outH + 1) & ~1;
    const delta = pitchDw - (width << 2);
    const bbRef = new Uint8Array(width), bbA0 = new Uint16Array(width), bbA1 = new Uint16Array(width);
    let a0 = 0, a1 = 0, group = 0, dp = 0;
    for (let y = 0; y < height; y++) {
      let visible = y < outH;
      for (let x = 0; x < width; x++) {
        visible = visible && x < outW;
        if ((y & 1) === 0 && (x & 1) === 0) group = codec.decode(refDM);
        let ref;
        if (y & 1) ref = bbRef[x];
        else { ref = group & 3; group >>= 2; bbRef[x] = group & 3; group >>= 2; }
        if (ref === 0) {
          a0 += codec.decode(epA); if (a0 >= nAE) a0 -= nAE; bbA0[x] = a0;
          a1 += codec.decode(epA); if (a1 >= nAE) a1 -= nAE; bbA1[x] = a1;
        } else if (ref === 1) { bbA0[x] = a0; bbA1[x] = a1; }
        else { a0 = bbA0[x]; a1 = bbA1[x]; }
        const s0 = codec.decode(selA) * 3, s1 = codec.decode(selA) * 3;
        if (visible) {
          dst[dp] = (ae[a0] | (as[s0] << 16)) >>> 0;
          dst[dp + 1] = (as[s0 + 1] | (as[s0 + 2] << 16)) >>> 0;
          dst[dp + 2] = (ae[a1] | (as[s1] << 16)) >>> 0;
          dst[dp + 3] = (as[s1 + 1] | (as[s1 + 2] << 16)) >>> 0;
        }
        dp += 4;
      }
      dp += delta;
    }
  }

  // Builds the 4 header bytes of an ETC1 block from two 5-bit-per-channel endpoints (packed LE in a u32)
  // plus the flip flag. Returns the block's first dword. Differential mode is used whenever it can represent the pair.
  static _etcBlockEndpoint(e0v, e1v, flip) {
    const e0 = [e0v & 255, (e0v >>> 8) & 255, (e0v >>> 16) & 255, (e0v >>> 24) & 255];
    const e1 = [e1v & 255, (e1v >>> 8) & 255, (e1v >>> 16) & 255, (e1v >>> 24) & 255];
    let diff = 1;
    for (let c = 0; c < 3 && diff; c++) if (!(e0[c] + 3 >= e1[c] && e1[c] + 4 >= e0[c])) diff = 0;
    const b = [0, 0, 0, 0];
    for (let c = 0; c < 3; c++) b[c] = diff ? (((e0[c] << 3) & 0xFF) | ((e1[c] - e0[c]) & 7)) : (((e0[c] << 3) & 0xF0) | (e1[c] >> 1));
    b[3] = ((e0[3] << 5) & 0xFF) | ((e1[3] << 2) & 0xFF) | (diff << 1) | flip;
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  _unpackEtc1(dst, pitchDw, outW, outH) {
    const codec = this.codec, refDM = this.refDM, epDM = this.epDM[0], selDM = this.selDM[0];
    const ce = this.colorEndpointsArr, cs = this.colorSelectorsArr, nCE = ce.length;
    const width = (outW + 1) & ~1, height = (outH + 1) & ~1;
    const delta = pitchDw - (width << 1);
    const bbRef = new Uint8Array(width), bbCol = new Uint16Array(width), bbCol2 = new Uint16Array(width);
    let ci = 0, diag = 0, dp = 0;
    for (let y = 0; y < height; y++) {
      let visible = y < outH;
      for (let x = 0; x < width; x++) {
        visible = visible && x < outW;
        let ref;
        if (y & 1) ref = bbRef[x];
        else {
          const g = codec.decode(refDM);
          ref = (g & 3) | ((g >> 2) & 12);
          bbRef[x] = ((g >> 2) & 3) | ((g >> 4) & 12);
        }
        if ((ref & 3) === 0) { ci += codec.decode(epDM); if (ci >= nCE) ci -= nCE; bbCol[x] = ci; }
        else if ((ref & 3) === 1) bbCol[x] = ci;
        else if ((ref & 3) === 3) { ci = diag; bbCol[x] = ci; }
        else ci = bbCol[x];
        ref >>= 2;
        const e0 = ce[ci];
        const si = codec.decode(selDM);
        if (ref !== 0) { ci += codec.decode(epDM); if (ci >= nCE) ci -= nCE; }
        diag = bbCol2[x];
        bbCol2[x] = ci;
        const e1 = ce[ci];
        if (visible) {
          const flip = (ref >> 1) ^ 1;
          dst[dp] = CrunchTexture._etcBlockEndpoint(e0, e1, flip);
          dst[dp + 1] = cs[(si << 1) | flip];
        }
        dp += 2;
      }
      dp += delta;
    }
  }

  _unpackEtc2a(dst, pitchDw, outW, outH) {
    const codec = this.codec, refDM = this.refDM;
    const epC = this.epDM[0], epA = this.epDM[1], selC = this.selDM[0], selA = this.selDM[1];
    const ce = this.colorEndpointsArr, cs = this.colorSelectorsArr, ae = this.alphaEndpointsArr, as = this.alphaSelectorsArr;
    const nCE = ce.length, nAE = ae.length;
    const width = (outW + 1) & ~1, height = (outH + 1) & ~1;
    const delta = pitchDw - (width << 2);
    const bbRef = new Uint8Array(width), bbCol = new Uint16Array(width), bbAlpha = new Uint16Array(width);
    const bbCol2 = new Uint16Array(width), bbAlpha2 = new Uint16Array(width);
    let ci = 0, ai = 0, diagC = 0, diagA = 0, dp = 0;
    for (let y = 0; y < height; y++) {
      let visible = y < outH;
      for (let x = 0; x < width; x++) {
        visible = visible && x < outW;
        let ref;
        if (y & 1) ref = bbRef[x];
        else {
          const g = codec.decode(refDM);
          ref = (g & 3) | ((g >> 2) & 12);
          bbRef[x] = ((g >> 2) & 3) | ((g >> 4) & 12);
        }
        if ((ref & 3) === 0) {
          ci += codec.decode(epC); if (ci >= nCE) ci -= nCE;
          ai += codec.decode(epA); if (ai >= nAE) ai -= nAE;
          bbCol[x] = ci; bbAlpha[x] = ai;
        } else if ((ref & 3) === 1) { bbCol[x] = ci; bbAlpha[x] = ai; }
        else if ((ref & 3) === 3) { ci = diagC; bbCol[x] = ci; ai = diagA; bbAlpha[x] = ai; }
        else { ci = bbCol[x]; ai = bbAlpha[x]; }
        ref >>= 2;
        const e0 = ce[ci];
        const csi = codec.decode(selC), asi = codec.decode(selA);
        if (ref !== 0) { ci += codec.decode(epC); if (ci >= nCE) ci -= nCE; }
        const e1 = ce[ci];
        diagC = bbCol2[x]; diagA = bbAlpha2[x];
        bbCol2[x] = ci; bbAlpha2[x] = ai;
        if (visible) {
          const flip = (ref >> 1) ^ 1;
          const ab = asi * 6 + (flip ? 3 : 0);
          dst[dp] = (ae[ai] | (as[ab] << 16)) >>> 0;
          dst[dp + 1] = (as[ab + 1] | (as[ab + 2] << 16)) >>> 0;
          dst[dp + 2] = CrunchTexture._etcBlockEndpoint(e0, e1, flip);
          dst[dp + 3] = cs[(csi << 1) | flip];
        }
        dp += 4;
      }
      dp += delta;
    }
  }

  // ------------------------------------------------------------ RGBA output

  /**
   * Transcodes and decodes one mip level of face 0 to RGBA8.
   * @returns {{w:number,h:number,data:Uint8Array}}
   */
  decodeLevelRGBA(level) {
    const u = this.unpackLevel(level);
    const src = u.faces[0], w = u.width, h = u.height;
    let data;
    switch (u.format) {
      case Format.DXT1: data = blockdec.decodeBC1(src, w, h); break;
      case Format.DXT5: case Format.DXT5_CCXY: case Format.DXT5_XGXR: case Format.DXT5_XGBR: case Format.DXT5_AGBR:
        data = blockdec.decodeBC3(src, w, h); break;
      case Format.DXT5A: data = blockdec.decodeBC4(src, w, h); break;
      case Format.DXN_XY: data = blockdec.decodeBC5(src, w, h, false); break;
      case Format.DXN_YX: data = blockdec.decodeBC5(src, w, h, true); break;
      case Format.ETC1: case Format.ETC2: case Format.ETC1S: data = blockdec.decodeETC1(src, w, h); break;
      case Format.ETC2A: case Format.ETC2AS: data = blockdec.decodeETC2RGBA8(src, w, h); break;
      default: throw new CrunchError(`Crunch format ${u.formatName} has no RGBA decoder`);
    }
    return { w, h, data };
  }
}

/** True when the buffer starts with the Crunch signature. */
const isCrunch = (buf) => !!buf && buf.length >= HEADER_MIN && buf[0] === 0x48 && buf[1] === 0x78;

module.exports = { CrunchTexture, CrunchError, Format, FORMAT_NAMES, parseHeader, isCrunch, HuffModel, Codec };
