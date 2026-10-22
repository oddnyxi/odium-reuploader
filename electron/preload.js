'use strict';
// The only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(['log', 'progress']);

contextBridge.exposeInMainWorld('api', {
  // account
  restore: invoke('auth:restore'),
  login: invoke('auth:login'),
  verify2fa: invoke('auth:verify2fa'),
  logout: invoke('auth:logout'),
  // avatars
  listAvatars: invoke('avatars:list'),
  reserveAvatar: invoke('avatars:reserve'),
  fromBundle: invoke('avatars:fromBundle'),
  // worlds
  listWorlds: invoke('worlds:list'),
  lookupWorld: invoke('worlds:lookup'),
  // files
  pick: invoke('pick:file'),
  bundleInfo: invoke('bundle:info'),
  bundleMesh: invoke('bundle:mesh'),
  rewriteBundle: invoke('bundle:rewrite'),
  imageDataUrl: invoke('image:dataUrl'),
  // upload
  upload: invoke('upload:start'),
  uploadWorld: invoke('upload:world'),
  cancel: invoke('upload:cancel'),
  on: (channel, cb) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});

contextBridge.exposeInMainWorld('odiumWin', {
  minimize: () => ipcRenderer.send('win:min'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMax'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMax'),
  onMaximizeChange: (cb) => ipcRenderer.on('win:max', (_e, maximized) => cb(maximized)),
});
