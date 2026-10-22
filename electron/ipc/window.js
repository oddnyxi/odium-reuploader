'use strict';
const { ipcMain, BrowserWindow } = require('electron');

const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

function register() {
  ipcMain.on('win:min', (e) => windowOf(e)?.minimize());
  ipcMain.on('win:toggleMax', (e) => {
    const w = windowOf(e);
    if (w) (w.isMaximized() ? w.unmaximize() : w.maximize());
  });
  ipcMain.on('win:close', (e) => windowOf(e)?.close());
  ipcMain.handle('win:isMax', (e) => windowOf(e)?.isMaximized() ?? false);
}

module.exports = { register };
