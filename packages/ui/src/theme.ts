import { createServiceToken, definePlugin } from '@froglight/runtime';
import { assertThemeTokenName } from './theme-contract.js';
import flTokensCss from './styles/tokens.css?inline';
import flLightCss from './themes/light.css?inline';
import flDarkCss from './themes/dark.css?inline';
import flLayoutCss from './styles/layout.css?inline';
import flPlatformEnvCss from './platform/platform.css?inline';
import globalsCss from './styles/globals.css?inline';

export interface ThemeService {
  readonly id: string;
  apply(): { dispose(): void };
}

export const themeToken = createServiceToken<ThemeService>('froglight.theme');

/**
 * Froglight visual system — "Studio".
 *
 * A modern, content-first workspace in the spirit of today's best knowledge
 * tools: calm neutral surfaces that stay out of the writing's way, one
 * restrained Forest accent, hairline structure, soft depth, and small exact
 * motions. Tokens first; every component reads from them. `[data-theme]`
 * overrides let settings force light/dark regardless of system preference.
 *
 * The runtime bundle carries globals only: canonical `--fl-*` token values
 * (mode-independent tokens, light/dark color worlds, layout metrics,
 * platform environment), and global element defaults. Every component owns
 * its structure in a colocated `*.module.css` imported explicitly by its
 * component; window geometry
 * lives in `@layer platform` blocks inside the owning modules
 * (`Titlebar`, `WorkspaceView`). There is no shell bundle, no structural
 * substitution, and no aggregate stylesheet: correctness comes from cascade
 * layers declared in layer order
 * (`tokens, globals, components, platform, theme-overrides`), never from
 * concatenation order. Runtime theming narrows to
 * `defineThemeTokenPlugin` public-token overrides in the `theme-overrides`
 * layer and typed `defineTheme` values.
 */
export const themeLayerOrder = [
  'tokens',
  'globals',
  'components',
  'platform',
  'theme-overrides',
] as const;

export type ThemeLayer = (typeof themeLayerOrder)[number];

function inLayer(layer: ThemeLayer, css: string): string {
  return `@layer ${layer} {\n${css}\n}`;
}

export interface ThemeTokenOverrides {
  /**
   * Public `--fl-*` theme token names mapped to values. Only documented
   * theme tokens are supported: unknown names and geometry/environment names
   * (`--sidebar-w`, `--fl-layout-*`, `--safe-top`, …) are rejected;
   * structural selectors receive no compatibility guarantee.
   */
  readonly tokens: Readonly<Record<string, string>>;
}

function tokensCss(tokens: Readonly<Record<string, string>>): string {
  const declarations = Object.entries(tokens).map(([name, value]) => {
    assertThemeTokenName(name);
    return `  ${name}: ${value};`;
  });
  return `:root {\n${declarations.join('\n')}\n}`;
}

export function composeThemeCss(): string {
  // Tokens layer: canonical `--fl-*` values (mode-independent tokens,
  // light/dark color worlds, layout metrics, and platform environment).
  // Selectors in `themes/*.css` decide which color world wins.
  const tokens = [
    flTokensCss,
    flLightCss,
    flDarkCss,
    flLayoutCss,
    flPlatformEnvCss,
  ]
    .map((css) => inLayer('tokens', css))
    .join('\n');
  const globals = inLayer('globals', globalsCss);
  return `@layer ${themeLayerOrder.join(', ')};\n${tokens}\n${globals}`;
}

export const defaultThemeCss = composeThemeCss();

/** Default theme plugin. */
export const themePlugin = definePlugin({
  id: 'froglight.theme.default',
  activate: (ctx) => {
    const style =
      typeof document === 'undefined' ? null : document.createElement('style');
    if (style !== null) {
      style.id = 'froglight-theme';
      style.textContent = defaultThemeCss;
      document.head.appendChild(style);
    }
    const service: ThemeService = {
      id: 'default',
      apply: () => {
        if (style !== null && style.parentNode === null)
          document.head.appendChild(style);
        return { dispose: () => style?.remove() };
      },
    };
    ctx.provide(themeToken, service);
    if (style !== null) ctx.effect(() => () => style.remove());
  },
});

/**
 * Narrowed runtime theme contribution: an effect-owned
 * `<style>` element carrying only public-token overrides in the
 * `theme-overrides` layer. Component structure stays static and colocated
 * and is no longer replaceable by a theme. Honors the standard lifecycle
 * invariant: activate → one `<style>`, dispose → zero, reactivate → one.
 */
export function defineThemeTokenPlugin(
  id: string,
  overrides: ThemeTokenOverrides,
) {
  const resolved = `@layer ${themeLayerOrder.join(', ')};\n${inLayer(
    'theme-overrides',
    tokensCss(overrides.tokens),
  )}`;
  return definePlugin({
    id,
    activate: (ctx) => {
      const style =
        typeof document === 'undefined'
          ? null
          : document.createElement('style');
      if (style !== null) {
        style.id = `froglight-theme-${id}`;
        style.textContent = resolved;
        document.head.appendChild(style);
      }
      const service: ThemeService = {
        id,
        apply: () => ({ dispose: () => style?.remove() }),
      };
      ctx.provide(themeToken, service);
      if (style !== null) ctx.effect(() => () => style.remove());
    },
  });
}
