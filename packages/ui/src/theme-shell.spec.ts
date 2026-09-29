// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Runtime } from '@froglight/runtime';
import * as themeModule from './theme.js';
import {
  composeThemeCss,
  defaultThemeCss,
  defineThemeTokenPlugin,
  themeLayerOrder,
  themePlugin,
} from './theme.js';
import layersCss from './styles/layers.css?inline';
import flTokensCss from './styles/tokens.css?inline';
import flLightCss from './themes/light.css?inline';
import flDarkCss from './themes/dark.css?inline';
import flLayoutCss from './styles/layout.css?inline';
import flGlobalsCss from './styles/globals.css?inline';
import flPlatformEnvCss from './platform/platform.css?inline';
import buttonCss from './react/Button.module.css?inline';
import communityViewCss from './react/CommunityPluginsView.module.css?inline';
import documentToolbarCss from './react/UnifiedToolbar.module.css?inline';
import explorerModuleCss from './react/FileExplorer.module.css?inline';
import filePreviewCssModule from './react/previews/FilePreview.module.css?inline';
import graphViewCss from './react/GraphView.module.css?inline';
import launcherViewCss from './react/LauncherView.module.css?inline';
import markdownReaderCss from './react/MarkdownReaderView.module.css?inline';
import newNoteModalCss from './react/NewNoteModal.module.css?inline';
import overlaysCss from './react/Overlays.module.css?inline';
import rightSidebarPanelsCss from './react/RightSidebarPanels.module.css?inline';
import searchViewCss from './react/SearchView.module.css?inline';
import settingsModalCss from './react/SettingsModal.module.css?inline';
import settingsViewCss from './react/SettingsView.module.css?inline';
import switcherOverlayCss from './react/SwitcherOverlay.module.css?inline';
import titlebarCssModule from './react/Titlebar.module.css?inline';
import workspaceViewCss from './react/WorkspaceView.module.css?inline';

// Provider-owned stylesheets are read from disk rather than imported: they
// belong to other Nx projects, and cross-project relative imports violate
// module boundaries. Raw text is sufficient — the checks below (no public
// token redefinition, layers under components) hold on source text.
const REPO_ROOT = (() => {
  const candidates = [process.cwd(), __dirname];
  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(__dirname, '..', '..', '..');
})();

