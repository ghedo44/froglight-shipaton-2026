import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import { themeToken } from './theme.js';

/**
 * Froglight theme contract — typed theme values over the `--fl-*` token
 * API (spec sections 1, 3, 4, 6, 7).
 *
 * A "theme" assigns values to public semantic tokens and nothing else:
 * no selectors, no structure, no layout geometry. Components consume
 * `var(--fl-*)` and never redefine these names; layout metrics
 * (`--fl-layout-*`) and platform environment (`--fl-safe-area-*`,
 * `--fl-keyboard-*`) are categorically excluded from theme overrides. Private component
 * variables use the `--_*` namespace and are never theme API.
 */

/** Camel-case theme values. Every field maps 1:1 to a `--fl-*` variable. */
export interface ThemeTokens {
  readonly surfaceApp?: string;
  readonly surfaceSidebar?: string;
  readonly surfaceSunken?: string;
  readonly surfaceRaised?: string;
  readonly surfaceHover?: string;
  readonly surfaceActive?: string;
  readonly surfaceEditor?: string;
  readonly surfaceInput?: string;
  readonly textPrimary?: string;
  readonly textSecondary?: string;
  readonly textMuted?: string;
  readonly accent?: string;
  readonly accentStrong?: string;
  readonly accentContrast?: string;
  readonly accentSoft?: string;
  readonly danger?: string;
  readonly dangerSoft?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly borderDefault?: string;
  readonly borderStrong?: string;
  readonly radiusSm?: string;
  readonly radiusMd?: string;
  readonly radiusLg?: string;
  readonly radiusXl?: string;
  readonly shadowLow?: string;
  readonly shadowMedium?: string;
  readonly shadowOverlay?: string;
  readonly motionFast?: string;
  readonly motionNormal?: string;
  readonly motionSlow?: string;
  readonly easeStandard?: string;
  readonly easeSpring?: string;
  readonly fontSans?: string;
  readonly fontMono?: string;
  readonly editorFontSize?: string;
}

export interface ThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly mode: 'light' | 'dark';
  readonly tokens: ThemeTokens;
}

/** Every public `--fl-*` name — the stable theme API. This spans three
 *  categories: theme tokens (color/surface/text/accent/border/depth/
 *  radii/motion/typography, theme-overridable), layout metrics
 *  (`--fl-layout-*`, geometry — never theme-overridable), and platform
 *  environment (`--fl-safe-area-*`, `--fl-keyboard-*`, OS-owned — never
 *  theme-overridable). The theme-overridable subset is
 *  `FL_THEME_TOKEN_NAMES`. */
export const FL_TOKEN_NAMES: readonly string[] = [
  '--fl-vault-violet',
  '--fl-vault-blue',
  '--fl-vault-orange',
  '--fl-vault-teal',
  '--fl-surface-app',
  '--fl-surface-sidebar',
  '--fl-surface-sunken',
  '--fl-surface-raised',
  '--fl-surface-hover',
  '--fl-surface-active',
  '--fl-surface-editor',
  '--fl-surface-input',
  '--fl-text-primary',
  '--fl-text-secondary',
  '--fl-text-muted',
  '--fl-accent',
  '--fl-accent-strong',
  '--fl-accent-contrast',
  '--fl-accent-soft',
  '--fl-danger',
  '--fl-danger-soft',
  '--fl-success',
  '--fl-warning',
  '--fl-border-default',
  '--fl-border-strong',
  '--fl-radius-sm',
  '--fl-radius-md',
  '--fl-radius-lg',
  '--fl-radius-xl',
  '--fl-shadow-low',
  '--fl-shadow-medium',
  '--fl-shadow-overlay',
  '--fl-motion-fast',
  '--fl-motion-normal',
  '--fl-motion-slow',
  '--fl-ease-standard',
  '--fl-ease-spring',
  '--fl-font-sans',
  '--fl-font-mono',
  '--fl-editor-font-size',
  '--fl-layout-ribbon-width',
  '--fl-layout-sidebar-width',
  '--fl-layout-right-sidebar-width',
  '--fl-layout-header-height',
  '--fl-layout-tab-height',
  '--fl-layout-bottomnav-height',
  '--fl-safe-area-top',
  '--fl-safe-area-bottom',
  '--fl-safe-area-left',
  '--fl-safe-area-right',
  '--fl-keyboard-inset-height',
  '--fl-keyboard-safe-bottom',
  '--fl-keyboard-aware-bottom',
  '--fl-keyboard-overlay-bottom',
] as const;

