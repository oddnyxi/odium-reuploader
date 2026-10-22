'use strict';
// Activity log: capture, filter, copy. Also owns the page-level error banner.
(() => {
  const { $, el } = window.Odium;
  const MAX_ROWS = 800; // keeps the DOM small in long sessions
  const lines = [];     // { level, msg, ts }

  const verbose = () => $('logVerbose').checked;
  const row = ({ level, msg, ts }) => el('div', `log ${level}`, `[${ts}] ${msg}`);

  function log(level, msg) {
    const entry = { level, msg: String(msg), ts: new Date().toLocaleTimeString('en-GB') };
    lines.push(entry);
    if (level === 'debug' && !verbose()) return;
    const box = $('log');
    box.append(row(entry));
    while (box.childElementCount > MAX_ROWS) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }

  function rebuild() {
    const box = $('log');
    box.replaceChildren(...lines.filter((l) => l.level !== 'debug' || verbose()).map(row));
    box.scrollTop = box.scrollHeight;
  }

  function notice(message) {
    const banner = $('notice');
    banner.textContent = message || '';
    banner.hidden = !message;
  }

  $('logVerbose').addEventListener('change', rebuild);
  $('logClear').addEventListener('click', () => { lines.length = 0; $('log').replaceChildren(); });
  $('logCopy').addEventListener('click', async () => {
    const text = lines.map((l) => `[${l.ts}] [${l.level}] ${l.msg}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      log('info', 'Copied the activity log to the clipboard.');
    } catch {
      log('warn', 'Could not copy the log: clipboard permission was denied.');
    }
  });

  window.api.on('log', ({ level, msg }) => log(level, msg));
  Object.assign(window.Odium, { log, notice });
})();