function readRepoCss(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

const inkSkeletonCss = readRepoCss(
  'packages/editor-ink/src/react/InkSurfaceSkeleton.css',
);
const notebookChromeCss = readRepoCss(
  'packages/editor-notebook/src/react/NotebookChrome.css',
);
const blockpageHostCss = readRepoCss(
  'packages/editor-blockpage/src/react/BlockpageHost.module.css',
);
const blockpageProviderCss = readRepoCss(
  'packages/editor-blockpage/src/styles/prose-mirror.css',
);
const codemirrorHostCss = readRepoCss(
  'packages/editor-codemirror/src/react/CodemirrorHost.module.css',
);
const latexEditorCss = readRepoCss(
  'packages/editor-codemirror/src/react/LatexEditorSkeleton.css',
);
const latexReaderCss = readRepoCss(
  'packages/editor-codemirror/src/react/LatexReaderSkeleton.css',
);
const pdfReaderCss = readRepoCss(
  'packages/provider-pdfjs/src/react/PdfReaderSkeleton.css',
);

/** Structure that used to ship in the injected shell bundle and now lives
 *  in component-owned `*.module.css` files (or is deleted as dead code).
 *  None of it may reappear in the runtime theme bundle: the bundle is
 *  globals only. */
const RETIRED_STRUCTURE_ANCHORS: readonly string[] = [
  '.froglight-layout',
  '.fl-activity',
  '.fl-sidebar',
  '.fl-right-sidebar',
  '.fl-main',
  '.fl-tab',
  '.fl-bottomnav',
  '.fl-titlebar',
  '.titlebar-inspector-toggle',
  '.settings-modal',
  '.froglight-blockpage',
  '.flbp-content',
  '.fl-segmented',
  '.fl-toggle',
  // Provider-owned chrome likewise never ships in the runtime theme bundle:
  // each provider owns its structure in a colocated stylesheet.
  '.fl-ink-root',
  '.fl-ink-page',
  '.fl-nb',
  '.flbp-host',
  '.froglight-latex-reader',
  '.froglight-latex-editor',
  '.fl-pdf-reader',
];

describe('theme bundle (globals only, no retained shell)', () => {
  it('exposes no shell parts: structure ships through component imports', () => {
    for (const name of [
      'shellCssParts',
      'shellCssOrder',
      'shellCss',
      'ThemeShellComponent',
      'platformLayerComponents',
    ]) {
      expect(themeModule as Record<string, unknown>, name).not.toHaveProperty(
        name,
      );
    }
  });

  it('declares cascade layers first, matching the single layers source', () => {
    expect([...themeLayerOrder]).toEqual([
      'tokens',
      'globals',
      'components',
      'platform',
      'theme-overrides',
    ]);
    const declaration =
      '@layer tokens, globals, components, platform, theme-overrides;';
    // Generated string position is not public behavior: the bundle carries
    // the declaration, while precedence itself is proven by production
    // computed styles (apps/web launcher-styles.spec.ts under Chromium).
    expect(defaultThemeCss).toContain(declaration);
    // styles/layers.css stays the declared-once source; the runtime bundle
    // mirrors it rather than forking it (exclusivity is pinned below).
    expect(layersCss).toContain(declaration);
  });

  it('keeps the layers source as the single order declaration', () => {
    // The root PostCSS config prepends this file to every stylesheet and
    // `themeLayerOrder` mirrors it for the runtime bundle: the file must
    // carry nothing but the declaration, so neither mechanism can drift.
    // (The `?inline` import runs through the same PostCSS pipeline, so
    // strip every copy of the declaration before comparing.)
    const declaration =
      '@layer tokens, globals, components, platform, theme-overrides;';
    expect(
      layersCss
        .split(declaration)
        .join('')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim(),
    ).toBe('');
  });

  it('composeThemeCss with no overrides equals the default bundle', () => {
    expect(composeThemeCss()).toBe(defaultThemeCss);
  });

  it('carries tokens plus global defaults and no component structure', () => {
    const tokensBlocks = [
      ...defaultThemeCss.matchAll(/@layer tokens \{[\s\S]*?\n\}/g),
    ].map((match) => match[0]);
    expect(tokensBlocks.length).toBeGreaterThan(1);
    const tokensLayer = tokensBlocks.join('\n');
    expect(tokensLayer).toContain('--fl-surface-sidebar');
    expect(tokensLayer).toContain('--fl-accent');
    // Canonical tokens are published without pre-namespaced aliases.
    expect(tokensLayer).not.toContain('--bg-sidebar:');
    expect(tokensLayer).toContain('--fl-layout-sidebar-width');
    expect(tokensLayer).toContain('--fl-safe-area-top');
    // Global element defaults and shared utilities live in globals.
    expect(defaultThemeCss).toMatch(
      /@layer globals \{[\s\S]*?\.froglight-icon[\s\S]*?\n\}/,
    );
    expect(defaultThemeCss).toMatch(
      /@layer globals \{[\s\S]*?\.visually-hidden[\s\S]*?\n\}/,
    );
    // No component structure, no platform geometry, no dead primitives.
    for (const anchor of RETIRED_STRUCTURE_ANCHORS) {
      expect(defaultThemeCss, `retired anchor ${anchor}`).not.toContain(anchor);
    }
    expect(defaultThemeCss).not.toMatch(/@layer components \{/);
    expect(defaultThemeCss).not.toMatch(/@layer platform \{/);
  });

  it('token overrides land in the theme-overrides layer without forking structure', async () => {
    const plugin = defineThemeTokenPlugin('tokens-test', {
      tokens: { '--fl-accent': '#ff0000' },
    });
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'theme-tokens', plugin });
    const style = document.querySelector('#froglight-theme-tokens-test');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('@layer');
    expect(style?.textContent).toContain('--fl-accent: #ff0000');
    // Structure stays static: no component stylesheet is replaced.
    expect(style?.textContent).not.toContain('.settings-modal');

    await runtime.removeSlot('theme-tokens');
    expect(document.querySelector('#froglight-theme-tokens-test')).toBeNull();
    await runtime.dispose();
  });

  it('token plugin honors the style lifecycle and rejects non-token names', async () => {
    expect(() =>
      defineThemeTokenPlugin('tokens-bad', {
        tokens: { color: 'red' },
      }),
    ).toThrow(/invalid theme token name/);
    const plugin = defineThemeTokenPlugin('tokens-cycle', {
      tokens: { '--fl-surface-app': '#000000' },
    });
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'theme-tokens-cycle', plugin });
    expect(
      document.querySelectorAll('#froglight-theme-tokens-cycle').length,
    ).toBe(1);
    await runtime.removeSlot('theme-tokens-cycle');
    expect(document.querySelector('#froglight-theme-tokens-cycle')).toBeNull();
    await runtime.registerSlot({ id: 'theme-tokens-cycle', plugin });
    expect(
      document.querySelectorAll('#froglight-theme-tokens-cycle').length,
    ).toBe(1);
    await runtime.dispose();
    expect(document.querySelector('#froglight-theme-tokens-cycle')).toBeNull();
  });

  it('public tokens are defined only in the token contract', () => {
    const definedIn = (css: string): string[] => {
      const names = new Set<string>();
      for (const block of css.matchAll(/:root[^{]*\{([\s\S]*?)\n\}/g)) {
        for (const declaration of block[1].matchAll(/(--[\w-]+)\s*:/g)) {
          names.add(declaration[1]);
        }
      }
      return [...names];
    };
    const escapeRegExp = (value: string): string =>
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Canonical `--fl-*` values live in styles/tokens.css
    // (mode-independent), themes/light.css + themes/dark.css (color
    // worlds), styles/layout.css (geometry), and platform/platform.css
    // (environment).
    const publicTokens = [
      ...definedIn(flTokensCss),
      ...definedIn(flLightCss),
      ...definedIn(flDarkCss),
      ...definedIn(flLayoutCss),
      ...definedIn(flPlatformEnvCss),
    ];
    expect(publicTokens.length).toBeGreaterThan(0);
    expect(publicTokens.every((name) => name.startsWith('--fl-'))).toBe(true);
    // Private namespaced implementation variables stay exempt: only names
    // the token contract defines are guarded. Every component-owned module
    // consumes tokens without redefining them.
    const others: Array<readonly [string, string]> = [
      ['styles/globals.css', flGlobalsCss],
      ['react/Button.module.css', buttonCss],
      ['react/CommunityPluginsView.module.css', communityViewCss],
      ['react/UnifiedToolbar.module.css', documentToolbarCss],
      ['react/FileExplorer.module.css', explorerModuleCss],
      ['react/GraphView.module.css', graphViewCss],
      ['react/LauncherView.module.css', launcherViewCss],
      ['react/MarkdownReaderView.module.css', markdownReaderCss],
      ['react/NewNoteModal.module.css', newNoteModalCss],
      ['react/Overlays.module.css', overlaysCss],
      ['react/previews/FilePreview.module.css', filePreviewCssModule],
      ['react/RightSidebarPanels.module.css', rightSidebarPanelsCss],
      ['react/SearchView.module.css', searchViewCss],
      ['react/SettingsModal.module.css', settingsModalCss],
      ['react/SettingsView.module.css', settingsViewCss],
      ['react/SwitcherOverlay.module.css', switcherOverlayCss],
      ['react/Titlebar.module.css', titlebarCssModule],
      ['react/WorkspaceView.module.css', workspaceViewCss],
      // Provider-owned stylesheets honor the same contract: public tokens
      // are consumed, never redefined; structure layers under components.
      ['editor-ink/react/InkSurfaceSkeleton.css', inkSkeletonCss],
      ['editor-notebook/react/NotebookChrome.css', notebookChromeCss],
      ['editor-blockpage/react/BlockpageHost.module.css', blockpageHostCss],
      ['editor-blockpage/styles/prose-mirror.css', blockpageProviderCss],
      ['editor-codemirror/react/CodemirrorHost.module.css', codemirrorHostCss],
      ['editor-codemirror/react/LatexEditorSkeleton.css', latexEditorCss],
      ['editor-codemirror/react/LatexReaderSkeleton.css', latexReaderCss],
      ['provider-pdfjs/react/PdfReaderSkeleton.css', pdfReaderCss],
    ];
    for (const [file, css] of others) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const token of publicTokens) {
        expect(withoutComments, `${token} redefined in ${file}`).not.toMatch(
          new RegExp(`${escapeRegExp(token)}\\s*:`, 'm'),
        );
      }
    }
    // Component and provider structure layers under components. globals.css
    // owns the globals layer.
    const layered = others.filter(([file]) => file !== 'styles/globals.css');
    for (const [file, css] of layered) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(withoutComments, `${file} must layer under components`).toMatch(
        /@layer components\s*\{/,
      );
    }
  });

  it('default theme plugin lifecycle: activate → one style; dispose → zero; reactivate → one', async () => {
    document.head
      .querySelectorAll('#froglight-theme')
      .forEach((el) => el.remove());
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'theme', plugin: themePlugin });
    expect(document.querySelectorAll('#froglight-theme').length).toBe(1);
    // Globals only: token values in, component structure out.
    expect(document.querySelector('#froglight-theme')?.textContent).toContain(
      '--fl-surface-app',
    );
    expect(
      document.querySelector('#froglight-theme')?.textContent,
    ).not.toContain('.froglight-layout');

    await runtime.removeSlot('theme');
    expect(document.querySelectorAll('#froglight-theme').length).toBe(0);

    await runtime.registerSlot({ id: 'theme', plugin: themePlugin });
    expect(document.querySelectorAll('#froglight-theme').length).toBe(1);
    await runtime.dispose();
    expect(document.querySelectorAll('#froglight-theme').length).toBe(0);
  });
});
