/**
 * Shared UI package entry — services, registries, theme, and derived
 * projections. Framework-free: no React, no stylesheets. The cascade-layer
 * order (`styles/layers.css`) is imported by the React entry
 * (`src/react/index.ts`) and by dist consumers, never here, so headless
 * compositions can import services without a CSS-capable loader.
 */
export * from './vault-manager.js';
export * from './file-explorer.js';
export * from './file-kinds.js';
export * from './file-tree.js';
export * from './search-ui.js';
export * from './theme.js';
export * from './theme-contract.js';
export * from './view-registry.js';
export * from './document-toolbar-registry.js';
export * from './toolbar/placement-registry.js';
export * from './toolbar/placement-resolver.js';
export * from './toolbar/default-placements.js';
export * from './toolbar/composition-registry.js';
export * from './toolbar/default-composition.js';
export * from './toolbar/toolbar-customization.js';
export * from './toolbar/community-contribution.js';
export * from './toolbar/community-lifecycle.js';
export * from './right-sidebar-registry.js';
export * from './right-sidebar-panels.js';
export * from './stylus-menu-registry.js';
export * from './stylus-accessory.js';
export * from './document-preferences.js';
export * from './pdf-export.js';
export * from './pdf-page-selection.js';
export * from './markdown-render.js';
export * from './reading/index.js';
export * from './workspace-settings.js';
export * from './settings-registry.js';
export * from './settings-view.js';
export * from './graph-force.js';
export * from './connection-projection.js';
export * from './graph-view.js';
export * from './dialogs.js';
export * from './icons.js';
export * from './frog-mark.js';
export * from './menu.js';
export * from './note-kinds.js';
export * from './switcher.js';
export * from './launcher.js';
export * from './window-chrome.js';
export * from './workbench.js';
export * from './workbench-ports.js';
export * from './platform/keyboard-caret.js';
export * from './platform/keyboard-inset.js';
export * from './platform/keyboard/ios-viewport-pan-guard.js';
export * from './drop-guard.js';
