'use strict';
// Navigation and start-up.
(() => {
  const O = window.Odium;
  const { $, state, log } = O;

  /** Switches between the upload workspace and the avatar or world browser. */
  function showView(which) {
    const browsing = which === 'avatars' || which === 'worlds';
    if (browsing) state.listKind = which === 'worlds' ? 'world' : 'avatar';
    document.body.classList.toggle('browsing', browsing);
    $('viewList').hidden = !browsing;
    $('viewUpload').hidden = browsing;
    $('navAvatars').classList.toggle('is-on', which === 'avatars');
    $('navWorlds').classList.toggle('is-on', which === 'worlds');
    $('navUpload').classList.toggle('is-on', !browsing);
    if (browsing) O.avatars.render();
  }
  O.showView = showView;

  const guarded = (fn) => () => { if (!state.busy) fn(); };
  $('navAvatars').addEventListener('click', guarded(() => showView('avatars')));
  $('navWorlds').addEventListener('click', guarded(() => showView('worlds')));
  $('navUpload').addEventListener('click', guarded(() => { showView('upload'); O.workspace.refresh(); }));
  $('emptyBrowse').addEventListener('click', guarded(() => showView('avatars')));
  $('emptyWorlds').addEventListener('click', guarded(() => showView('worlds')));

  (async () => {
    showView('upload');
    O.workspace.refresh();
    log('debug', 'Checking for a saved session…');
    const reply = await window.api.restore();
    if (reply.ok && reply.data) {
      O.auth.signedIn(reply.data);
    } else {
      log('info', 'Sign in to VRChat to continue.');
      $('user').focus();
    }
  })();
})();
