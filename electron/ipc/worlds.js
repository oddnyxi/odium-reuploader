'use strict';
const { ipcMain } = require('electron');
const { handle } = require('./util');

const summarize = (w) => ({
  kind: 'world',
  id: w.id,
  name: w.name,
  description: w.description,
  tags: w.tags || [],
  releaseStatus: w.releaseStatus,
  capacity: w.capacity,
  recommendedCapacity: w.recommendedCapacity,
  pendingUpload: false,
  createdAt: w.created_at,
  updatedAt: w.updated_at,
  platforms: [...new Set((w.unityPackages || []).map((p) => p.platform))],
});

function register({ client }) {
  ipcMain.handle('worlds:list', handle(async () => (await client.listWorlds()).map(summarize)));

  // Looks up the world a build was made for: your existing record, or nothing yet (a first upload).
  ipcMain.handle('worlds:lookup', handle(async (id) => {
    const me = await client.me();
    if (!me) throw new Error('You are signed out. Sign in again.');
    const w = await client.getWorld(id);
    if (!w) return { exists: false };
    if (w.authorId !== me.id) throw new Error(`${id} belongs to another account. Rebuild with a new world ID.`);
    return { exists: true, world: summarize(w) };
  }));
}

module.exports = { register };
