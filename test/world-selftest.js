'use strict';
// World upload flow, Unity version fallback and multipart resume checks, against a stubbed API.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readBlueprintIds } = require('../src/unity/bundle');
const { VrcClient, UploadError, resolveUnityVersion, DEFAULT_UNITY_VERSION } = require('../src/vrchat/client');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odium-world-'));

/** Minimal uncompressed UnityFS bundle with `payload` as its only block. */
function writeBundle(file, payload, unityVersion = '2022.3.22f1') {
  const blk = Buffer.concat([Buffer.alloc(5), Buffer.from(payload, 'latin1'), Buffer.alloc(5)]);
  const info = Buffer.alloc(16 + 4 + 10 + 4);
  info.writeInt32BE(1, 16); info.writeUInt32BE(blk.length, 20); info.writeUInt32BE(blk.length, 24); info.writeUInt16BE(0, 28);
  const head = Buffer.concat([Buffer.from('UnityFS\0', 'latin1'), Buffer.from([0, 0, 0, 6]), Buffer.from('5.x.x\0', 'latin1'), Buffer.from(`${unityVersion}\0`, 'latin1')]);
  const sizes = Buffer.alloc(8); sizes.writeUInt32BE(info.length, 0); sizes.writeUInt32BE(info.length, 4);
  fs.writeFileSync(file, Buffer.concat([head, Buffer.alloc(8), sizes, Buffer.alloc(4), info, blk]));
  return file;
}

const WORLD = 'wrld_11111111-2222-3333-4444-555555555555';
const OTHER = 'wrld_99999999-8888-7777-6666-555555555555';
const ME = { id: 'usr_me', displayName: 'me' };

/** A client whose HTTP methods and file uploads are recorded instead of sent. */
function stubClient({ world = null, agreed = false, created = null } = {}) {
  const c = new VrcClient({ userAgent: 'test' });
  c.user = ME;
  c.calls = [];
  const rec = (m) => (p, body) => { c.calls.push([m, p, body]); return Promise.resolve(c.reply(m, p, body)); };
  c.reply = (m, p, body) => {
    if (m === 'GET' && p === 'agreement') return { agreed };
    if (m === 'POST' && p === 'agreement') return { contentId: WORLD };
    if (m === 'POST' && p === 'worlds') return created || { id: body.id };
    return {};
  };
  c.get = (p, o) => { c.calls.push(['GET', p, o?.query]); return Promise.resolve(c.reply('GET', p)); };
  c.post = rec('POST'); c.put = rec('PUT'); c.del = rec('DELETE');
  c.getWorld = async () => world;
  c.uploadFile = async (file, fileId, friendly) => {
    c.calls.push(['FILE', path.extname(file), fileId, friendly]);
    return `https://api.vrchat.cloud/api/1/file/file_${path.extname(file) === '.vrcw' ? 'aaaaaaaa' : 'bbbbbbbb'}-0000-0000-0000-000000000000/1/file`;
  };
  return c;
}

const noop = () => {};
const base = (bundlePath) => ({
  bundlePath, thumbPath: path.join(tmp, 'thumb.png'), worldId: WORLD, name: 'My World', description: 'hi', tags: [],
  platform: 'standalonewindows', unityVersion: '', capacity: 32, recommendedCapacity: 16, rightsConfirmed: true,
});
fs.writeFileSync(path.join(tmp, 'thumb.png'), 'png');

