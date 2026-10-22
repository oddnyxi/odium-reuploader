'use strict';
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const RATIO = 0.75; // 4:3, matching the SDK's thumbnail step

/**
 * Centre-crops an image to 4:3 and scales it to 800x600.
 * @returns {string} path of a temporary PNG; the caller deletes it.
 */
function prepareThumbnail(source) {
  const img = nativeImage.createFromPath(source);
  if (img.isEmpty()) throw new Error('The thumbnail image could not be read.');
  const { width, height } = img.getSize();
  let cropW = width;
  let cropH = Math.round(width * RATIO);
  if (cropH > height) { cropH = height; cropW = Math.round(height / RATIO); }
  const out = img
    .crop({ x: Math.floor((width - cropW) / 2), y: Math.floor((height - cropH) / 2), width: cropW, height: cropH })
    .resize({ width: 800, height: 600, quality: 'best' });
  const file = path.join(app.getPath('temp'), `odium-thumb-${Date.now()}.png`);
  fs.writeFileSync(file, out.toPNG());
  return file;
}

module.exports = { prepareThumbnail };
