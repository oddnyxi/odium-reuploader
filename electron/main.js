'use strict';
const { app } = require('electron');
const { VrcClient } = require('../src/vrchat/client');
const session = require('./session');
const { createMainWindow, send } = require('./window');
const { registerIpc } = require('./ipc');

// Identifies itself honestly: this is not the Unity SDK and does not pretend to be.
const client = new VrcClient({
  userAgent: `AvatarUploader/${app.getVersion()} (self-made upload tool)`,
  onLog: (level, msg) => {
    const line = `[${level}] ${msg}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    send('log', { level, msg });
  },
});

app.whenReady().then(() => {
  session.load(client);
  registerIpc({ client });
  createMainWindow();
});

app.on('window-all-closed', () => app.quit());
