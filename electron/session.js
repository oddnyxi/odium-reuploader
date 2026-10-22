'use strict';
// Persists the VRChat session cookies, encrypted with the OS keychain (safeStorage).
// Cookies are never written in plain text: without OS encryption, nothing is saved.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'session.bin');

function save(client) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(client.exportCookies())));
  return true;
}

function load(client) {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(file())) return;
    client.importCookies(JSON.parse(safeStorage.decryptString(fs.readFileSync(file()))));
  } catch {
    // Corrupt or unreadable session: the user simply signs in again.
  }
}

function clear() {
  try { fs.unlinkSync(file()); } catch { /* nothing stored */ }
}

module.exports = { save, load, clear };
