'use strict';
const { lzmaDecode, lzmaEncode } = require('./lzma');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const AVTR_RE = /avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const AVTR_LEN = 41; // "avtr_" (5) + UUID (36)

// Reads the UnityFS header: "UnityFS\0", format version (u32 BE), player version, engine version.
function readBundleInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    const size = fs.fstatSync(fd).size;
    if (n < 16 || buf.toString('latin1', 0, 8) !== 'UnityFS\0') {
      throw new Error('This is not a Unity bundle (missing UnityFS header).');
    }
    const format = buf.readUInt32BE(8);
    let p = 12;
    const cstr = () => { const e = buf.indexOf(0, p); const s = buf.toString('latin1', p, e); p = e + 1; return s; };
    cstr(); // player version, e.g. 5.x.x
    const unityVersion = cstr();
    return { format, unityVersion, size };
  } finally {
    fs.closeSync(fd);
  }
}

// LZ4 block decompression (used by UnityFS for compression types 2 and 3).
function lz4Block(src, outSize) {
  const out = Buffer.alloc(outSize);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    if (s + lit > src.length || d + lit > outSize) throw new Error('Corrupt LZ4 data.');
    src.copy(out, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const off = src.readUInt16LE(s); s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    if (!off || off > d || d + len > outSize) throw new Error('Corrupt LZ4 data.');
    for (let i = 0; i < len; i++, d++) out[d] = out[d - off];
  }
  return out;
}

/**
 * LZ4 block compression (greedy, 64 KB window). Output is a standard LZ4 block, so it is read by
 * the same decoder Unity uses for chunk-based (LZ4) bundles.
 */
function lz4Compress(src) {
  const n = src.length;
  const dst = Buffer.allocUnsafe(n + Math.floor(n / 255) + 16);
  const MF_LIMIT = 12; // a match may not start in the last 12 bytes
  const LAST_LITERALS = 5; // the last 5 bytes are always literals
  const table = new Int32Array(1 << 16).fill(-1);
  const read32 = (p) => src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24);
  let d = 0;
  let anchor = 0;

  const extend = (len) => { // length bytes beyond the 15 held in the token
    let rest = len - 15;
    while (rest >= 255) { dst[d++] = 255; rest -= 255; }
    dst[d++] = rest;
  };

  for (let i = 0; i <= n - MF_LIMIT;) {
    const h = Math.imul(read32(i), 2654435761) >>> 16;
    const ref = table[h];
    table[h] = i;
    if (ref < 0 || i - ref > 65535 || read32(ref) !== read32(i)) { i++; continue; }

    let len = 4;
    const maxLen = n - LAST_LITERALS - i;
    while (len < maxLen && src[ref + len] === src[i + len]) len++;

    const lit = i - anchor;
    dst[d++] = (Math.min(lit, 15) << 4) | Math.min(len - 4, 15);
    if (lit >= 15) extend(lit);
    src.copy(dst, d, anchor, i); d += lit;
    dst.writeUInt16LE(i - ref, d); d += 2;
    if (len - 4 >= 15) extend(len - 4);
    i += len;
    anchor = i;
  }

  const lit = n - anchor;
  dst[d++] = Math.min(lit, 15) << 4;
  if (lit >= 15) extend(lit);
  src.copy(dst, d, anchor, n); d += lit;
  return dst.subarray(0, d);
}

function unpack(src, outSize, comp) {
  if (comp === 0) return src;
  if (comp === 2 || comp === 3) return lz4Block(src, outSize);
  if (comp === 1) return lzmaDecode(src, outSize);
  throw new Error('Unsupported bundle compression.');
}

/** Reads the fixed UnityFS header fields. `headerEnd` is where the block table or data begins. */
function parseHeader(buf) {
  if (buf.toString('latin1', 0, 8) !== 'UnityFS\0') throw new Error('not a bundle');
  let p = 12;
  const cstr = () => { const e = buf.indexOf(0, p); const s = buf.toString('latin1', p, e); p = e + 1; return s; };
  const version = buf.readUInt32BE(8);
  const playerVersion = cstr();
  const unityVersion = cstr();
  const fieldsAt = p; // total size (i64), info compressed/uncompressed size, flags
  const cSize = buf.readUInt32BE(p + 8);
  const uSize = buf.readUInt32BE(p + 12);
  const flags = buf.readUInt32BE(p + 16);
  p += 20;
  if (version >= 7) p = (p + 15) & ~15;
  return { version, playerVersion, unityVersion, fieldsAt, cSize, uSize, flags, headerEnd: p };
}

