'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSignature, BLOCK_LEN, STRONG_LEN } = require('../src/vrchat/rsync-sig');
const { readBundleInfo, readBlueprintIds, replaceBlueprintId } = require('../src/unity/bundle');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avu-'));

  // signature: 12-byte header + (4 + strong) bytes per block, last block may be short
  const data = Buffer.alloc(BLOCK_LEN * 2 + 100, 7);
  const src = path.join(tmp, 'a.bin'); fs.writeFileSync(src, data);
  const sig = path.join(tmp, 'a.sig');
  await writeSignature(src, sig);
  const out = fs.readFileSync(sig);
  assert.strictEqual(out.length, 12 + 3 * (4 + STRONG_LEN));
  assert.strictEqual(out.readUInt32BE(0), 0x72730137);
  assert.strictEqual(out.readUInt32BE(4), BLOCK_LEN);
  console.log('signature layout ok');

  // empty file still gets a header only
  fs.writeFileSync(src, Buffer.alloc(0));
  await writeSignature(src, sig);
  assert.strictEqual(fs.statSync(sig).size, 12);

  // bundle header
  const hdr = Buffer.concat([Buffer.from('UnityFS\0', 'latin1'), Buffer.from([0, 0, 0, 6]), Buffer.from('5.x.x\0', 'latin1'), Buffer.from('2022.3.22f1\0', 'latin1'), Buffer.alloc(64)]);
  const b = path.join(tmp, 'x.vrca'); fs.writeFileSync(b, hdr);
  const info = readBundleInfo(b);
  assert.strictEqual(info.unityVersion, '2022.3.22f1');
  assert.strictEqual(info.format, 6);
  fs.writeFileSync(b, Buffer.from('not a bundle at all, sorry'));
  assert.throws(() => readBundleInfo(b), /UnityFS/);
  console.log('bundle header ok');

  // blueprint ID scan on an uncompressed bundle (flags: compression 0, info at end)
  const id = 'avtr_12345678-1234-1234-1234-123456789abc';
  const blk = Buffer.concat([Buffer.alloc(5), Buffer.from(id, 'latin1'), Buffer.alloc(5)]);
  const info2 = Buffer.alloc(16 + 4 + 10 + 4); // hash, blockCount=1, block, nodeCount=0
  info2.writeInt32BE(1, 16); info2.writeUInt32BE(blk.length, 20); info2.writeUInt32BE(blk.length, 24); info2.writeUInt16BE(0, 28);
  const head = Buffer.concat([Buffer.from('UnityFS\0', 'latin1'), Buffer.from([0, 0, 0, 6]), Buffer.from('5.x.x\0', 'latin1'), Buffer.from('2022.3.22f1\0', 'latin1')]);
  const fixed = Buffer.alloc(16);
  fixed.writeUInt32BE(info2.length, 8); fixed.writeUInt32BE(info2.length, 12);
  const full = Buffer.concat([head, fixed.subarray(0, 8).fill(0), fixed.subarray(8, 12), fixed.subarray(12, 16), Buffer.alloc(4), info2, blk]);
  fs.writeFileSync(b, full);
  assert.deepStrictEqual(readBlueprintIds(b).ids, [id]);
  console.log('blueprint id ok');

  // rewrite pipeline ID (same-length string replace + rebuild)
  const newId = 'avtr_abcdef01-2345-6789-abcd-ef0123456789';
  const r = replaceBlueprintId(b, newId, path.join(tmp, 'rewritten.vrca'));
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.replaced, [id]);
  assert.deepStrictEqual(readBlueprintIds(r.path).ids, [newId]);
  // original unchanged
  assert.deepStrictEqual(readBlueprintIds(b).ids, [id]);
  console.log('blueprint rewrite ok');
})().catch((e) => { console.error(e); process.exit(1); });
