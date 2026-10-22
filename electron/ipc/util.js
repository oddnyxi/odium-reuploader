'use strict';

/** Wraps an IPC handler so the renderer always receives `{ ok, data }` or `{ ok:false, error }`. */
const handle = (fn) => async (_event, ...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (e) {
    return { ok: false, error: e.message || String(e), status: e.status };
  }
};

const slimUser = (u) => u && { id: u.id, displayName: u.displayName };

module.exports = { handle, slimUser };