/**
 * Parse a UnityFS file into header + decompressed data blocks.
 * Returns null on unsupported (LZMA) or corrupt input.
 */
function parseBundle(buf) {
  const { version, playerVersion, unityVersion, fieldsAt, cSize, uSize, flags, headerEnd } = parseHeader(buf);
  const p = headerEnd;
  const infoAtEnd = !!(flags & 0x80);
  const infoStart = infoAtEnd ? buf.length - cSize : p;
  const info = unpack(buf.subarray(infoStart, infoStart + cSize), uSize, flags & 0x3f);
  let q = 16; // skip hash
  const blockCount = info.readInt32BE(q); q += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    blocks.push({ u: info.readUInt32BE(q), c: info.readUInt32BE(q + 4), f: info.readUInt16BE(q + 8) });
    q += 10;
  }
  const nodeTableAt = q; // everything from here on is copied verbatim when patching
  const nodeCount = info.readInt32BE(q); q += 4;
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = Number(info.readBigInt64BE(q)); q += 8;
    const size = Number(info.readBigInt64BE(q)); q += 8;
    const status = info.readUInt32BE(q); q += 4;
    const e = info.indexOf(0, q);
    const name = info.toString('latin1', q, e); q = e + 1;
    nodes.push({ offset, size, status, name });
  }
  let pos = infoAtEnd ? p : infoStart + cSize;
  if (!infoAtEnd && (flags & 0x200)) pos = (pos + 15) & ~15; // block data is 16-byte aligned
  const dataBlocks = [];
  for (const b of blocks) {
    const raw = buf.subarray(pos, pos + b.c);
    const data = unpack(raw, b.u, b.f & 0x3f);
    dataBlocks.push({ data, originalFlags: b.f, raw, u: b.u, c: b.c, f: b.f });
    pos += b.c;
  }
  return {
    version,
    playerVersion,
    unityVersion,
    flags,
    infoAtEnd,
    headerEnd: p, // after alignment, start of data when info not at end
    blocks: dataBlocks,
    nodes,
    // original layout, kept so a patched bundle stays as close to the SDK's output as possible
    header: Buffer.from(buf.subarray(0, p)),
    fieldsAt,
    hash: Buffer.from(info.subarray(0, 16)),
    nodeTable: Buffer.from(info.subarray(nodeTableAt)),
    originalInfoCSize: cSize,
    originalInfoUSize: uSize,
  };
}

// Unity BuildTarget values as stored in a serialized file, mapped to the platform names VRChat uses.
const PLATFORM_BY_TARGET = { 5: 'standalonewindows', 19: 'standalonewindows', 13: 'android', 9: 'ios' };

/**
 * Reads the block table and the first serialized file header, without decompressing the whole bundle.
 * Gives the numbers VRChat's size limits are checked against, and the platform it was built for.
 * @returns {{ uncompressedSize: number, blockCount: number, targetPlatform: number|null, platform: string|null }}
 */
function inspectBundle(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (at, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, at); return b; };
    const hd = parseHeader(read(0, Math.min(512, size)));
    const infoAtEnd = !!(hd.flags & 0x80);
    const infoStart = infoAtEnd ? size - hd.cSize : hd.headerEnd;
    const info = unpack(read(infoStart, hd.cSize), hd.uSize, hd.flags & 0x3f);

    const blockCount = info.readInt32BE(16);
    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
      const at = 20 + i * 10;
      blocks.push({ u: info.readUInt32BE(at), c: info.readUInt32BE(at + 4), f: info.readUInt16BE(at + 8) });
    }
    const uncompressedSize = blocks.reduce((n, b) => n + b.u, 0);

    let targetPlatform = null;
    if (blocks.length) {
      let at = infoAtEnd ? hd.headerEnd : infoStart + hd.cSize;
      if (!infoAtEnd && (hd.flags & 0x200)) at = (at + 15) & ~15;
      try {
        const first = unpack(read(at, blocks[0].c), blocks[0].u, blocks[0].f & 0x3f);
        targetPlatform = readTargetPlatform(first);
      } catch { /* platform stays unknown */ }
    }
    return { uncompressedSize, blockCount, targetPlatform, platform: PLATFORM_BY_TARGET[targetPlatform] || null };
  } finally {
    fs.closeSync(fd);
  }
}

