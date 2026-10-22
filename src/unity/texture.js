'use strict';
// Decodes Unity Texture2D pixel data to RGBA8. Row 0 is the BOTTOM row (Unity's origin),
// which matches WebGL's texture origin, so no flip is needed when uploading.
//
// Supported: Alpha8, RGB24, RGBA32, ARGB32, BGRA32, DXT1 (BC1), DXT5 (BC3), BC7, and the Crunch-compressed
// DXT1Crunched / DXT5Crunched / ETC_RGB4Crunched / ETC2_RGBA8Crunched formats (see crunch.js).
// Not supported (returns null): BC6H, ASTC, plain ETC/ETC2, PVRTC, etc.

const { decodeBC1, decodeBC3 } = require('./blockdec');
const { decodeBC7 } = require('./bc7');
const { CrunchTexture } = require('./crunch');

const TF = { Alpha8: 1, ARGB32: 5, RGB24: 3, RGBA32: 4, BGRA32: 14, DXT1: 10, DXT5: 12, BC7: 25, DXT1Crunched: 28, DXT5Crunched: 29, ETC_RGB4Crunched: 64, ETC2_RGBA8Crunched: 65 };
const CRUNCHED = new Set([28, 29, 64, 65]);

const isCrunched = (fmt) => CRUNCHED.has(fmt);
const isSupported = (fmt) => [1, 3, 4, 5, 10, 12, 14, 25].includes(fmt) || isCrunched(fmt);

function levelSize(fmt, w, h) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  switch (fmt) {
    case 1: return w * h;
    case 3: return w * h * 3;
    case 4: case 5: case 14: return w * h * 4;
    case 10: return bw * bh * 8;
    case 12: case 25: return bw * bh * 16;
    default: return 0;
  }
}

function decodeRaw(src, fmt, w, h) {
  const n = w * h, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    switch (fmt) {
      case 1: out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = src[i]; break;
      case 3: out[o] = src[i * 3]; out[o + 1] = src[i * 3 + 1]; out[o + 2] = src[i * 3 + 2]; out[o + 3] = 255; break;
      case 4: out[o] = src[i * 4]; out[o + 1] = src[i * 4 + 1]; out[o + 2] = src[i * 4 + 2]; out[o + 3] = src[i * 4 + 3]; break;
      case 5: out[o] = src[i * 4 + 1]; out[o + 1] = src[i * 4 + 2]; out[o + 2] = src[i * 4 + 3]; out[o + 3] = src[i * 4]; break;
      case 14: out[o] = src[i * 4 + 2]; out[o + 1] = src[i * 4 + 1]; out[o + 2] = src[i * 4]; out[o + 3] = src[i * 4 + 3]; break;
    }
  }
  return out;
}

// A Crunch texture holds its own mip chain, so pick the level from the .crn header rather than Unity's mip count.
// Throws CrunchError when the data cannot be decoded; the caller decides how to report it.
function decodeCrunched(raw, maxDim) {
  const tex = new CrunchTexture(raw);
  const { width, height, levels } = tex.info;
  let lvl = 0;
  while (lvl < levels - 1 && Math.max(width >> lvl, height >> lvl) > maxDim) lvl++;
  return tex.decodeLevelRGBA(lvl);
}

/**
 * @param {object} t  parsed Texture2D (m_Width, m_Height, m_TextureFormat, m_MipCount, 'image data')
 * @param {Buffer|null} stream  bytes from the .resS stream (when image data is external)
 * @param {number} maxDim  largest width to return; a smaller mip level is picked when one exists
 * @returns {{w:number,h:number,data:Uint8Array}|null}
 */
function decodeTexture(t, stream, maxDim = 1024) {
  const fmt = t.m_TextureFormat;
  if (!isSupported(fmt)) return null;
  const raw = t['image data'] && t['image data'].length ? t['image data'] : stream;
  if (!raw || !raw.length) return null;
  if (isCrunched(fmt)) return decodeCrunched(raw, maxDim);
  let w = t.m_Width, h = t.m_Height;
  const mips = Math.max(1, t.m_MipCount || 1);
  let off = 0, lvl = 0;
  while (lvl < mips - 1 && Math.max(w, h) > maxDim) {
    off += levelSize(fmt, w, h);
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); lvl++;
  }
  const need = levelSize(fmt, w, h);
  if (off + need > raw.length) return null;
  const slice = raw.subarray(off, off + need);
  const data = fmt === 10 ? decodeBC1(slice, w, h) : fmt === 12 ? decodeBC3(slice, w, h) : fmt === 25 ? decodeBC7(slice, w, h) : decodeRaw(slice, fmt, w, h);
  return { w, h, data };
}

module.exports = { decodeTexture, isCrunched, isSupported, TF };
