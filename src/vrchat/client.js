'use strict';
// Port of the upload flow in com.vrchat.base VRCApi.cs (SDK 3.10.x).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { writeSignature } = require('./rsync-sig');
const { readBundleInfo, inspectBundle, readBlueprintIds } = require('../unity/bundle');
const { checkBundleSize, formatSize } = require('./limits');

const BASE = 'https://api.vrchat.cloud/api/1/';
const PART_SIZE = 100 * 1024 * 1024;
// Taken from VRCCopyrightAgreement.cs (SDK 3.10.5). The API rejects the POST without
// agreementFulltext, and it must be the same text the user is shown and confirms in the UI.
const AGREEMENT_CODE = 'content.copyright.owned';
const AGREEMENT_VERSION = 1;
const ASSET_API_VERSION = 1;        // ApiAvatar.VERSION.ApiVersion in the SDK
const WORLD_API_VERSION = 4;        // ApiWorld.VERSION.ApiVersion in the SDK
const SERVER_ENVIRONMENT = 'Release'; // API.GetServerEnvironmentForApiUrl() for api.vrchat.cloud
// Used only when neither the form nor the bundle header gives a usable Unity version.
const DEFAULT_UNITY_VERSION = '2022.3.22f1';
const UNITY_VERSION_RE = /^\d{4}\.\d+\.\d+[abfpx]\d+$/;
const WORLD_ID_RE = /^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGREEMENT_TEXT = 'By clicking OK, I certify that I have the necessary rights to upload this content and that it will not infringe on any third-party legal or intellectual property rights.';
const MIME = {
  '.vrca': 'application/x-avatar',
  '.vrcw': 'application/x-world',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.sig': 'application/x-rsync-signature',
};

class VrcError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
class UploadError extends Error {}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new UploadError('Cancelled')); }, { once: true });
});

const md5 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('md5');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest())).on('error', reject);
});

let uaValue = 'AvatarUploader';
const UA = () => uaValue;
function putBuffer(url, buf, headers, onProgress, signal, logFn) {
  const host = (() => { try { return new URL(url).host; } catch { return 'storage'; } })();
  logFn?.('debug', `→ PUT storage ${host} (${(buf.length / 1048576).toFixed(2)} MB) · headers [${['User-Agent', ...Object.keys(headers), 'Content-Length'].join(', ')}]`);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), { method: 'PUT', headers: { 'User-Agent': UA(), ...headers, 'Content-Length': buf.length } }, (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 4096) body += d; });
      res.on('end', () => {
        const ms = Date.now() - t0;
        if (res.statusCode < 300) {
          logFn?.('debug', `← PUT storage ${host} ${res.statusCode} (${ms}ms)`);
          resolve(res.headers);
        } else {
          logFn?.('error', `← PUT storage ${host} ${res.statusCode} (${ms}ms)`);
          const code = (body.match(/<Code>([^<]*)<\/Code>/) || [])[1], msg = (body.match(/<Message>([^<]*)<\/Message>/) || [])[1];
          if (code) logFn?.('error', `storage said: ${code}${msg ? ' - ' + msg : ''}`);
          reject(new UploadError(`Storage rejected the upload (HTTP ${res.statusCode}${code ? ', ' + code : ''}).`));
        }
      });
    });
    req.on('error', (e) => { logFn?.('error', `← PUT storage ${host} network error: ${e.message || e}`); reject(e); });
    signal?.addEventListener('abort', () => req.destroy(new UploadError('Cancelled')), { once: true });
    let sent = 0;
    const CH = 1 << 20;
    (function write() {
      while (sent < buf.length) {
        const end = Math.min(sent + CH, buf.length);
        const ok = req.write(buf.subarray(sent, end));
        sent = end;
        onProgress?.(sent / buf.length);
        if (!ok) return req.once('drain', write);
      }
      req.end();
    })();
  });
}

// file record helpers (versions[0] is a placeholder, so the latest index is length - 1)
const lastIdx = (f) => (f.versions?.length || 0) - 1;
const lastVer = (f) => f.versions[lastIdx(f)];
const hasVersion = (f) => lastIdx(f) > 0 && !lastVer(f).deleted;
const anyStatus = (f, s) => hasVersion(f) && [lastVer(f).status, lastVer(f).file?.status, lastVer(f).signature?.status].includes(s);
const fileIdFromUrl = (u) => (u || '').match(/\/file\/(file_[0-9a-f-]+)/i)?.[1] || '';