/** Target platform from the start of a serialized file (the first node of the bundle). */
function readTargetPlatform(b) {
  const version = b.readUInt32BE(8);
  if (version < 8) return null;
  let le = true;
  let p = 0x14;
  if (version >= 9) le = b[16] === 0;
  if (version >= 22) p = 0x30;
  p = b.indexOf(0, p) + 1; // unity version string
  if (p <= 0 || p + 4 > b.length) return null;
  return le ? b.readInt32LE(p) : b.readInt32BE(p);
}

/**
 * Re-encodes a block's data with the compression it already used, falling back to stored (raw)
 * when the original codec cannot be reproduced here (LZMA) or does not help.
 */
function encodeBlock(data, flags) {
  const kind = flags & 0x3f;
  const rest = flags & ~0x3f;
  if (kind === 2 || kind === 3) {
    const packed = lz4Compress(data);
    if (packed.length < data.length) return { payload: packed, flags: rest | kind }; // LZ4 and LZ4HC share one block format
  }
  if (kind === 1) {
    const packed = lzmaEncode(data); // the SDK writes LZMA bundles; keep them LZMA
    if (packed.length < data.length) return { payload: packed, flags: rest | kind };
  }
  return { payload: data, flags: rest };
}

/**
 * Writes a bundle with only the changed blocks re-encoded. Everything else is reproduced exactly:
 * the header fields, integrity hash, node table, archive flags, block order, and the compressed
 * bytes of every untouched block. This is far closer to what the SDK produced than re-writing the
 * whole container, which matters because VRChat inspects uploaded bundles on the server.
 *
 * @param {object} parsed   result of parseBundle()
 * @param {Set<number>} changed  indexes of blocks whose `data` was modified
 */
