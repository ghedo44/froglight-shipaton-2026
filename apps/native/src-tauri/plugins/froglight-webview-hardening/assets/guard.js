// Froglight WebView hardening guard. Injected as a Tauri
// initialization script, so it runs before page scripts in every WebView.
//
// Browser-default actions (reload, view-source, file-open, print, the
// WebView context menu, ...) are suppressed with preventDefault() only:
// Froglight's own handlers still receive the events because propagation is
// never stopped.
//
// KEY_BINDINGS and POINTER_BINDINGS marker lines below are replaced at
// build time by the owning Rust crate with one onKey/onPointer call per
// suppressed default. Do not edit the generated lines by hand.
(function () {
  'use strict';
  const suppressedKeys = new Map();
  function modifierFlags(options) {
    let flags = 0;
    if (options.altKey) flags |= 1;
    if (options.ctrlKey) flags |= 2;
    if (options.metaKey) flags |= 4;
    if (options.shiftKey) flags |= 8;
    return flags;
  }
  window.addEventListener('keydown', function (event) {
    const candidates = suppressedKeys.get(event.key.toLowerCase());
    if (candidates === undefined) return;
    if (candidates.has(modifierFlags(event))) event.preventDefault();
  });
  function onKey(key, options) {
    const normalized = key.toLowerCase();
    const flags = modifierFlags(options || {});
    const candidates = suppressedKeys.get(normalized);
    if (candidates === undefined) {
      suppressedKeys.set(normalized, new Set([flags]));
    } else {
      candidates.add(flags);
    }
  }
  function onPointer(name) {
    window.addEventListener(name, function (event) {
      event.preventDefault();
    });
  }
  /*KEY_BINDINGS*/
  /*POINTER_BINDINGS*/
})();