/**
 * Picks the Unity version to report: the one typed in the form, else the bundle header's,
 * else a default. A typed version that is malformed is an error; a missing or unreadable
 * header only falls back with a warning.
 */
function resolveUnityVersion(given, fromBundle, log) {
  const typed = String(given || '').trim();
  if (typed) {
    if (!UNITY_VERSION_RE.test(typed)) throw new UploadError(`"${typed}" is not a Unity version (for example ${DEFAULT_UNITY_VERSION}).`);
    return typed;
  }
  if (UNITY_VERSION_RE.test(fromBundle || '')) return fromBundle;
  log('warn', `Could not read a Unity version from the bundle header; using ${DEFAULT_UNITY_VERSION}.`);
  return DEFAULT_UNITY_VERSION;
}

// Compact JSON for log lines (no secrets, truncated).
function summarizePayload(v, max = 400) {
  if (v === undefined || v === null) return '';
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  if (s.length > max) s = s.slice(0, max) + '…';
  // Redact common secret-ish fields if they appear in bodies
  s = s.replace(/"(authCookie|token|password|code)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
  return s;
}

class VrcClient {
  constructor({ userAgent, onLog } = {}) {
    this.ua = userAgent;
    uaValue = userAgent;
    this.cookies = {};
    this.user = null;
    this.extraHeaders = {};
    this.onLog = typeof onLog === 'function' ? onLog : null;
  }

  log(level, msg) {
    if (this.onLog) this.onLog(level, msg);
  }

  exportCookies() { return { ...this.cookies }; }
  importCookies(c) { this.cookies = { ...(c || {}) }; }

  async _req(method, target, { query, json, headers = {}, signal } = {}) {
    const url = new URL(target.startsWith('http') ? target : BASE + target);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const h = { 'User-Agent': this.ua, Accept: 'application/json', ...headers };
    if (url.host === 'api.vrchat.cloud') Object.assign(h, this.extraHeaders, headers);
    const isApi = url.host === 'api.vrchat.cloud';
    if (isApi && Object.keys(this.cookies).length) {
      h.Cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }

    const pathLabel = url.pathname + (url.search || '');
    const reqBits = [`→ ${method} ${pathLabel}`];
    if (json !== undefined) reqBits.push(`body ${summarizePayload(json)}`);
    // Never log Cookie / Authorization values
    const headerKeys = Object.keys(h).filter((k) => !/^(cookie|authorization)$/i.test(k));
    if (headerKeys.length) reqBits.push(`headers [${headerKeys.join(', ')}]`);
    this.log('debug', reqBits.join(' · '));

    const t0 = Date.now();
    let res;
    try {
      res = await fetch(url, { method, headers: h, body, signal });
    } catch (e) {
      this.log('error', `← ${method} ${pathLabel} network error: ${e.message || e}`);
      throw e;
    }
    if (isApi) {
      for (const sc of res.headers.getSetCookie?.() || []) {
        const pair = sc.split(';')[0];
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (k === 'auth' || k === 'twoFactorAuth') { if (v) this.cookies[k] = v; else delete this.cookies[k]; }
      }
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    const ms = Date.now() - t0;
    const level = res.ok ? 'debug' : 'error';
    const summary = summarizePayload(data, res.ok ? 300 : 600);
    this.log(level, `← ${method} ${pathLabel} ${res.status} (${ms}ms)${summary ? ' · ' + summary : ''}`);
    if (!res.ok) throw new VrcError(data?.error?.message || data?.message || `HTTP ${res.status}`, res.status);
    return data;
  }
  get(p, o) { return this._req('GET', p, o); }
  post(p, json, o) { return this._req('POST', p, { ...o, json }); }
  put(p, json, o) { return this._req('PUT', p, { ...o, json }); }
  del(p, o) { return this._req('DELETE', p, o); }

  // ---- auth ----
  async login(username, password) {
    const basic = Buffer.from(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`).toString('base64');
    const r = await this.get('auth/user', { headers: { Authorization: `Basic ${basic}` } });
    if (r.requiresTwoFactorAuth) return { needs2fa: r.requiresTwoFactorAuth };
    this.user = r;
    return { user: r };
  }
  async verify2fa(method, code) {
    if (!['totp', 'emailotp', 'otp'].includes(method)) throw new VrcError('Unknown two-factor method.', 400);
    const r = await this.post(`auth/twofactorauth/${method}/verify`, { code });
    if (!r.verified) throw new VrcError('That code was not accepted.', 400);
    return this.me();
  }
  async me() {
    const r = await this.get('auth/user');
    if (r.requiresTwoFactorAuth) return null;
    this.user = r;
    return r;
  }
  async logout() {
    try { await this.put('logout'); } catch { /* session may already be gone */ }
    this.cookies = {}; this.user = null;
  }

  // ---- avatars ----
  async listAvatars() {
    const out = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await this.get('avatars', { query: { user: 'me', releaseStatus: 'all', sort: 'updated', order: 'descending', n: 100, offset } });
      out.push(...page);
      if (page.length < 100) break;
    }
    return out;
  }
  getAvatar(id) { return this.get(`avatars/${id}`); }

  // Reserves an avatar ID. Put it in the PipelineManager before building in Unity.
  createAvatarRecord({ id, name, description, tags, releaseStatus, platform, unityVersion }) {
    return this.post('avatars', {
      ...(id ? { id } : {}),
      name, description: description || '', tags: tags || [], releaseStatus: releaseStatus || 'private',
      platform, unityVersion, assetVersion: 1,
    });
  }

  // Creates a record for the ID that is already baked into a bundle. If VRChat hands back a
  // different ID the bundle would not match it, so the new record is removed and an error is thrown.
  async createRecordForBundle(o) {
    const rec = await this.createAvatarRecord(o);
    if (o.id && rec.id !== o.id) {
      try { await this.del(`avatars/${rec.id}`); } catch { /* best effort */ }
      throw new UploadError('VRChat would not create a record with the ID stored in this bundle. Reserve an ID first (New avatar), put it in Unity and rebuild.');
    }
    return rec;
  }

  async ensureAgreement(avatarId, confirmed, log) {
    const r = await this.get('agreement', { query: { agreementCode: AGREEMENT_CODE, contentId: avatarId, version: AGREEMENT_VERSION } });
    if (r?.agreed) return;
    if (!confirmed) throw new UploadError('Confirm that you have the rights to upload this avatar before continuing.');
    log('info', 'Recording your rights confirmation for this avatar.');
    const res = await this.post('agreement', {
      agreementCode: AGREEMENT_CODE,
      agreementFulltext: AGREEMENT_TEXT,
      contentId: avatarId,
      version: AGREEMENT_VERSION,
    });
    if (res && res.contentId && res.contentId !== avatarId) throw new UploadError('VRChat recorded the agreement for a different content ID.');
  }

  // ---- files ----
  async uploadFile(filePath, fileId, friendlyName, onProgress, log, signal) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const creating = !fileId;
    let file = creating
      ? await this.post('file', { name: friendlyName, mimeType: mime, extension: ext }, { signal })
      : await this.get(`file/${fileId}`, { signal });
    if (!file.id) throw new UploadError('VRChat did not return a file record.');
    const id = file.id;
    const refetch = async () => { file = await this.get(`file/${id}`, { signal }); };
    const dropLatest = async () => { await this.del(`file/${id}/${lastIdx(file)}`, { signal }); await sleep(1000, signal); await refetch(); };

    onProgress('Preparing file', 0);
    if (hasVersion(file) && anyStatus(file, 'queued') && !anyStatus(file, 'waiting')) { log('debug', 'Removing an unfinished earlier upload.'); await dropLatest(); }
    if (hasVersion(file) && anyStatus(file, 'error')) { log('debug', 'Removing a failed earlier upload.'); await dropLatest(); }

    onProgress('Hashing file', 0.05);
    const fileMd5 = (await md5(filePath)).toString('base64');
    const fileSize = fs.statSync(filePath).size;
    const sigPath = path.join(os.tmpdir(), `avu-${crypto.randomUUID()}.sig`);
    try {
      await writeSignature(filePath, sigPath, signal);
      const sigMd5 = (await md5(sigPath)).toString('base64');
      const sigSize = fs.statSync(sigPath).size;

      onProgress('Checking existing versions', 0.1);
      let retrying = false;
      if (hasVersion(file)) {
        if (lastVer(file).file?.md5 === fileMd5) {
          if (!anyStatus(file, 'waiting')) throw new UploadError('This exact file was already uploaded. Build a new version first.');
          retrying = true;
        } else if (anyStatus(file, 'waiting')) {
          await dropLatest();
        }
      }
      let reuse = false;
      if (retrying) {
        const v = lastVer(file);
        reuse = v.file.sizeInBytes === fileSize && v.file.md5 === fileMd5 && v.signature.sizeInBytes === sigSize && v.signature.md5 === sigMd5;
        if (!reuse) await dropLatest();
      }
      if (!reuse) {
        const updated = await this.post(`file/${id}`, {
          signatureMd5: sigMd5, signatureSizeInBytes: sigSize, fileMd5, fileSizeInBytes: fileSize,
        }, { signal });
        if (!updated.id) throw new UploadError('Could not create a new file version.');
        file = updated;
        await sleep(1000, signal);
      }

      const part = (kind, start, end) => (p, f) => onProgress(p, start + f * (end - start));
      const ver = lastVer(file);
      if (ver.file.status !== 'waiting') throw new UploadError('This file was already uploaded. Build a new version first.');
      await this._sendFile(file, 'file', filePath, mime, (await md5(filePath)), part('file', 0.15, 0.9), signal);
      if (lastVer(file).signature.status === 'waiting') {
        await this._sendFile(file, 'signature', sigPath, MIME['.sig'], Buffer.from(sigMd5, 'base64'), part('signature', 0.9, 0.98), signal);
      }
      onProgress('Finishing up', 0.98);
      await sleep(5000, signal);
      await refetch();
      // The SDK's file helper keeps polling while the server still reports the version as queued.
      const budget = Math.min(600, Math.max(120, Math.ceil(fileSize / (50 * 1048576)) * 120)) * 1000;
      const started = Date.now();
      for (let delay = 2000; anyStatus(file, 'queued') && !anyStatus(file, 'waiting'); delay = Math.min(delay * 2, 10000)) {
        if (Date.now() - started > budget) { log('warn', 'VRChat is still processing this file; continuing.'); break; }
        onProgress('Processing upload', 0.99);
        await sleep(delay, signal);
        await refetch();
      }
      const ver2 = lastVer(file);
      log('info', `File ${id}: version ${lastIdx(file)} is ${ver2.status || 'n/a'} (file ${ver2.file?.status}, signature ${ver2.signature?.status}).`);
      onProgress('File ready', 1);
      return lastVer(file).file.url;
    } catch (e) {
      if (creating && id) { try { await this.del(`file/${id}`); } catch { /* best effort */ } }
      throw e;
    } finally {
      fs.promises.unlink(sigPath).catch(() => {});
    }
  }

  async _sendFile(file, type, srcPath, mime, md5Bytes, onProgress, signal) {
    const base = `file/${file.id}/${lastIdx(file)}/${type}`;
    const category = lastVer(file)[type].category;
    const size = fs.statSync(srcPath).size;
    if (category === 'simple') {
      const { url } = await this.put(`${base}/start`, undefined, { signal });
      if (!url) throw new UploadError('No upload URL was returned.');
      const buf = await fs.promises.readFile(srcPath);
      await putBuffer(url, buf, { 'Content-Type': mime, 'Content-MD5': md5Bytes.toString('base64') },
        (f) => onProgress(`Uploading ${type}`, f), signal, (l, m) => this.log(l, m));
      await this.put(`${base}/finish`, undefined, { signal });
      return;
    }
    // multipart: parts = max(1, floor(size / 100 MB)); the last part takes the remainder
    const status = await this.get(`${base}/status`, { signal });
    const etags = [...(status.etags || [])];
    const parts = Math.max(1, Math.floor(size / PART_SIZE));
    const next = Number(status.nextPartNumber || 0);
    // A resumed upload must line up with this file's part count, or the finish call would
    // stitch together parts from a different file.
    if (!Number.isInteger(next) || next < 0 || next > parts || etags.length !== next) {
      throw new UploadError(`VRChat reported an unusable resume point (part ${next} of ${parts}, ${etags.length} parts recorded). Try the upload again.`);
    }
    const fh = await fs.promises.open(srcPath, 'r');
    try {
      for (let n = next + 1; n <= parts; n++) {
        const { url } = await this.put(`${base}/start`, undefined, { query: { partNumber: n }, signal });
        if (!url) throw new UploadError('No upload URL was returned.');
        const pos = (n - 1) * PART_SIZE;
        const len = n < parts ? PART_SIZE : size - pos;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        // The SDK sends multipart parts with no Content-Type and no Content-MD5; the presigned part URL is not signed for them.
        const headers = await putBuffer(url, buf, {}, (f) => onProgress(`Uploading ${type} (part ${n}/${parts})`, (n - 1 + f) / parts), signal, (l, m) => this.log(l, m));
        if (headers.etag) etags.push(String(headers.etag).replace(/["']/g, ''));
        await sleep(1000, signal);
      }
    } finally { await fh.close(); }
    await this.put(`${base}/finish`, { etags }, { signal });
  }

  // ---- full avatar upload ----
  async uploadAvatar(o, log, progress, signal) {
    const me = this.user || await this.me();
    if (!me) throw new UploadError('You are signed out. Sign in again.');
    if (!fs.existsSync(o.bundlePath)) throw new UploadError('The avatar bundle could not be found.');
    if (path.extname(o.bundlePath).toLowerCase() !== '.vrca') throw new UploadError('Choose a .vrca file.');
    const info = readBundleInfo(o.bundlePath);
    const unityVersion = resolveUnityVersion(o.unityVersion, info.unityVersion, log);
    log('info', `Bundle built with Unity ${info.unityVersion || 'unknown'} (${(info.size / 1048576).toFixed(1)} MB).`);
    this._validateBundle(o, info, log);

    // Honest metadata about what is being uploaded; no SDK identity is claimed.
    this.extraHeaders = { 'X-Platform': o.platform, 'X-Unity-Version': unityVersion };
    try { return await this._uploadAvatar(o, me, unityVersion, log, progress, signal); } finally { this.extraHeaders = {}; }
  }

  /**
   * The checks the SDK makes before it uploads. Publishing an avatar that fails them is not
   * rejected on upload; it is accepted and then shown as "Security Checks Failed".
   */
  _validateBundle(o, info, log) {
    let stats = null;
    try { stats = inspectBundle(o.bundlePath); } catch (e) { log('debug', `Could not inspect the bundle: ${e.message}`); }

    if (stats?.platform && stats.platform !== o.platform) {
      const names = { standalonewindows: 'PC', android: 'Android', ios: 'iOS' };
      throw new UploadError(`This bundle was built for ${names[stats.platform]}, but ${names[o.platform] || o.platform} is selected. Choose the matching platform.`);
    }
    const sizes = checkBundleSize({ platform: o.platform, fileSize: info.size, uncompressedSize: stats?.uncompressedSize });
    if (sizes.downloadOver) {
      throw new UploadError(`Avatar download size is too large for the target platform. ${formatSize(info.size)} > ${formatSize(sizes.limits.download)}`);
    }
    if (stats) log('debug', `Bundle: ${formatSize(info.size)} download, ${formatSize(stats.uncompressedSize)} uncompressed, platform ${stats.platform || 'unknown'}.`);
    if (sizes.uncompressedOver) {
      log('warn', `Avatar uncompressed size is too large for the target platform: ${formatSize(stats.uncompressedSize)} > ${formatSize(sizes.limits.uncompressed)}. VRChat will most likely mark it as failing its security checks.`);
    }
  }

  /**
   * Logs what VRChat's servers say about the uploaded package, waiting briefly for its scan.
   * Informational only: never throws.
   */
  async reportServerStatus(contentId, platform, log, kind = 'avatar') {
    let last = '';
    try {
      for (let attempt = 0; attempt < 36; attempt++) {
        const a = kind === 'world' ? await this.getWorld(contentId) : await this.getAvatar(contentId);
        if (!a) throw new Error('record not found');
        const mine = (a.unityPackages || []).filter((p) => p.platform === platform);
        const pkg = mine.filter((p) => (p.variant || 'standard').toLowerCase() === 'standard').pop() || mine.pop();
        if (!pkg) {
          if (attempt === 0) log('info', `VRChat has not attached a build to this ${kind} yet.`);
        } else {
          const { assetUrl, ...rest } = pkg;
          const summary = `scanStatus=${pkg.scanStatus ?? 'n/a'}, performanceRating=${pkg.performanceRating ?? 'n/a'}, variant=${pkg.variant ?? 'standard'}, assetVersion=${pkg.assetVersion}`;
          if (summary !== last) {
            last = summary;
            const bad = pkg.scanStatus && !['passed', 'pending', 'queued', 'scanning'].includes(String(pkg.scanStatus).toLowerCase());
            log(bad ? 'warn' : 'info', `VRChat's record for this build: ${summary}`);
            log('info', `Full record: ${JSON.stringify(rest)}`);
          }
          if (kind === 'world') return; // worlds get no performance rating to wait for
          const rated = pkg.performanceRating && pkg.performanceRating !== 'None';
          if (rated && (!pkg.scanStatus || String(pkg.scanStatus).toLowerCase() !== 'pending')) return;
        }
        await sleep(attempt < 6 ? 5000 : 10000);
      }
      log('info', `Stopped watching VRChat's record for this build (${last || 'no package attached'}).`);
    } catch (e) {
      log('debug', `Could not read the server record: ${e.message}`);
    }
  }

  async _uploadAvatar(o, me, unityVersion, log, progress, signal) {
    let remote = await this.getAvatar(o.avatarId);
    if (remote.authorId !== me.id) throw new UploadError('This avatar record belongs to another account. Pick one of your own.');
    await this.ensureAgreement(o.avatarId, o.rightsConfirmed, log);

    const name = o.name || remote.name;
    const tags = o.tags || remote.tags || [];
    const releaseStatus = o.releaseStatus || remote.releaseStatus || 'private';
    // Same naming scheme the SDK uses: "<unity>_<api version>_<platform>_<server environment>"
    const tag = (kind) => `Avatar - ${name} - ${kind} - ${unityVersion}_${ASSET_API_VERSION}_${o.platform}_${SERVER_ENVIRONMENT}`;
    const fresh = !!remote.pendingUpload;

    if (fresh) {
      if (!o.thumbPath) throw new UploadError('A thumbnail is required for the first upload.');
      log('info', 'Uploading bundle for a new avatar.');
      const bundleUrl = await this.uploadFile(o.bundlePath, '', tag('Asset bundle'), (l, f) => progress(l, f * 0.5), log, signal);
      log('info', 'Uploading thumbnail.');
      const imageUrl = await this.uploadFile(o.thumbPath, '', tag('Image'), (l, f) => progress(l, 0.5 + f * 0.5), log, signal);
      await this.put(`avatars/${o.avatarId}`, {
        name, description: o.description ?? '', assetUrl: bundleUrl, imageUrl, tags, releaseStatus,
        platform: o.platform, unityVersion, assetVersion: 1,
      }, { signal });
      return o.avatarId;
    }

    if (name !== remote.name || (o.description ?? remote.description) !== remote.description
      || JSON.stringify(tags) !== JSON.stringify(remote.tags || []) || releaseStatus !== remote.releaseStatus) {
      log('info', 'Updating avatar details.');
      await this.put(`avatars/${o.avatarId}`, {
        name, description: o.description ?? remote.description ?? '', tags, releaseStatus,
        primaryStyle: remote.styles?.primary ?? '', secondaryStyle: remote.styles?.secondary ?? '',
      }, { signal });
    }
    const hasThumb = !!o.thumbPath;
    if (hasThumb) {
      log('info', 'Uploading thumbnail.');
      const imageUrl = await this.uploadFile(o.thumbPath, fileIdFromUrl(remote.imageUrl), tag('Image'), (l, f) => progress(l, f * 0.5), log, signal);
      await this.put(`avatars/${o.avatarId}`, { imageUrl }, { signal });
    }
    // Reuse the existing file record for this platform when there is one
    const existing = (remote.unityPackages || [])
      .filter((p) => p.platform === o.platform && (p.variant || 'standard').toLowerCase() !== 'impostor')
      .sort((a, b) => (a.unitySortNumber || 0) - (b.unitySortNumber || 0)).pop();
    log('info', 'Uploading bundle.');
    const bundleUrl = await this.uploadFile(o.bundlePath, fileIdFromUrl(existing?.assetUrl), tag('Asset bundle'),
      (l, f) => progress(l, hasThumb ? 0.5 + f * 0.5 : f), log, signal);
    await this.put(`avatars/${o.avatarId}`, { assetUrl: bundleUrl, platform: o.platform, unityVersion, assetVersion: 1 }, { signal });
    return o.avatarId;
  }

  // ---- worlds ----
  async listWorlds() {
    const out = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await this.get('worlds', { query: { user: 'me', releaseStatus: 'all', sort: 'updated', order: 'descending', n: 100, offset } });
      out.push(...page);
      if (page.length < 100) break;
    }
    return out;
  }

  /** The world record, or null when VRChat has none with this ID yet. */
  async getWorld(id) {
    try { return await this.get(`worlds/${id}`); } catch (e) { if (e.status === 404) return null; throw e; }
  }

  /**
   * Uploads a .vrcw built with the VRChat SDK. Unlike avatars there is no reserve step: the SDK
   * bakes a wrld_ ID into the build, and the record is created with that ID on the first upload.
   */
  async uploadWorld(o, log, progress, signal) {
    const me = this.user || await this.me();
    if (!me) throw new UploadError('You are signed out. Sign in again.');
    if (!fs.existsSync(o.bundlePath)) throw new UploadError('The world bundle could not be found.');
    if (path.extname(o.bundlePath).toLowerCase() !== '.vrcw') throw new UploadError('Choose a .vrcw file.');
    if (!WORLD_ID_RE.test(o.worldId || '')) throw new UploadError('A full wrld_ ID is needed to upload a world.');
    const info = readBundleInfo(o.bundlePath);
    const unityVersion = resolveUnityVersion(o.unityVersion, info.unityVersion, log);
    log('info', `World bundle built with Unity ${info.unityVersion || 'unknown'} (${(info.size / 1048576).toFixed(1)} MB).`);
    this._validateWorldBundle(o, log);
    const capacity = this._validateCapacity(o);

    this.extraHeaders = { 'X-Platform': o.platform, 'X-Unity-Version': unityVersion };
    try { return await this._uploadWorld(o, me, unityVersion, capacity, log, progress, signal); } finally { this.extraHeaders = {}; }
  }

  /** Platform must match the build, and the ID baked into the build must be the target world's. */
  _validateWorldBundle(o, log) {
    let stats = null;
    try { stats = inspectBundle(o.bundlePath); } catch (e) { log('debug', `Could not inspect the bundle: ${e.message}`); }
    if (stats?.platform && stats.platform !== o.platform) {
      const names = { standalonewindows: 'PC', android: 'Android', ios: 'iOS' };
      throw new UploadError(`This world was built for ${names[stats.platform]}, but ${names[o.platform] || o.platform} is selected. Choose the matching platform.`);
    }
    if (stats) log('debug', `World bundle: ${formatSize(fs.statSync(o.bundlePath).size)} download, ${formatSize(stats.uncompressedSize)} uncompressed, platform ${stats.platform || 'unknown'}.`);

    const target = o.worldId.toLowerCase();
    const { ids, note } = readBlueprintIds(o.bundlePath, 'world');
    if (ids.length && !ids.includes(target)) {
      throw new UploadError(`This build was made for ${ids[0]}, not ${o.worldId}. Open that world instead, or set the PipelineManager ID in Unity and rebuild.`);
    }
    if (!ids.length) log('warn', `${note} Uploading as-is; if VRChat rejects it, build and upload once with the SDK so it assigns the ID.`);
  }

  _validateCapacity(o) {
    const capacity = Number(o.capacity);
    const recommended = Number(o.recommendedCapacity);
    if (!Number.isInteger(capacity) || capacity < 1) throw new UploadError('Maximum capacity must be a whole number of at least 1.');
    if (!Number.isInteger(recommended) || recommended < 1 || recommended > capacity) {
      throw new UploadError('Recommended capacity must be between 1 and the maximum capacity.');
    }
    return { capacity, recommendedCapacity: recommended };
  }

  async _uploadWorld(o, me, unityVersion, { capacity, recommendedCapacity }, log, progress, signal) {
    const remote = await this.getWorld(o.worldId);
    if (remote && remote.authorId !== me.id) throw new UploadError('This world record belongs to another account. Pick one of your own.');
    await this.ensureAgreement(o.worldId, o.rightsConfirmed, log);

    const name = o.name || remote?.name;
    if (!name) throw new UploadError('Name the world before uploading.');
    const description = o.description ?? remote?.description ?? '';
    const tags = o.tags || remote?.tags || [];
    const tag = (kind) => `World - ${name} - ${kind} - ${unityVersion}_${WORLD_API_VERSION}_${o.platform}_${SERVER_ENVIRONMENT}`;

    if (!remote) {
      if (!o.thumbPath) throw new UploadError('A thumbnail is required for the first upload.');
      log('info', 'Uploading bundle for a new world.');
      const bundleUrl = await this.uploadFile(o.bundlePath, '', tag('Asset bundle'), (l, f) => progress(l, f * 0.85), log, signal);
      log('info', 'Uploading thumbnail.');
      const imageUrl = await this.uploadFile(o.thumbPath, '', tag('Image'), (l, f) => progress(l, 0.85 + f * 0.15), log, signal);
      let rec;
      try {
        // New worlds start private, as in the SDK. Publishing goes through Community Labs on the website.
        rec = await this.post('worlds', {
          id: o.worldId, name, description, tags, releaseStatus: 'private', capacity, recommendedCapacity,
          assetUrl: bundleUrl, imageUrl, platform: o.platform, unityVersion, assetVersion: WORLD_API_VERSION,
        }, { signal });
      } catch (e) {
        for (const u of [bundleUrl, imageUrl]) { const id = fileIdFromUrl(u); if (id) await this.del(`file/${id}`).catch(() => {}); }
        throw e;
      }
      if (rec?.id && rec.id !== o.worldId) {
        try { await this.del(`worlds/${rec.id}`); } catch { /* best effort */ }
        throw new UploadError(`VRChat created the world as ${rec.id} instead of ${o.worldId}, which would not match the build, so it was removed again.`);
      }
      return o.worldId;
    }

    const details = {};
    if (name !== remote.name) details.name = name;
    if (description !== (remote.description || '')) details.description = description;
    if (JSON.stringify(tags) !== JSON.stringify(remote.tags || [])) details.tags = tags;
    if (capacity !== remote.capacity) details.capacity = capacity;
    if (recommendedCapacity !== remote.recommendedCapacity) details.recommendedCapacity = recommendedCapacity;
    if (Object.keys(details).length) {
      log('info', 'Updating world details.');
      await this.put(`worlds/${o.worldId}`, details, { signal });
    }
    const hasThumb = !!o.thumbPath;
    if (hasThumb) {
      log('info', 'Uploading thumbnail.');
      const imageUrl = await this.uploadFile(o.thumbPath, fileIdFromUrl(remote.imageUrl), tag('Image'), (l, f) => progress(l, f * 0.15), log, signal);
      await this.put(`worlds/${o.worldId}`, { imageUrl }, { signal });
    }
    const existing = (remote.unityPackages || [])
      .filter((p) => p.platform === o.platform)
      .sort((a, b) => (a.unitySortNumber || 0) - (b.unitySortNumber || 0)).pop();
    log('info', 'Uploading bundle.');
    const bundleUrl = await this.uploadFile(o.bundlePath, fileIdFromUrl(existing?.assetUrl), tag('Asset bundle'),
      (l, f) => progress(l, hasThumb ? 0.15 + f * 0.85 : f), log, signal);
    await this.put(`worlds/${o.worldId}`, { assetUrl: bundleUrl, platform: o.platform, unityVersion, assetVersion: WORLD_API_VERSION }, { signal });
    return o.worldId;
  }
}

module.exports = { AGREEMENT_TEXT, VrcClient, VrcError, UploadError, resolveUnityVersion, DEFAULT_UNITY_VERSION };
