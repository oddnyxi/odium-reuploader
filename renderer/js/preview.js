'use strict';
// The preview card: WebGL model viewer and thumbnail pane.
(() => {
  const O = window.Odium;
  const { $, call, log } = O;

  let viewer = null;
  let sequence = 0; // drops results of superseded loads

  const getViewer = () => {
    if (!viewer) viewer = window.OdiumViewer?.create($('view3d')) || null;
    return viewer;
  };

  function showPane(pane) {
    const model = pane === '3d';
    $('previewTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.pane === pane));
    $('stage').hidden = !model;
    $('thumbBox').hidden = model;
    $('previewHint').hidden = !model;
  }

  /** The rotate button mirrors whether the viewer is auto-spinning. */
  const syncSpin = () => $('vRotate').classList.toggle('is-on', !!viewer?.spinning);

  function setPlaceholder(text) {
    $('stagePh').hidden = !text;
    $('stagePh').textContent = text || '';
  }

  function reset() {
    sequence++;
    setPlaceholder('Choose a build to preview the model');
    $('meshInfo').hidden = true;
    $('thumbImg').hidden = true;
    $('thumbEmpty').hidden = false;
    viewer?.clear();
    syncSpin();
    showPane('3d');
  }

  async function loadModel(file) {
    const mine = ++sequence;
    setPlaceholder('Reading model…');
    $('meshInfo').hidden = true;
    const v = getViewer();
    if (!v) { setPlaceholder('WebGL is not available on this computer.'); return; }
    try {
      const r = await call(window.api.bundleMesh(file), { quiet: true });
      if (mine !== sequence) return;
      if (!r.meshes.length) {
        v.clear();
        setPlaceholder('No previewable mesh in this build.');
        log('warn', 'No previewable mesh found in this bundle.');
        return;
      }
      v.load(r.meshes, r.materials, r.textures);
      (r.notes || []).forEach((n) => log('warn', n));
      setPlaceholder('');
      syncSpin();
      $('meshInfo').textContent = `${r.meshes.length} meshes · ${r.triangles.toLocaleString('en-US')} triangles`;
      $('meshInfo').hidden = false;
    } catch (e) {
      if (mine !== sequence) return;
      v.clear();
      setPlaceholder('Preview unavailable for this build.');
      log('warn', `3D preview failed: ${e.message}`);
    }
  }

  /** Clears the model and explains why there is nothing to show. */
  function unavailable(text) {
    sequence++;
    viewer?.clear();
    setPlaceholder(text);
    $('meshInfo').hidden = true;
  }

  function showThumbnail(dataUrl) {
    $('thumbImg').src = dataUrl;
    $('thumbImg').hidden = false;
    $('thumbEmpty').hidden = true;
    showPane('thumb');
  }

  $('previewTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showPane(b.dataset.pane); });
  $('vRotate').addEventListener('click', () => $('vRotate').classList.toggle('is-on', !!getViewer()?.toggleSpin()));
  $('vZoomIn').addEventListener('click', () => getViewer()?.zoomBy(1.2));
  $('vZoomOut').addEventListener('click', () => getViewer()?.zoomBy(1 / 1.2));
  $('vReset').addEventListener('click', () => { getViewer()?.reset(); syncSpin(); });
  $('view3d').addEventListener('pointerdown', syncSpin);
  showPane('3d');

  O.preview = { reset, loadModel, showThumbnail, showPane, unavailable };
})();
