(function () {
  'use strict';

  var storageKey = 'opentalk-theme';
  var root = document.documentElement;
  var modes = ['light', 'dark', 'system'];
  var media = null;
  var select = null;

  function validMode(value) {
    return modes.indexOf(value) !== -1 ? value : 'dark';
  }

  function savedMode() {
    try { return validMode(window.localStorage.getItem(storageKey)); }
    catch (ignored) { return 'dark'; }
  }

  try { media = window.matchMedia('(prefers-color-scheme: dark)'); }
  catch (ignored) { /* Storage and system preferences are optional. */ }

  var mode = savedMode();

  function applyMode(value) {
    mode = validMode(value);
    var theme = mode === 'system' ? (media && media.matches ? 'dark' : 'light') : mode;
    root.setAttribute('data-theme-mode', mode);
    root.setAttribute('data-theme', theme);
    var browserColor = document.querySelector('meta[name="theme-color"]');
    if (browserColor) browserColor.setAttribute('content', theme === 'dark' ? '#08111d' : '#edf1f5');
    if (select) select.value = mode;
  }

  // Run in the head before stylesheets so the first painted frame uses the saved mode.
  applyMode(mode);

  function systemChanged() {
    if (mode === 'system') applyMode(mode);
  }
  if (media && typeof media.addEventListener === 'function') media.addEventListener('change', systemChanged);
  else if (media && typeof media.addListener === 'function') media.addListener(systemChanged);

  window.addEventListener('storage', function (event) {
    if (event.storageArea) {
      try { if (event.storageArea !== window.localStorage) return; }
      catch (ignored) { return; }
    }
    if (event.key === storageKey || event.key === null) applyMode(event.newValue);
  });

  function mountPoint() {
    var explicit = document.querySelector('[data-theme-mount]');
    if (explicit) return explicit;
    var header = document.querySelector('header');
    if (!header) return null;
    var target = header.querySelector('.topbar-inner') || header.querySelector('.nav-row');
    if (target) return target;
    if (header.classList.contains('account-header')) return header;
    var wrap = header.querySelector('.wrap');
    if (!wrap) return header;
    var back = wrap.querySelector('.back');
    var tools = document.createElement('div');
    tools.className = 'theme-header-tools';
    wrap.insertBefore(tools, wrap.firstChild);
    if (back && back.parentNode === wrap) tools.appendChild(back);
    return tools;
  }

  function mount() {
    if (document.getElementById('site-theme-select')) return;
    var target = mountPoint();
    if (!target) return;
    target.classList.add('has-theme-picker');
    var label = document.createElement('label');
    label.className = 'theme-picker';
    label.htmlFor = 'site-theme-select';
    var caption = document.createElement('span');
    caption.className = 'theme-picker-caption';
    caption.textContent = '화면';
    label.appendChild(caption);
    select = document.createElement('select');
    select.id = 'site-theme-select';
    select.name = 'theme';
    select.setAttribute('aria-label', '화면 모드');
    var titles = ['라이트', '다크', '시스템'];
    modes.forEach(function (value, index) {
      var option = document.createElement('option');
      option.value = value;
      option.textContent = titles[index];
      select.appendChild(option);
    });
    select.value = mode;
    select.addEventListener('change', function () {
      applyMode(select.value);
      try { window.localStorage.setItem(storageKey, mode); }
      catch (ignored) { /* The selected mode still works for this page. */ }
    });
    label.appendChild(select);
    target.appendChild(label);
    applyMode(mode);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}());
