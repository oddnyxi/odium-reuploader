'use strict';
// Shared helpers and app state. Every renderer script hangs its public surface off `window.Odium`.
(() => {
  const $ = (id) => document.getElementById(id);

  /** Creates an element with an optional class and text content. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Creates an <svg> that references a symbol from the sprite in index.html. */
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const PLATFORMS = { standalonewindows: 'PC', android: 'Android', ios: 'iOS' };
  const DEFAULT_PLATFORM = 'standalonewindows';

  const state = {
    user: null,
    avatars: [],
    worlds: [],
    listKind: 'avatar',   // which list the browser shows: 'avatar' or 'world'
    current: null,        // avatar or world being uploaded to (worlds have kind: 'world')
    bundle: '',           // chosen .vrca or .vrcw path
    bundleIds: null,      // blueprint IDs found inside the bundle
    bundleScanned: false,
    thumb: '',            // chosen thumbnail path
    busy: false,
  };

  // ── Segmented controls ──
  const segValue = (id) => $(id)?.querySelector('.is-on')?.dataset.v;
  const setSeg = (id, value) => $(id)?.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === value));
  function bindSegs(onChange) {
    document.querySelectorAll('.seg[id]').forEach((seg) => {
      if (!seg.querySelector('[data-v]')) return;
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        setSeg(seg.id, b.dataset.v);
        onChange?.(seg.id);
      });
    });
  }

  // ── Formatting ──
  const tagList = (text) => text.split(',').map((t) => t.trim()).filter(Boolean);
  // avatar tiles draw from a small palette of hues that sit well with the brand
  const HUES = [345, 300, 265, 215, 175, 25];
  const hue = (s) => HUES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
  const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  const isWorld = (record) => record?.kind === 'world';
  const noun = (record) => (isWorld(record) ? 'world' : 'avatar');
  const WORLD_DEFAULTS = { capacity: 32, recommendedCapacity: 16 };

  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return 'recently';
    const minutes = Math.floor((Date.now() - t) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : new Date(t).toLocaleDateString();
  }

  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); } catch { return false; }
    if (button) {
      const label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = label; }, 1200);
    }
    return true;
  }

  /**
   * Unwraps an `{ ok, data | error }` IPC reply. Failures are logged unless `quiet`, then thrown.
   */
  async function call(promise, { quiet = false } = {}) {
    const reply = await promise;
    if (!reply.ok) {
      if (!quiet) { window.Odium.log('error', reply.error); window.Odium.notice(reply.error); }
      throw new Error(reply.error);
    }
    return reply.data;
  }

  window.Odium = {
    $, el, icon, state, call, copy,
    PLATFORMS, DEFAULT_PLATFORM,
    segValue, setSeg, bindSegs,
    tagList, hue, initials, megabytes, ago, isWorld, noun, WORLD_DEFAULTS,
  };
})();
