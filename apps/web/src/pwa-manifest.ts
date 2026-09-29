/** PWA manifest source of truth, shared by the build config and its contract spec.
 *
 *  Static icon assets live in `public/` and are generated from the canonical
 *  logo geometry in `assets/` (see `assets/generate_pwa_assets.py`).
 *
 *  This module must not import from `vite-plugin-pwa` (build
 *  tooling only). The manifest shape is declared locally; `vite.config.ts`
 *  adapts it to the plugin's `ManifestOptions` type at the build boundary.
 */

export interface PwaManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

export interface PwaManifest {
  readonly id?: string;
  readonly name?: string;
  readonly short_name?: string;
  readonly description?: string;
  readonly lang?: string;
  readonly dir?: string;
  readonly theme_color?: string;
  readonly background_color?: string;
  readonly display?: string;
  readonly display_override?: readonly string[];
  readonly scope?: string;
  readonly start_url?: string;
  readonly categories?: readonly string[];
  readonly icons?: readonly PwaManifestIcon[];
}

export const pwaManifest: PwaManifest = {
  id: '/',
  name: 'Froglight',
  short_name: 'Froglight',
  description: 'Local-first Markdown workspace',
  lang: 'en',
  dir: 'ltr',
  // Default world is light ("Paper & Ink"); the page's adaptive meta
  // theme-color overrides this per appearance at runtime.
  theme_color: '#f7f7f5',
  background_color: '#f7f7f5',
  display: 'standalone',
  // Installed PWAs reclaim the titlebar strip: the shell draws its tab bar
  // there and pads clear of the OS caption buttons (WindowControlsOverlay).
  display_override: ['window-controls-overlay'],
  scope: '/',
  start_url: '/',
  categories: ['productivity', 'utilities'],
  icons: [
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: '/icons/icon-maskable-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'maskable',
    },
    {
      src: '/icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};
