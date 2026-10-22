'use strict';
const { ipcMain } = require('electron');
const { handle } = require('./util');

const summarize = (a) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  tags: a.tags || [],
  releaseStatus: a.releaseStatus,
  pendingUpload: !!a.pendingUpload,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
  platforms: [...new Set((a.unityPackages || []).map((p) => p.platform))],
});

function register({ client }) {
  ipcMain.handle('avatars:list', handle(async () => (await client.listAvatars()).map(summarize)));

  ipcMain.handle('avatars:reserve', handle(async (options) => {
    const a = await client.createAvatarRecord(options);
    return { id: a.id, name: a.name };
  }));

  // Uses the account's existing record for the bundle's avatar ID, or creates one.
  ipcMain.handle('avatars:fromBundle', handle(async (options) => {
    if (!(await client.me())) throw new Error('You are signed out. Sign in again.');
    const existing = (await client.listAvatars()).find((a) => a.id === options.id);
    if (existing) return { id: existing.id, name: existing.name, existing: true, pendingUpload: !!existing.pendingUpload };
    const a = await client.createRecordForBundle(options);
    return { id: a.id, name: a.name || options.name, existing: false, pendingUpload: true };
  }));
}

module.exports = { register };