function patchBundle(parsed, changed) {
  const entries = [];
  const payloads = [];
  parsed.blocks.forEach((b, i) => {
    if (!changed.has(i)) { entries.push({ u: b.u, c: b.c, f: b.f }); payloads.push(b.raw); return; }
    const { payload, flags } = encodeBlock(b.data, b.f);
    entries.push({ u: b.data.length, c: payload.length, f: flags });
    payloads.push(payload);
  });

  // block table: hash, block count, entries, then the original node table untouched
  const table = Buffer.alloc(16 + 4 + entries.length * 10);
  parsed.hash.copy(table, 0);
  table.writeInt32BE(entries.length, 16);
  entries.forEach((e, i) => {
    const at = 20 + i * 10;
    table.writeUInt32BE(e.u, at); table.writeUInt32BE(e.c, at + 4); table.writeUInt16BE(e.f, at + 8);
  });
  const infoRaw = Buffer.concat([table, parsed.nodeTable]);
  const infoEnc = encodeBlock(infoRaw, parsed.flags);
  const infoFlags = infoEnc.flags;

  const header = Buffer.from(parsed.header);
  let pad = 0; // block data starts on a 16-byte boundary when the archive says so
  if (!parsed.infoAtEnd && (infoFlags & 0x200)) {
    const size = header.length + infoEnc.payload.length;
    pad = ((size + 15) & ~15) - size;
  }
  const total = header.length + infoEnc.payload.length + pad + payloads.reduce((n, b) => n + b.length, 0);
  const at = parsed.fieldsAt;
  header.writeUInt32BE(Math.floor(total / 0x100000000), at);
  header.writeUInt32BE(total >>> 0, at + 4);
  header.writeUInt32BE(infoEnc.payload.length, at + 8);
  header.writeUInt32BE(infoRaw.length, at + 12);
  header.writeUInt32BE(infoFlags >>> 0, at + 16);

  if (parsed.infoAtEnd) return Buffer.concat([header, ...payloads, infoEnc.payload]);
  return Buffer.concat([header, infoEnc.payload, Buffer.alloc(pad), ...payloads]);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WRLD_RE = new RegExp(`wrld_${UUID}`, 'gi');
const ID_KINDS = {
  avatar: { re: AVTR_RE, noun: 'avatar' },
  world: { re: WRLD_RE, noun: 'world' },
};

/**
 * Find every blueprint ID of one kind (avtr_ for avatars, wrld_ for worlds) in the
 * (possibly compressed) bundle.
 * @param {string} file
 * @param {'avatar'|'world'} [kind]
 */
function readBlueprintIds(file, kind = 'avatar') {
  const { re, noun } = ID_KINDS[kind] || ID_KINDS.avatar;
  try {
    const buf = fs.readFileSync(file);
    const parsed = parseBundle(buf);
    const found = new Set();
    for (const b of parsed.blocks) {
      const text = b.data.toString('latin1');
      for (const m of text.match(re) || []) found.add(m.toLowerCase());
    }
    return { ids: [...found], note: found.size ? '' : `No ${noun} ID found in this bundle.` };
  } catch (e) {
    return { ids: [], note: e.message === 'LZMA bundles cannot be scanned here.' ? e.message : `Could not read a ${noun} ID from this bundle.` };
  }
}

/**
 * Replace every occurrence of the old blueprint ID(s) with `newId` inside the VRCA.
 * Because avtr_ UUIDs are fixed length, string substitution does not shift any offsets.
 * Writes a new file and returns its path. Original is left untouched.
 *
 * @param {string} filePath  source .vrca
 * @param {string} newId     target avtr_... ID (must be exactly 41 chars)
 * @param {string} [outPath] optional destination; defaults to a temp file
 * @returns {{ path: string, replaced: string[], count: number }}
 */
function replaceBlueprintId(filePath, newId, outPath) {
  if (!/^avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(newId)) {
    throw new Error('newId must be a full avtr_ UUID.');
  }
  const target = newId.toLowerCase();
  const buf = fs.readFileSync(filePath);
  let parsed;
  try {
    parsed = parseBundle(buf);
  } catch (e) {
    if (e.message === 'LZMA bundles cannot be scanned here.') {
      throw new Error('This bundle uses LZMA compression; rewrite is not supported yet. Rebuild uncompressed or LZ4 in Unity.');
    }
    throw new Error('Could not parse this Unity bundle: ' + e.message);
  }

  const replaced = new Set();
  const changed = new Set();
  let total = 0;
  for (const [index, b] of parsed.blocks.entries()) {
    // Work on a mutable copy
    const data = Buffer.from(b.data);
    // Find all matches (case-insensitive) and overwrite in place
    const text = data.toString('latin1');
    AVTR_RE.lastIndex = 0;
    let m;
    while ((m = AVTR_RE.exec(text)) !== null) {
      const old = m[0].toLowerCase();
      if (old === target) continue; // already correct
      replaced.add(old);
      // overwrite the 36 bytes
      data.write(target, m.index, AVTR_LEN, 'latin1');
      total++;
      changed.add(index);
    }
    if (changed.has(index)) b.data = data;
  }

  if (total === 0 && replaced.size === 0) {
    // Either no IDs at all, or every ID already matched the target
    const existing = readBlueprintIds(filePath).ids;
    if (!existing.length) throw new Error('No avatar ID found inside this bundle to replace.');
    // all already match — still produce a copy so callers have a stable path
  }

  const out = outPath || path.join(os.tmpdir(), `avu-rewritten-${crypto.randomUUID()}.vrca`);
  const rebuilt = patchBundle(parsed, changed);
  fs.writeFileSync(out, rebuilt);
  return { path: out, replaced: [...replaced], count: total };
}

module.exports = {
  readBundleInfo,
  inspectBundle,
  readBlueprintIds,
  replaceBlueprintId,
  lz4Block,
  lz4Compress,
  patchBundle,
  parseBundle,
  AVTR_RE,
  WRLD_RE,
};
