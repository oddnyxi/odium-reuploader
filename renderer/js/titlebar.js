'use strict';
// Custom window controls for the frameless window.
(() => {
  const api = window.odiumWin;
  const $ = (id) => document.getElementById(id);
  if (!api) { document.querySelector('.tb-ctl')?.setAttribute('hidden', ''); return; }
  $('wMin').onclick = () => api.minimize();
  $('wMax').onclick = () => api.toggleMaximize();
  $('wClose').onclick = () => api.close();
  $('titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tb-ctl')) api.toggleMaximize();
  });
  api.onMaximizeChange?.((m) => document.body.classList.toggle('maxed', m));
  api.isMaximized?.().then((m) => document.body.classList.toggle('maxed', !!m));
})();
