'use strict';
// "Reserve an ID" and "Start from a bundle" dialogs.
(() => {
  const O = window.Odium;
  const { $, state, call, log, copy, segValue, setSeg, tagList, WORLD_DEFAULTS, PLATFORMS, DEFAULT_PLATFORM } = O;

  const onEscape = (modal, close) => document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
  const closeOnBackdrop = (modal, close) => modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });

  // ── Reserve an ID ──
  let reserved = null;
  const closeNew = () => { $('newModal').hidden = true; };

  function openNew() {
    $('newForm').hidden = false;
    $('newDone').hidden = true;
    $('newErr').textContent = '';
    $('newForm').reset();
    setSeg('nPlatform', DEFAULT_PLATFORM);
    setSeg('nRelease', 'private');
    $('newModal').hidden = false;
    $('nName').focus();
  }

  $('newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('newErr').textContent = '';
    $('newGo').disabled = true;
    const form = {
      name: $('nName').value.trim(), description: $('nDesc').value.trim(), tags: tagList($('nTags').value),
      releaseStatus: segValue('nRelease'), platform: segValue('nPlatform'), unityVersion: $('nUnity').value.trim(),
    };
    try {
      const r = await call(window.api.reserveAvatar(form), { quiet: true });
      reserved = {
        id: r.id, name: r.name || form.name, description: form.description, tags: form.tags,
        releaseStatus: form.releaseStatus, pendingUpload: true, platforms: [],
        createdAt: new Date().toISOString(), preferredPlatform: form.platform,
      };
      O.avatars.upsert(reserved);
      copy(r.id);
      log('success', `Reserved ${r.id} and copied it to the clipboard.`);
      $('doneId').textContent = r.id;
      $('newForm').hidden = true;
      $('newDone').hidden = false;
    } catch (err) {
      $('newErr').textContent = err.message;
    }
    $('newGo').disabled = false;
  });

  ['newClose', 'newCancel', 'doneLater'].forEach((id) => $(id).addEventListener('click', closeNew));
  $('doneCopy').addEventListener('click', () => copy($('doneId').textContent, $('doneCopy')));
  $('doneGo').addEventListener('click', () => { closeNew(); O.openAvatar(reserved); });
  closeOnBackdrop($('newModal'), closeNew);
  onEscape($('newModal'), closeNew);

  // ── Start from a bundle ──
  const pending = { path: '', info: null };
  const isWorldBundle = () => pending.info?.kind === 'world';
  const idLooksValid = () => (isWorldBundle() ? /^wrld_[0-9a-f-]{36}$/i : /^avtr_[0-9a-f-]{36}$/i).test($('bId').value.trim());
  // A random v4 UUID, for a world build that has no ID baked in yet.
  function newWorldId() {
    if (crypto.randomUUID) return `wrld_${crypto.randomUUID()}`;
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `wrld_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const updateGo = () => { $('bGo').disabled = !(pending.path && idLooksValid() && $('bAvName').value.trim()); };
  const closeBundle = () => { $('bundleModal').hidden = true; };

  function openBundleDialog() {
    Object.assign(pending, { path: '', info: null });
    $('bForm').reset();
    $('bName').textContent = 'No file chosen';
    $('bName').closest('.file-row').classList.remove('is-set');
    $('bIdNote').textContent = '';
    $('bIdLab').textContent = 'ID';
    $('bId').placeholder = 'avtr_… or wrld_…';
    $('bErr').textContent = '';
    $('bundleModal').hidden = false;
    updateGo();
  }

  $('bPick').addEventListener('click', async () => {
    const file = await call(window.api.pick('any'), { quiet: true }).catch(() => null);
    if (!file) return;
    $('bErr').textContent = '';
    try {
      const info = await call(window.api.bundleInfo(file), { quiet: true });
      Object.assign(pending, { path: file, info });
      $('bName').textContent = info.name;
      $('bName').closest('.file-row').classList.add('is-set');
      const world = info.kind === 'world';
      $('bIdLab').textContent = world ? 'World ID' : 'Avatar ID';
      $('bId').placeholder = world ? 'wrld_…' : 'avtr_…';
      if (info.ids?.length) {
        $('bId').value = info.ids[0];
        $('bIdNote').textContent = info.ids.length > 1 ? `Read from the file (it contains ${info.ids.length} IDs; check this is the right one).` : 'Read from the file.';
      } else if (world && info.note === 'No world ID found in this bundle.') {
        $('bId').value = newWorldId();
        $('bIdNote').textContent = 'No world ID in this build, so a new one was generated. VRChat may reject a build that does not contain it; building once with the SDK sets it properly.';
      } else {
        $('bId').value = '';
        $('bIdNote').textContent = info.note || 'Paste the ID from your PipelineManager.';
      }
      if (!$('bAvName').value) $('bAvName').value = info.name.replace(/\.vrc[aw]$/i, '');
    } catch (err) {
      pending.path = '';
      $('bErr').textContent = err.message;
    }
    updateGo();
  });

  async function startWorld() {
    const id = $('bId').value.trim().toLowerCase();
    const name = $('bAvName').value.trim();
    const r = await call(window.api.lookupWorld(id), { quiet: true });
    const platform = PLATFORMS[pending.info.platform] ? pending.info.platform : DEFAULT_PLATFORM;
    const record = r.exists ? r.world : {
      kind: 'world', id, name, description: '', tags: [], releaseStatus: 'private', ...WORLD_DEFAULTS,
      pendingUpload: true, platforms: [], createdAt: new Date().toISOString(), preferredPlatform: platform,
    };
    O.avatars.upsert(record);
    log('success', r.exists ? `Using your existing world ${id}.` : `${id} is new; it is created on your account when you upload.`);
    return record;
  }

  $('bForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('bErr').textContent = '';
    $('bGo').disabled = true;
    if (isWorldBundle()) {
      try {
        const record = await startWorld();
        closeBundle();
        O.openAvatar(record);
        try { await O.workspace.loadBundle(pending.path); } catch (err) { log('error', err.message); }
        O.workspace.refresh();
      } catch (err) {
        $('bErr').textContent = err.message;
        updateGo();
      }
      return;
    }
    const form = {
      id: $('bId').value.trim(), name: $('bAvName').value.trim(), releaseStatus: 'private',
      platform: DEFAULT_PLATFORM, unityVersion: pending.info.unityVersion,
    };
    try {
      const r = await call(window.api.fromBundle(form), { quiet: true });
      const record = {
        id: r.id, name: r.name || form.name, description: '', tags: [], releaseStatus: form.releaseStatus,
        pendingUpload: r.pendingUpload, platforms: [], createdAt: new Date().toISOString(), preferredPlatform: form.platform,
      };
      O.avatars.upsert(record);
      log('success', r.existing ? `Using your existing avatar ${r.id}.` : `Created ${r.id}.`);
      closeBundle();
      O.openAvatar(record);
      try { await O.workspace.loadBundle(pending.path); } catch (err) { log('error', err.message); }
      O.workspace.refresh();
    } catch (err) {
      $('bErr').textContent = err.message;
      updateGo();
    }
  });

  ['bId', 'bAvName'].forEach((id) => $(id).addEventListener('input', updateGo));
  ['bClose', 'bCancel'].forEach((id) => $(id).addEventListener('click', closeBundle));
  closeOnBackdrop($('bundleModal'), closeBundle);
  onEscape($('bundleModal'), closeBundle);

  // ── Entry points (sidebar and empty state) ──
  const guarded = (open) => () => { if (state.user && !state.busy) open(); };
  ['newBtn', 'emptyNew'].forEach((id) => $(id).addEventListener('click', guarded(openNew)));
  ['bundleBtn', 'emptyBundle'].forEach((id) => $(id).addEventListener('click', guarded(openBundleDialog)));
})();
