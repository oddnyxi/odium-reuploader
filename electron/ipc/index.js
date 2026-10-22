'use strict';

/** Registers every IPC handler. Each module exposes `register(ctx)`. */
function registerIpc(ctx) {
  for (const name of ['window', 'auth', 'avatars', 'worlds', 'files', 'upload']) {
    require(`./${name}`).register(ctx);
  }
}

module.exports = { registerIpc };
