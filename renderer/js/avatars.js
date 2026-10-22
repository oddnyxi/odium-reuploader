'use strict';
// Browser: loading the account's avatars and worlds and rendering them as cards.
(() => {
  const O = window.Odium;
  const { $, el, icon, state, call, log, copy, hue, initials, ago, isWorld, PLATFORMS } = O;

  const TEXT = {
    avatar: {
      title: 'Your avatars', sub: 'Choose one to upload a new build to it.',
      none: 'You have no avatars yet. Reserve an ID to create your first one.',
    },
    world: {
      title: 'Your worlds', sub: 'Choose one to upload a new build to it, or start from a .vrcw to add a new world.',
      none: 'You have no worlds yet. Use "Start from a bundle" with a .vrcw to upload your first one.',
    },
  };

  function card(a) {
    const art = el('span', 'avatar-art');
    art.style.setProperty('--h', hue(a.id));
    art.append(el('span', 'initials', initials(a.name)));
    if (a.pendingUpload) art.append(el('span', 'chip chip-pink', 'First upload'));

    const meta = el('span', 'avatar-meta');
    const when = a.pendingUpload ? `${isWorld(a) ? 'Not uploaded yet' : `Reserved ${ago(a.createdAt)}`}` : `Updated ${ago(a.updatedAt)}`;
    meta.append(
      el('b', '', a.name || 'Untitled'),
      el('small', '', isWorld(a) && a.capacity ? `${when} · ${a.capacity} players` : when),
    );

    const platforms = el('span', 'platforms');
    for (const p of a.platforms || []) platforms.append(el('span', 'chip', PLATFORMS[p] || p));
    if (!platforms.childElementCount) platforms.append(el('span', 'chip', a.releaseStatus === 'public' ? 'Public' : 'Private'));

    const copyBtn = el('button', 'icon-btn');
    copyBtn.type = 'button';
    copyBtn.title = 'Copy ID';
    copyBtn.append(icon('copy'));
    copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copy(a.id); log('info', `Copied ${a.id}.`); });

    const foot = el('span', 'avatar-foot');
    foot.append(platforms, copyBtn);

    const node = el('div', 'avatar-card');
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.append(art, meta, foot);
    node.addEventListener('click', () => O.openAvatar(a));
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter') O.openAvatar(a); });
    return node;
  }

  function render() {
    const kind = state.listKind === 'world' ? 'world' : 'avatar';
    const all = kind === 'world' ? state.worlds : state.avatars;
    const text = TEXT[kind];
    $('listTitle').textContent = text.title;
    $('listSub').textContent = text.sub;
    const query = $('search').value.trim().toLowerCase();
    const list = all.filter((a) => !query || (a.name || '').toLowerCase().includes(query) || a.id.toLowerCase().includes(query));
    $('count').textContent = state.avatars.length;
    $('countWorlds').textContent = state.worlds.length;
    const grid = $('rows');
    grid.replaceChildren();
    if (!list.length) {
      const msg = all.length ? 'Nothing matches your search.' : state.user ? text.none : 'Sign in to see your uploads.';
      grid.append(el('div', 'empty', msg));
      return;
    }
    grid.append(...list.map(card));
  }

  // Keeps local records (reserved avatars, new worlds) that the API has not returned yet.
  const keepPending = (local, list) => local.filter((a) => a.pendingUpload && !list.some((x) => x.id === a.id));

  async function load() {
    O.notice('');
    const list = await call(window.api.listAvatars());
    state.avatars = [...keepPending(state.avatars, list), ...list];
    log('info', `Loaded ${list.length} avatar${list.length === 1 ? '' : 's'}.`);
    render();
  }

  async function loadWorlds() {
    const list = await call(window.api.listWorlds());
    state.worlds = [...keepPending(state.worlds, list), ...list];
    log('info', `Loaded ${list.length} world${list.length === 1 ? '' : 's'}.`);
    render();
  }

  /** Adds or replaces a record in its local list (after reserving or creating one). */
  function upsert(record) {
    const key = isWorld(record) ? 'worlds' : 'avatars';
    state[key] = [record, ...state[key].filter((a) => a.id !== record.id)];
    render();
  }

  $('search').addEventListener('input', render);
  $('refresh').addEventListener('click', () => (state.listKind === 'world' ? loadWorlds() : load()).catch(() => {}));

  O.avatars = { render, load, loadWorlds, upsert };
})();
