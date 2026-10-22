'use strict';
// Sign-in, two-factor and sign-out.
(() => {
  const O = window.Odium;
  const { $, state, call, log, segValue, setSeg } = O;

  function signedIn(user) {
    state.user = user;
    $('login').hidden = true;
    $('who').textContent = user.displayName;
    $('whoState').textContent = 'Connected';
    $('whoInitial').textContent = (user.displayName || '?')[0].toUpperCase();
    document.querySelector('.account').classList.add('is-online');
    $('logout').hidden = false;
    log('success', `Connected as ${user.displayName}.`);
    O.avatars.load().catch(() => {});
    O.avatars.loadWorlds().catch(() => {});
    O.workspace.refresh();
  }

  function askForTwoFactor(methods) {
    const available = methods.map((m) => String(m).toLowerCase());
    setSeg('tfaMethod', available.includes('totp') ? 'totp' : available[0]);
    $('tfaMethod').querySelectorAll('button').forEach((b) => { b.hidden = !available.includes(b.dataset.v); });
    $('loginForm').hidden = true;
    $('tfaForm').hidden = false;
    $('tfaCode').focus();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      const r = await call(window.api.login($('user').value, $('pass').value), { quiet: true });
      $('pass').value = '';
      if (r.needs2fa) askForTwoFactor(r.needs2fa); else signedIn(r.user);
    } catch (err) {
      $('loginErr').textContent = err.message;
    }
  });

  $('tfaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('tfaErr').textContent = '';
    try {
      const r = await call(window.api.verify2fa(segValue('tfaMethod'), $('tfaCode').value), { quiet: true });
      $('tfaCode').value = '';
      if (!r.saved) log('warn', 'Secure storage is unavailable, so you will need to sign in again next time.');
      signedIn(r.user);
    } catch (err) {
      $('tfaErr').textContent = err.message;
    }
  });

  $('logout').addEventListener('click', async () => { await window.api.logout(); location.reload(); });

  O.auth = { signedIn };
})();
