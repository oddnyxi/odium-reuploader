'use strict';
// Checks that rewriting a blueprint ID leaves the rest of a UnityFS bundle exactly as it was.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lzmaEncode, lzmaDecode } = require('../src/unity/lzma');
const { lz4Block, lz4Compress, inspectBundle, parseBundle, readBlueprintIds, replaceBlueprintId } = require('../src/unity/bundle');

// ── LZ4 encoder round trips ──
const rnd = (n) => crypto.randomBytes(n);
const text = (n) => Buffer.from('mesh vertex 0.25 0.5 1.0 material avatar '.repeat(Math.ceil(n / 40)).slice(0, n), 'latin1');
const mixed = (n) => Buffer.concat([text(n >> 1), rnd(n >> 2), text(n - (n >> 1) - (n >> 2))]);
for (const n of [0, 1, 4, 11, 12, 13, 17, 255, 300, 4096, 70000, 300000]) {
  for (const make of [rnd, text, mixed]) {
    const src = make(n);
    const packed = lz4Compress(src);
    assert.ok(packed.equals(src) || lz4Block(packed, n).equals(src), `lz4 round trip failed (${make.name}, ${n})`);
  }
}
assert.ok(lz4Compress(text(100000)).length < 5000, 'repetitive data should compress well');
console.log('lz4 encoder ok');

// ── LZMA encoder round trips ──
for (const n of [1, 5, 300, 70000]) {
  for (const make of [rnd, text, mixed]) {
    const src = make(n);
    assert.ok(lzmaDecode(lzmaEncode(src), n).equals(src), `lzma round trip failed (${make.name}, ${n})`);
  }
}
console.log('lzma encoder ok');

// ── a realistic LZ4 bundle: format 7, compressed block table, three blocks ──
const OLD = 'avtr_12345678-1234-1234-1234-123456789abc';
const NEW = 'avtr_abcdef01-2345-6789-abcd-ef0123456789';

function buildBundle(archiveFlags, kinds = [2, 3, 0]) {
  const blocksRaw = [
    Buffer.concat([text(60000), Buffer.from(OLD, 'latin1'), text(60000)]), // compressed, holds the ID
    mixed(50000),                                                          // compressed, untouched
    Buffer.concat([rnd(32), Buffer.from(OLD, 'latin1'), rnd(32)]),         // stored, holds the ID
  ];
  const comp = blocksRaw.map((b, i) => (kinds[i] === 1 ? lzmaEncode(b) : kinds[i] ? lz4Compress(b) : b));
  const nodeTable = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeInt32BE(1, 0); return b; })(),
    (() => { const b = Buffer.alloc(20); b.writeBigInt64BE(0n, 0); b.writeBigInt64BE(BigInt(blocksRaw.reduce((n, x) => n + x.length, 0)), 8); b.writeUInt32BE(4, 16); return b; })(),
    Buffer.from('CAB-test\0', 'latin1'),
  ]);
  const table = Buffer.alloc(20 + blocksRaw.length * 10);
  crypto.randomBytes(16).copy(table, 0); // a recognisable hash
  table.writeInt32BE(blocksRaw.length, 16);
  blocksRaw.forEach((b, i) => {
    table.writeUInt32BE(b.length, 20 + i * 10); table.writeUInt32BE(comp[i].length, 24 + i * 10); table.writeUInt16BE(kinds[i] | 0x40 * (i === 1), 28 + i * 10);
  });
  const infoRaw = Buffer.concat([table, nodeTable]);
  const infoPacked = lz4Compress(infoRaw);

  const versions = Buffer.concat([Buffer.from('UnityFS\0', 'latin1'), Buffer.from([0, 0, 0, 7]), Buffer.from('5.x.x\0', 'latin1'), Buffer.from('2022.3.22f1\0', 'latin1')]);
  const fields = Buffer.alloc(20);
  fields.writeUInt32BE(infoPacked.length, 8); fields.writeUInt32BE(infoRaw.length, 12); fields.writeUInt32BE(archiveFlags, 16);
  let header = Buffer.concat([versions, fields]);
  header = Buffer.concat([header, Buffer.alloc((16 - (header.length % 16)) % 16)]);
  const parts = [header, infoPacked];
  if (archiveFlags & 0x200) { const size = header.length + infoPacked.length; parts.push(Buffer.alloc(((size + 15) & ~15) - size)); }
  parts.push(...comp);
  const file = Buffer.concat(parts);
  file.writeUInt32BE(file.length, versions.length + 4);
  return { file, hash: table.subarray(0, 16), nodeTable };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odium-bundle-'));
