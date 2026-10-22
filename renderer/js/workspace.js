'use strict';
// Upload workspace: the four-step form, readiness checks and the upload itself.
(() => {
  const O = window.Odium;
  const { $, state, call, log, copy, segValue, setSeg, tagList, megabytes, isWorld, noun, WORLD_DEFAULTS, PLATFORMS, DEFAULT_PLATFORM } = O;

  const NO_FILE = 'No file chosen';
  const rights = () => $('rights').getAttribute('aria-checked') === 'true';
  const basename = (p) => p.split(/[\\/]/).pop();
  const capacities = () => ({ capacity: Number($('capMax').value), recommendedCapacity: Number($('capRec').value) });
  function capacityProblem() {
    const { capacity, recommendedCapacity } = capacities();
    if (!Number.isInteger(capacity) || capacity < 1) return 'set a maximum capacity';
    if (!Number.isInteger(recommendedCapacity) || recommendedCapacity < 1 || recommendedCapacity > capacity) return 'set a recommended capacity no higher than the maximum';
    return '';
  }
  // A world build must carry the target world's ID; Odium only rewrites IDs in avatar builds.
  const worldIdMismatch = (a) => isWorld(a) && state.bundle && state.bundleIds?.length && !state.bundleIds.includes(a.id);

  function setFile(rowEl, outputId, text, set) {
    $(outputId).textContent = text;
    rowEl.classList.toggle('is-set', set);
  }
  const bundleRow = () => $('bundleName').closest('.file-row');
  const thumbRow = () => $('thumbName').closest('.file-row');

  // ── Readiness ──
  function describeBundle(a) {
    const box = $('bundleCheck');
    if (!state.bundle) { box.hidden = true; return; }
    box.hidden = false;
    const ids = state.bundleIds || [];
    if (isWorld(a)) {
      if (!state.bundleScanned) {
        box.className = 'callout warn';
        box.textContent = 'Could not read a world ID from this build, so it was not checked.';
      } else if (ids.includes(a.id)) {
        box.className = 'callout ok';
        box.textContent = 'This build was made for this world ID.';
      } else if (ids.length) {
        box.className = 'callout warn';
        box.textContent = `This build was made for ${ids[0]}, not this world. Open that world instead, or rebuild with ${a.id} in PipelineManager.`;
      } else {
        box.className = 'callout warn';
        box.textContent = `No world ID found inside this build. It uploads as it is; if VRChat rejects it, rebuild with ${a.id} in PipelineManager.`;
      }
      return;
    }
    if (!state.bundleScanned) {
      box.className = 'callout warn';
      box.textContent = 'Could not read an avatar ID from this build, so it was not checked.';
    } else if (ids.includes(a.id)) {
      box.className = 'callout ok';
      box.textContent = 'This build was made for this avatar ID.';
    } else if (ids.length) {
      box.className = 'callout warn';
      box.textContent = `This build was made for ${ids[0]}. Odium will patch its pipeline ID to ${a.id} on upload. For the most faithful result, build with this ID in Unity.`;
    } else {
      box.className = 'callout warn';
      box.textContent = `No avatar ID found inside this build. It uploads as it is; if that fails, rebuild with ${a.id} in PipelineManager.`;
    }
  }

  function setReady(text, ok) {
    $('readyText').textContent = text;
    $('ready').classList.toggle('is-ok', ok);
  }

  function refresh() {
    const a = state.current;
    const hasAvatar = !!a;
    $('upEmpty').hidden = hasAvatar;
    $('upForm').hidden = !hasAvatar;
    $('actionbar').hidden = !hasAvatar;
    $('upMeta').hidden = !hasAvatar;
    if (!a) { $('upload').disabled = true; return; }

    describeBundle(a);
    $('thumbReq').textContent = a.pendingUpload ? 'required for a first upload' : 'optional for updates';

    const name = $('name').value.trim();
    const done = {
      stepBundle: !!state.bundle && !worldIdMismatch(a), stepThumb: !!state.thumb,
      stepDetails: !!name && !(isWorld(a) && capacityProblem()), stepRelease: rights(),
    };
    for (const [id, isDone] of Object.entries(done)) $(id).classList.toggle('is-done', isDone);

    const missing = [];
    if (!state.user) missing.push('sign in');
    if (!state.bundle) missing.push('choose a build');
    if (worldIdMismatch(a)) missing.push('choose a build made for this world');
    if (a.pendingUpload && !state.thumb) missing.push('add a thumbnail');
    if (!name) missing.push(`name the ${noun(a)}`);
    if (isWorld(a) && capacityProblem()) missing.push(capacityProblem());
    if (!rights()) missing.push('confirm your rights');
    const ok = !missing.length;
    if (!state.busy) setReady(ok ? 'Everything is filled in. Ready to upload.' : `Still needed: ${missing.join(', ')}.`, ok);
    $('upload').disabled = !ok || state.busy;
  }

  // ── Opening an avatar ──
  function openAvatar(a) {
    Object.assign(state, { current: a, bundle: '', thumb: '', bundleIds: null, bundleScanned: false });
    $('bundleWarn').hidden = true;
    setFile(bundleRow(), 'bundleName', NO_FILE, false);
    $('bundleMeta').textContent = 'Build it with the VRChat SDK in Unity';
    setFile(thumbRow(), 'thumbName', NO_FILE, false);
    $('thumbMini').hidden = true;
    O.preview.reset();

    const world = isWorld(a);
    const kind = noun(a);
    $('bundleLabel').textContent = world ? 'World build' : 'Avatar build';
    $('bundleKind').textContent = world ? '.vrcw, required' : '.vrca, required';
    $('worldFields').hidden = !world;
    $('releaseField').hidden = world;
    $('worldReleaseNote').hidden = !world;
    $('rightsLabel').textContent = `I made this ${kind} or have the rights to upload it`;
    $('copyId').title = `Copy ${kind} ID`;
    $('capMax').value = a.capacity || WORLD_DEFAULTS.capacity;
    $('capRec').value = a.recommendedCapacity || Math.min(WORLD_DEFAULTS.recommendedCapacity, Number($('capMax').value));
    if (world) O.preview.unavailable('3D preview is available for avatar builds only.');

    const label = a.name || kind;
    $('upTitle').textContent = a.name || `Untitled ${kind}`;
    $('upSub').textContent = a.pendingUpload
      ? (world ? 'Upload a first build to create this world on your account.' : 'Upload a first build to finish setting this avatar up.')
      : 'Upload a new build to replace the current one.';
    $('upId').textContent = a.id;
    $('upChip').hidden = !a.pendingUpload;
    $('upForm').scrollTop = 0;

    $('name').value = a.name || '';
    $('desc').value = a.description || '';
    $('tags').value = (a.tags || []).join(', ');
    setSeg('release', a.releaseStatus === 'public' ? 'public' : 'private');
    const only = a.platforms?.length === 1 ? a.platforms[0] : DEFAULT_PLATFORM;
    const platform = a.preferredPlatform || only;
    setSeg('platform', PLATFORMS[platform] ? platform : DEFAULT_PLATFORM);
    $('rights').setAttribute('aria-checked', 'false');
    log('debug', `Opened ${label} (${a.id}).`);
    O.showView('upload');
    refresh();
  }

  // VRChat marks avatars over these limits as "Security Checks Failed"; the SDK refuses to upload them.
  function checkLimits(info) {
    const mobile = info.platform === 'android' || info.platform === 'ios';
    const lim = info.kind === 'world' ? null : info.limits?.[mobile ? 'mobile' : 'pc'];
    const warn = $('bundleWarn');
    const problems = [];
    if (lim && info.size > lim.download) problems.push(`The download size (${megabytes(info.size)}) is over the ${megabytes(lim.download)} limit.`);
    if (lim && info.uncompressedSize > lim.uncompressed) problems.push(`The unpacked size (${megabytes(info.uncompressedSize)}) is over the ${megabytes(lim.uncompressed)} limit.`);
    warn.hidden = !problems.length;
    warn.textContent = problems.length ? `${problems.join(' ')} VRChat will show this avatar as failing its security checks. Reduce textures and meshes, then rebuild.` : '';
  }

  // ── File pickers ──
  async function loadBundle(file) {
    const info = await call(window.api.bundleInfo(file), { quiet: true });
    const want = noun(state.current);
    if (info.kind !== want) throw new Error(`That is ${info.kind === 'world' ? 'a world' : 'an avatar'} build; choose a ${want === 'world' ? '.vrcw' : '.vrca'} for this ${want}.`);
    state.bundle = file;
    state.bundleIds = info.ids || [];
    state.bundleScanned = !!(info.ids?.length || /^No (avatar|world) ID found in this bundle\.$/.test(info.note || ''));
    setFile(bundleRow(), 'bundleName', info.name, true);
    $('bundleMeta').textContent = `Unity ${info.unityVersion} · ${megabytes(info.size)}` +
      (info.uncompressedSize ? ` · ${megabytes(info.uncompressedSize)} unpacked` : '') +
      (info.platform ? ` · ${PLATFORMS[info.platform]}` : '');
    if (info.platform && PLATFORMS[info.platform]) setSeg('platform', info.platform);
    state.limits = info.limits;
    checkLimits(info);
    $('unity').value = info.unityVersion;
    log('info', `Bundle ready: ${info.name} (${megabytes(info.size)}, Unity ${info.unityVersion}).`);
    if (info.kind === 'world') O.preview.unavailable('3D preview is available for avatar builds only.');
    else O.preview.loadModel(file);
    return info;
  }

  async function pickBundle() {
    const file = await call(window.api.pick(isWorld(state.current) ? 'world' : 'bundle'), { quiet: true }).catch(() => null);
    if (!file) return;
    try { await loadBundle(file); } catch (e) { state.bundle = ''; log('error', e.message); }
    refresh();
  }

  async function pickThumbnail() {
    const file = await call(window.api.pick('image'), { quiet: true }).catch(() => null);
    if (!file) return;
    state.thumb = file;
    setFile(thumbRow(), 'thumbName', basename(file), true);
    try {
      const url = await call(window.api.imageDataUrl(file), { quiet: true });
      $('thumbMini').src = url;
      $('thumbMini').hidden = false;
      O.preview.showThumbnail(url);
    } catch { /* the preview is optional */ }
    refresh();
  }

  // ── Upload ──
  function setBusy(busy) {
    state.busy = busy;
    $('cancel').hidden = !busy;
    $('upload').classList.toggle('is-busy', busy);
    if (!busy) { $('fill').style.width = '0'; $('goLabel').textContent = 'Upload'; }
    refresh();
  }

  async function upload() {
    const a = state.current;
    const world = isWorld(a);
    setBusy(true);
    setReady('Uploading. Keep this window open.', false);
    const common = {
      bundlePath: state.bundle, thumbPath: state.thumb || null,
      name: $('name').value.trim(), description: $('desc').value, tags: tagList($('tags').value),
      platform: segValue('platform'), unityVersion: $('unity').value.trim(), rightsConfirmed: rights(),
    };
    try {
      if (world) {
        await call(window.api.uploadWorld({ ...common, worldId: a.id, ...capacities() }));
        Object.assign(a, capacities());
      } else {
        await call(window.api.upload({ ...common, avatarId: a.id, releaseStatus: segValue('release') }));
      }
      Object.assign(a, {
        pendingUpload: false, name: common.name, updatedAt: new Date().toISOString(),
        platforms: [...new Set([...(a.platforms || []), common.platform])],
      });
      $('upChip').hidden = true;
      $('upTitle').textContent = a.name;
      $('upSub').textContent = 'Upload complete. Upload another build any time to update it.';
      (world ? O.avatars.loadWorlds() : O.avatars.load()).catch(() => {});
    } catch { /* already logged */ }
    setBusy(false);
  }

  window.api.on('progress', ({ label, fraction }) => {
    const pct = Math.round(fraction * 100);
    $('fill').style.width = `${pct}%`;
    $('goLabel').textContent = `${label} · ${pct}%`;
  });

  // ── Wiring ──
  O.bindSegs(refresh);
  $('rights').addEventListener('click', () => { $('rights').setAttribute('aria-checked', String(!rights())); refresh(); });
  ['name', 'desc', 'unity', 'tags', 'capMax', 'capRec'].forEach((id) => $(id).addEventListener('input', refresh));
  $('pickBundle').addEventListener('click', pickBundle);
  $('pickThumb').addEventListener('click', pickThumbnail);
  $('upload').addEventListener('click', upload);
  $('cancel').addEventListener('click', () => { window.api.cancel(); log('warn', 'Cancelling upload…'); });
  $('copyId').addEventListener('click', () => copy($('upId').textContent));
  $('upForm').addEventListener('submit', (e) => e.preventDefault());

  O.openAvatar = openAvatar;
  O.workspace = { refresh, loadBundle };
})();
