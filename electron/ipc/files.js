'use strict';
const path = require('path');
const { ipcMain, dialog, nativeImage } = require('electron');
const { readBundleInfo, inspectBundle, readBlueprintIds, replaceBlueprintId } = require('../../src/unity/bundle');
const { LIMITS } = require('../../src/vrchat/limits');
const { readMeshes } = require('../../src/unity/mesh');
const { getMainWindow } = require('../window');
const { handle } = require('./util');

const FILTERS = {
  bundle: [{ name: 'Avatar bundle', extensions: ['vrca'] }],
  world: [{ name: 'World bundle', extensions: ['vrcw'] }],
  any: [{ name: 'VRChat build', extensions: ['vrca', 'vrcw'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
};

function register() {
  ipcMain.handle('pick:file', handle(async (kind) => {
    const r = await dialog.showOpenDialog(getMainWindow(), { properties: ['openFile'], filters: FILTERS[kind] || FILTERS.image });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('bundle:info', handle((file) => {
    let stats = {};
    try { stats = inspectBundle(file); } catch { /* sizes and platform stay unknown */ }
    const world = path.extname(file).toLowerCase() === '.vrcw';
    return {
      ...readBundleInfo(file), ...readBlueprintIds(file, world ? 'world' : 'avatar'), ...stats,
      kind: world ? 'world' : 'avatar', limits: world ? null : LIMITS, name: path.basename(file),
    };
  }));
  ipcMain.handle('bundle:mesh', handle((file) => readMeshes(file)));
  ipcMain.handle('bundle:rewrite', handle((file, newId) => replaceBlueprintId(file, newId)));
  ipcMain.handle('image:dataUrl', handle((file) => nativeImage.createFromPath(file).resize({ width: 480 }).toDataURL()));
}

module.exports = { register };