/** Theme-overridable names. Layout, safe-area, and keyboard metrics are
 *  excluded: a theme changes color/typography/depth/radii, never
 *  geometry. */
export const FL_THEME_TOKEN_NAMES: readonly string[] = FL_TOKEN_NAMES.filter(
  (name) =>
    !name.startsWith('--fl-layout-') &&
    !name.startsWith('--fl-safe-area-') &&
    !name.startsWith('--fl-keyboard-'),
);

/**
 * Reject anything outside the documented theme API: unknown names and
 * geometry/environment names alike. Geometry is not theme-overridable.
 */
export function assertThemeTokenName(name: string): void {
  if (
    !name.startsWith('--') ||
    name.includes(' ') ||
    name.includes('{') ||
    !FL_THEME_TOKEN_NAMES.includes(name)
  ) {
    throw new Error(`invalid theme token name ${JSON.stringify(name)}`);
  }
}

const TOKEN_VAR: Record<keyof ThemeTokens, string> = {
  surfaceApp: '--fl-surface-app',
  surfaceSidebar: '--fl-surface-sidebar',
  surfaceSunken: '--fl-surface-sunken',
  surfaceRaised: '--fl-surface-raised',
  surfaceHover: '--fl-surface-hover',
  surfaceActive: '--fl-surface-active',
  surfaceEditor: '--fl-surface-editor',
  surfaceInput: '--fl-surface-input',
  textPrimary: '--fl-text-primary',
  textSecondary: '--fl-text-secondary',
  textMuted: '--fl-text-muted',
  accent: '--fl-accent',
  accentStrong: '--fl-accent-strong',
  accentContrast: '--fl-accent-contrast',
  accentSoft: '--fl-accent-soft',
  danger: '--fl-danger',
  dangerSoft: '--fl-danger-soft',
  success: '--fl-success',
  warning: '--fl-warning',
  borderDefault: '--fl-border-default',
  borderStrong: '--fl-border-strong',
  radiusSm: '--fl-radius-sm',
  radiusMd: '--fl-radius-md',
  radiusLg: '--fl-radius-lg',
  radiusXl: '--fl-radius-xl',
  shadowLow: '--fl-shadow-low',
  shadowMedium: '--fl-shadow-medium',
  shadowOverlay: '--fl-shadow-overlay',
  motionFast: '--fl-motion-fast',
  motionNormal: '--fl-motion-normal',
  motionSlow: '--fl-motion-slow',
  easeStandard: '--fl-ease-standard',
  easeSpring: '--fl-ease-spring',
  fontSans: '--fl-font-sans',
  fontMono: '--fl-font-mono',
  editorFontSize: '--fl-editor-font-size',
};

/**
 * Apply a typed theme definition to an application root element.
 * The UI layer translates the typed object into `--fl-*` variables —
 * runtime themes without making arbitrary CSS a privileged extension API.
 * Returns a disposer that removes exactly the variables this call set.
 */
export function applyThemeTokens(
  root: HTMLElement,
  definition: ThemeDefinition,
): () => void {
  const set: string[] = [];
  for (const [key, variable] of Object.entries(TOKEN_VAR) as Array<
    [keyof ThemeTokens, string]
  >) {
    const value = definition.tokens[key];
    if (value === undefined) continue;
    root.style.setProperty(variable, value);
    set.push(variable);
  }
  const previousMode = root.dataset.theme;
  root.dataset.theme = definition.mode;
  return () => {
    for (const variable of set) root.style.removeProperty(variable);
    if (previousMode === undefined) delete root.dataset.theme;
    else root.dataset.theme = previousMode;
  };
}

/**
 * Typed theme plugin: effect-owned token values, never component
 * structure. Honors the standard lifecycle invariant
 * (activate → applied, dispose → removed, reactivate → applied).
 */
export function defineTheme(definition: ThemeDefinition): PluginDefinition {
  return definePlugin({
    id: `froglight.theme.${definition.id}`,
    activate: (ctx) => {
      const root =
        typeof document === 'undefined'
          ? null
          : (document.documentElement as HTMLElement);
      const disposeTokens =
        root === null ? null : applyThemeTokens(root, definition);
      ctx.provide(themeToken, {
        id: definition.id,
        apply: () => ({
          dispose: () => disposeTokens?.(),
        }),
      });
      if (disposeTokens !== null) ctx.effect(() => disposeTokens);
    },
  });
}
