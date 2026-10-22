'use strict';
const { ipcMain } = require('electron');
const session = require('../session');
const { handle, slimUser } = require('./util');

function register({ client }) {
  ipcMain.handle('auth:restore', handle(async () => slimUser(await client.me().catch(() => null))));

  ipcMain.handle('auth:login', handle(async (username, password) => {
    const r = await client.login(username, password);
    if (r.user) session.save(client);
    return r.needs2fa ? { needs2fa: r.needs2fa } : { user: slimUser(r.user) };
  }));

  ipcMain.handle('auth:verify2fa', handle(async (method, code) => {
    const user = await client.verify2fa(method, String(code).trim());
    return { user: slimUser(user), saved: session.save(client) };
  }));

  ipcMain.handle('auth:logout', handle(async () => {
    await client.logout();
    session.clear();
  }));
}

module.exports = { register };
