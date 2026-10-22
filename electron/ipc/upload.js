'use strict';
const fs = require('fs');
const { ipcMain } = require('electron');
const { readBlueprintIds, replaceBlueprintId } = require('../../src/unity/bundle');
const { prepareThumbnail } = require('../thumbnail');
const { send } = require('../window');
const { handle } = require('./util');

const log = (level, msg) => send('log', { level, msg });
let running = null; // AbortController of the active upload

/**
 * VRChat rejects a bundle whose baked-in blueprint ID differs from the target avatar.
 * Rewrites the ID into a temporary copy when needed.
 * @returns {{ path: string, temp: string|null }}
 */
function alignBlueprintId(bundlePath, avatarId) {
  const target = String(avatarId || '').toLowerCase();
  const ids = (readBlueprintIds(bundlePath).ids || []).map((x) => x.toLowerCase());
  if (target && ids.length && !ids.includes(target)) {
    log('info', `Rewriting pipeline ID in the bundle (${ids[0]} → ${avatarId})…`);
    const r = replaceBlueprintId(bundlePath, avatarId);
    log('info', `Replaced ${r.count} occurrence(s) of ${r.replaced.join(', ') || 'old ID'}.`);
    return { path: r.path, temp: r.path };
  }
  if (target && !ids.length) {
    log('warn', 'Could not find an avatar ID inside this bundle; uploading as-is. If the upload fails, rebuild with the correct PipelineManager ID.');
  }
  return { path: bundlePath, temp: null };
}

function register({ client }) {
  ipcMain.handle('upload:start', handle(async (options) => {
    if (running) throw new Error('An upload is already running.');
    running = new AbortController();
    let thumb = null;
    let temp = null;
    try {
      if (options.thumbPath) thumb = prepareThumbnail(options.thumbPath);
      const bundle = alignBlueprintId(options.bundlePath, options.avatarId);
      temp = bundle.temp;
      const id = await client.uploadAvatar(
        { ...options, bundlePath: bundle.path, thumbPath: thumb },
        log,
        (label, fraction) => send('progress', { label, fraction }),
        running.signal,
      );
      log('success', `Upload finished for ${id}.`);
      client.reportServerStatus(id, options.platform, log); // runs on in the background
      return { id };
    } finally {
      running = null;
      for (const f of [thumb, temp]) if (f) fs.unlink(f, () => {});
    }
  }));

  ipcMain.handle('upload:world', handle(async (options) => {
    if (running) throw new Error('An upload is already running.');
    running = new AbortController();
    let thumb = null;
    try {
      if (options.thumbPath) thumb = prepareThumbnail(options.thumbPath);
      const id = await client.uploadWorld(
        { ...options, thumbPath: thumb },
        log,
        (label, fraction) => send('progress', { label, fraction }),
        running.signal,
      );
      log('success', `Upload finished for ${id}.`);
      client.reportServerStatus(id, options.platform, log, 'world'); // runs on in the background
      return { id };
    } finally {
      running = null;
      if (thumb) fs.unlink(thumb, () => {});
    }
  }));

  ipcMain.handle('upload:cancel', () => { running?.abort(); });
}

module.exports = { register };