(async () => {
  // ── world IDs in bundles ──
  const good = writeBundle(path.join(tmp, 'good.vrcw'), `${WORLD} and avtr_12345678-1234-1234-1234-123456789abc`);
  assert.deepStrictEqual(readBlueprintIds(good, 'world').ids, [WORLD]);
  assert.deepStrictEqual(readBlueprintIds(good).ids, ['avtr_12345678-1234-1234-1234-123456789abc'], 'default kind stays avatar');
  const bare = writeBundle(path.join(tmp, 'bare.vrcw'), 'no ids here at all');
  assert.strictEqual(readBlueprintIds(bare, 'world').note, 'No world ID found in this bundle.');
  console.log('world id scan ok');

  // ── Unity version ──
  const warnings = [];
  const warn = (l, m) => warnings.push(m);
  assert.strictEqual(resolveUnityVersion('2022.3.6f1', '2019.4.31f1', warn), '2022.3.6f1');
  assert.strictEqual(resolveUnityVersion('', '2019.4.31f1', warn), '2019.4.31f1');
  assert.strictEqual(resolveUnityVersion('', '0.0.0', warn), DEFAULT_UNITY_VERSION);
  assert.strictEqual(resolveUnityVersion(undefined, '', warn), DEFAULT_UNITY_VERSION);
  assert.strictEqual(warnings.length, 2);
  assert.throws(() => resolveUnityVersion('latest', '2022.3.22f1', warn), UploadError);
  console.log('unity version fallback ok');

  // ── first upload creates the record with the bundle's ID ──
  let c = stubClient();
  const id = await c.uploadWorld(base(good), noop, noop);
  assert.strictEqual(id, WORLD);
  const create = c.calls.find(([m, p]) => m === 'POST' && p === 'worlds')[2];
  assert.strictEqual(create.id, WORLD);
  assert.strictEqual(create.releaseStatus, 'private');
  assert.strictEqual(create.assetVersion, 4);
  assert.strictEqual(create.capacity, 32);
  assert.strictEqual(create.recommendedCapacity, 16);
  assert.strictEqual(create.unityVersion, '2022.3.22f1');
  assert.ok(create.assetUrl.includes('file_aaaaaaaa') && create.imageUrl.includes('file_bbbbbbbb'));
  assert.ok(c.calls.some(([m, p]) => m === 'POST' && p === 'agreement'), 'records the rights agreement');
  const friendly = c.calls.find(([m, ext]) => m === 'FILE' && ext === '.vrcw')[3];
  assert.strictEqual(friendly, 'World - My World - Asset bundle - 2022.3.22f1_4_standalonewindows_Release');
  assert.deepStrictEqual(c.extraHeaders, {}, 'build-target headers are cleared afterwards');
  console.log('world first upload ok');

  // ── refusals ──
  await assert.rejects(stubClient().uploadWorld({ ...base(good), rightsConfirmed: false }, noop, noop), /rights/);
  await assert.rejects(stubClient().uploadWorld({ ...base(good), thumbPath: null }, noop, noop), /thumbnail/);
  await assert.rejects(stubClient().uploadWorld({ ...base(good), worldId: OTHER }, noop, noop), /made for/);
  await assert.rejects(stubClient().uploadWorld({ ...base(good), recommendedCapacity: 40 }, noop, noop), /Recommended capacity/);
  await assert.rejects(stubClient().uploadWorld({ ...base(good), capacity: 0 }, noop, noop), /Maximum capacity/);
  await assert.rejects(stubClient({ world: { id: WORLD, authorId: 'usr_someone' } }).uploadWorld(base(good), noop, noop), /another account/);
  const vrca = writeBundle(path.join(tmp, 'x.vrca'), WORLD);
  await assert.rejects(stubClient().uploadWorld(base(vrca), noop, noop), /\.vrcw/);
  // VRChat handing back a different ID: the stray record is removed again
  c = stubClient({ created: { id: OTHER } });
  await assert.rejects(c.uploadWorld(base(good), noop, noop), /instead of/);
  assert.ok(c.calls.some(([m, p]) => m === 'DELETE' && p === `worlds/${OTHER}`));
  console.log('world refusals ok');

  // ── bundle without an ID still uploads, with a warning ──
  const logs = [];
  c = stubClient();
  await c.uploadWorld(base(bare), (l, m) => logs.push([l, m]), noop);
  assert.ok(logs.some(([l, m]) => l === 'warn' && /No world ID/.test(m)));
  console.log('world without baked ID ok');

  // ── update reuses file records and only sends changed details ──
  const remote = {
    id: WORLD, authorId: ME.id, name: 'My World', description: 'hi', tags: [], capacity: 20, recommendedCapacity: 16,
    imageUrl: 'https://api.vrchat.cloud/api/1/file/file_cccccccc-0000-0000-0000-000000000000/3/file',
    unityPackages: [
      { platform: 'android', assetUrl: 'https://api.vrchat.cloud/api/1/file/file_dddddddd-0000-0000-0000-000000000000/1/file', unitySortNumber: 1 },
      { platform: 'standalonewindows', assetUrl: 'https://api.vrchat.cloud/api/1/file/file_eeeeeeee-0000-0000-0000-000000000000/2/file', unitySortNumber: 2 },
    ],
  };
  c = stubClient({ world: remote, agreed: true });
  await c.uploadWorld(base(good), noop, noop);
  assert.ok(!c.calls.some(([m, p]) => m === 'POST' && (p === 'worlds' || p === 'agreement')), 'no new record or agreement');
  const puts = c.calls.filter(([m]) => m === 'PUT').map(([, , b]) => b);
  assert.deepStrictEqual(puts[0], { capacity: 32 });
  assert.ok(puts.some((b) => b.imageUrl));
  assert.deepStrictEqual(Object.keys(puts[puts.length - 1]).sort(), ['assetUrl', 'assetVersion', 'platform', 'unityVersion']);
  const files = c.calls.filter(([m]) => m === 'FILE');
  assert.strictEqual(files.find(([, ext]) => ext === '.png')[2], 'file_cccccccc-0000-0000-0000-000000000000');
  assert.strictEqual(files.find(([, ext]) => ext === '.vrcw')[2], 'file_eeeeeeee-0000-0000-0000-000000000000');
  console.log('world update ok');

  // ── multipart resume point ──
  const big = path.join(tmp, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(16));
  const file = { id: 'file_x', versions: [{}, { file: { category: 'multipart' } }] };
  const resumeWith = async (status) => {
    const m = new VrcClient({ userAgent: 'test' });
    m.get = async () => status;
    m.put = async () => { throw new Error('should not reach storage'); };
    return m._sendFile(file, 'file', big, 'application/x-world', Buffer.alloc(16), noop);
  };
  await assert.rejects(resumeWith({ nextPartNumber: 5, etags: ['a', 'b', 'c', 'd', 'e'] }), /resume point/);
  await assert.rejects(resumeWith({ nextPartNumber: 1, etags: [] }), /resume point/);
  await assert.rejects(resumeWith({ nextPartNumber: -1 }), /resume point/);
  // a valid, finished resume point goes straight to finish
  const done = new VrcClient({ userAgent: 'test' });
  let finished = null;
  done.get = async () => ({ nextPartNumber: 1, etags: ['abc'] });
  done.put = async (p, body) => { finished = [p, body]; return {}; };
  await done._sendFile(file, 'file', big, 'application/x-world', Buffer.alloc(16), noop);
  assert.deepStrictEqual(finished, ['file/file_x/1/file/finish', { etags: ['abc'] }]);
  console.log('multipart resume check ok');
})().catch((e) => { console.error(e); process.exit(1); });