for (const [archiveFlags, kinds] of [[0x03, [2, 3, 0]], [0x203, [2, 3, 0]], [0x03, [1, 1, 0]]]) { // 0x200 = block data is 16-byte aligned
  const label = `flags 0x${archiveFlags.toString(16)} blocks ${kinds.join('')}`;
  const { file, hash, nodeTable } = buildBundle(archiveFlags, kinds);
  const src = path.join(tmp, `in-${archiveFlags}.vrca`);
  fs.writeFileSync(src, file);
  assert.deepStrictEqual(readBlueprintIds(src).ids, [OLD], `${label}: scan`);

  const out = path.join(tmp, `out-${archiveFlags}.vrca`);
  const r = replaceBlueprintId(src, NEW, out);
  assert.strictEqual(r.count, 2, `${label}: both occurrences replaced`);
  const before = parseBundle(file);
  const outBuf = fs.readFileSync(out);
  const after = parseBundle(outBuf);

  assert.deepStrictEqual(readBlueprintIds(out).ids, [NEW], `${label}: new id`);
  assert.strictEqual(outBuf.readUInt32BE(after.fieldsAt + 4), outBuf.length, `${label}: total size field`);
  assert.strictEqual(after.version, before.version);
  assert.strictEqual(after.unityVersion, before.unityVersion);
  assert.strictEqual(after.flags, before.flags, `${label}: archive flags kept`);
  assert.ok(after.hash.equals(hash), `${label}: integrity hash kept`);
  assert.ok(after.nodeTable.equals(nodeTable), `${label}: node table kept`);
  assert.ok(after.blocks[1].raw.equals(before.blocks[1].raw), `${label}: untouched block is byte-identical`);
  assert.strictEqual(after.blocks[1].f, before.blocks[1].f, `${label}: untouched block flags kept`);
  assert.strictEqual(after.blocks[0].f & 0x3f, kinds[0], `${label}: changed block keeps its compression`);
  assert.strictEqual(after.blocks[2].f & 0x3f, 0, `${label}: stored block stays stored`);
  assert.ok(after.blocks[0].c < after.blocks[0].u, `${label}: changed block is still compressed`);
  // everything except the two ID strings is unchanged
  before.blocks.forEach((b, i) => {
    const expect = Buffer.from(b.data.toString('latin1').split(OLD).join(NEW), 'latin1');
    assert.ok(after.blocks[i].data.equals(expect), `${label}: block ${i} content`);
  });
  const stats = inspectBundle(out);
  assert.strictEqual(stats.uncompressedSize, after.blocks.reduce((n, b) => n + b.u, 0), `${label}: uncompressed size`);
  assert.strictEqual(stats.blockCount, after.blocks.length, `${label}: block count`);
  assert.deepStrictEqual(readBlueprintIds(src).ids, [OLD], `${label}: source untouched`);
  console.log(`bundle patch ok (${label}, ${file.length} -> ${outBuf.length} bytes)`);
}

// size limits
{
  const { checkBundleSize, limitsFor } = require('../src/vrchat/limits');
  const MB = 1048576;
  assert.strictEqual(limitsFor('standalonewindows').download, 200 * MB);
  assert.strictEqual(limitsFor('android').uncompressed, 40 * MB);
  assert.ok(checkBundleSize({ platform: 'android', fileSize: 11 * MB }).downloadOver);
  assert.ok(!checkBundleSize({ platform: 'standalonewindows', fileSize: 150 * MB, uncompressedSize: 400 * MB }).downloadOver);
  assert.ok(checkBundleSize({ platform: 'standalonewindows', fileSize: 1, uncompressedSize: 501 * MB }).uncompressedOver);
  console.log('size limits ok');
}
