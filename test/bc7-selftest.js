'use strict';
const assert = require('assert');
const { decodeBC7 } = require('../src/unity/bc7');
const { decodeTexture, isSupported } = require('../src/unity/texture');
const { cases } = require('./fixtures/bc7.json');

// every mode, checked bit-for-bit against a reference decoder
for (const c of cases) {
  const got = Buffer.from(decodeBC7(Buffer.from(c.block, 'hex'), 4, 4)).toString('hex');
  assert.strictEqual(got, c.rgba, `BC7 mode ${c.mode} block ${c.block}`);
}
assert.deepStrictEqual([...new Set(cases.map((c) => c.mode))].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
console.log(`bc7 decoder ok (${cases.length} reference blocks, all 8 modes)`);

// sizes that are not a multiple of four, and a reserved block
const odd = decodeBC7(Buffer.alloc(16 * 4), 5, 3);
assert.strictEqual(odd.length, 5 * 3 * 4);
assert.ok(odd.every((v) => v === 0), 'reserved mode decodes as transparent black');

// through the texture entry point, picking a smaller mip
assert.ok(isSupported(25));
const base = Buffer.alloc(8 * 8 / 16 * 16, 0x40); // 8x8 = 4 blocks
const lvl1 = Buffer.alloc(16, 0x40);              // 4x4 = 1 block
const tex = decodeTexture({ m_Width: 8, m_Height: 8, m_TextureFormat: 25, m_MipCount: 2, 'image data': Buffer.concat([base, lvl1]) }, null, 4);
assert.strictEqual(tex.w, 4);
console.log('bc7 texture path ok');
