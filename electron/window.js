'use strict';
const path = require('path');
const { BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
let main = null;

/** Creates the frameless main window; the renderer draws its own title bar. */
function createMainWindow() {
  main = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#120e16',
    title: 'Odium Uploader',
    frame: false,
    icon: path.join(ROOT, 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  main.setMenuBarVisibility(false);
  main.on('maximize', () => main.webContents.send('win:max', true));
  main.on('unmaximize', () => main.webContents.send('win:max', false));
  main.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  return main;
}

const getMainWindow = () => main;

/** Sends an event to the renderer if the window is still alive. */
function send(channel, payload) {
  if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
}

module.exports = { createMainWindow, getMainWindow, send };
