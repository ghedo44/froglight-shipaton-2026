/**
 * Appearance accents.
 *
 * The accent picker lives in the Appearance settings section as a free
 * capability for every user: all accents are selectable with no
 * entitlement check. Overrides live in the `theme-overrides` cascade
 * layer and set only the four documented accent tokens
 * (`--fl-accent`, `--fl-accent-strong`, `--fl-accent-contrast`,
 * `--fl-accent-soft`) under every world selector the default themes use
 * (`:root`, `:root[data-theme='dark']`, system-preference media query), so
 * an accent stays correct in light, dark, and system worlds.
 *
 * Persistence rides workspace settings like the base theme choice.
 */

/** Workspace settings key for the selected accent id. */
export const ACCENT_KEY = 'appearance.accent';

/** Unset/default accent: no override element, the Forest theme applies. */
export const DEFAULT_ACCENT_ID = 'forest';

export interface AccentTokens {
  readonly accent: string;
  readonly strong: string;
  readonly contrast: string;
  readonly soft: string;
}

export interface AccentDef {
  /** Stable id persisted in workspace settings. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Swatch dot color shown in the picker (light-world accent). */
  readonly swatch: string;
  readonly light: AccentTokens;
  readonly dark: AccentTokens;
}

const SOFT = (rgb: string, alpha: number): string =>
  `rgba(${rgb}, ${alpha})`;

export const ACCENTS: readonly AccentDef[] = [
  {
    id: 'forest',
    name: 'Forest',
    swatch: '#15803d',
    light: {
      accent: '#15803d',
      strong: '#166534',
      contrast: '#ffffff',
      soft: SOFT('21, 128, 61', 0.12),
    },
    dark: {
      accent: '#4ade80',
      strong: '#86efac',
      contrast: '#0f1f14',
      soft: SOFT('74, 222, 128', 0.16),
    },
  },
  {
    id: 'violet',
    name: 'Violet',
    swatch: '#7c6cf0',
    light: {
      accent: '#7c6cf0',
      strong: '#604ae0',
      contrast: '#ffffff',
      soft: SOFT('124, 108, 240', 0.11),
    },
    dark: {
      accent: '#9b8bf5',
      strong: '#b4a7ff',
      contrast: '#17141f',
      soft: SOFT('155, 139, 245', 0.16),
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    swatch: '#0284c7',
    light: {
      accent: '#0284c7',
      strong: '#0369a1',
      contrast: '#ffffff',
      soft: SOFT('2, 132, 199', 0.12),
    },
    dark: {
      accent: '#38bdf8',
      strong: '#7dd3fc',
      contrast: '#0c1a24',
      soft: SOFT('56, 189, 248', 0.16),
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    swatch: '#c2410c',
    light: {
      accent: '#c2410c',
      strong: '#9a3412',
      contrast: '#ffffff',
      soft: SOFT('194, 65, 12', 0.12),
    },
    dark: {
      accent: '#fb923c',
      strong: '#fdba74',
      contrast: '#231206',
      soft: SOFT('251, 146, 60', 0.16),
    },
  },
  {
    id: 'rose',
    name: 'Rose',
    swatch: '#be123c',
    light: {
      accent: '#be123c',
      strong: '#9f1239',
      contrast: '#ffffff',
      soft: SOFT('190, 18, 60', 0.12),
    },
    dark: {
      accent: '#fb7185',
      strong: '#fda4af',
      contrast: '#220f14',
      soft: SOFT('251, 113, 133', 0.16),
    },
  },
];

export function accentById(id: string): AccentDef | undefined {
  return ACCENTS.find((accent) => accent.id === id);
}

function accentDeclarations(tokens: AccentTokens): string {
  return [
    `  --fl-accent: ${tokens.accent};`,
    `  --fl-accent-strong: ${tokens.strong};`,
    `  --fl-accent-contrast: ${tokens.contrast};`,
    `  --fl-accent-soft: ${tokens.soft};`,
  ].join('\n');
}

/**
 * Render the override stylesheet for one accent. Exported for tests; prefer
 * `applyAccent` at runtime so element ownership stays singular.
 */
export function accentCss(id: string): string | null {
  if (id === DEFAULT_ACCENT_ID) return null;
  const def = accentById(id);
  if (def === undefined) return null;
  return [
    '@layer theme-overrides {',
    ':root {',
    accentDeclarations(def.light),
    '}',
    ":root[data-theme='dark'] {",
    accentDeclarations(def.dark),
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme]) {',
    accentDeclarations(def.dark),
    '  }',
    '}',
    '}',
  ].join('\n');
}

const ACCENT_STYLE_ID = 'froglight-accent';

/**
 * Apply an accent id to the document; returns a reset disposer. The
 * default id removes any override. Exactly one override element exists at
 * a time; reapplying replaces it. No-op without a DOM document.
 */
export function applyAccent(id: string): { dispose(): void } {
  if (typeof document === 'undefined') return { dispose: () => undefined };
  document.getElementById(ACCENT_STYLE_ID)?.remove();
  if (id === DEFAULT_ACCENT_ID || accentById(id) === undefined) {
    return { dispose: () => undefined };
  }
  const style = document.createElement('style');
  style.id = ACCENT_STYLE_ID;
  style.textContent = accentCss(id) ?? '';
  document.head.appendChild(style);
  return {
    dispose: () => {
      if (style.parentNode !== null) style.remove();
    },
  };
}

export interface AccentSettings {
  get(key: string, defaultValue: string): string;
  onChange(listener: (key: string, value: unknown) => void): {
    dispose(): void;
  };
}

/**
 * Keep the document accent in sync with settings changes, mirroring
 * `bindAppearanceToDocument` in `settings-view.ts`. The settings plugin
 * owns this effect for as long as its fiber lives.
 */
export function bindAccentToDocument(settings: AccentSettings): {
  dispose(): void;
} {
  let disposer = applyAccent(settings.get(ACCENT_KEY, DEFAULT_ACCENT_ID));
  const subscription = settings.onChange((key) => {
    if (key !== ACCENT_KEY) return;
    disposer.dispose();
    disposer = applyAccent(settings.get(ACCENT_KEY, DEFAULT_ACCENT_ID));
  });
  return {
    dispose: () => {
      subscription.dispose();
      disposer.dispose();
    },
  };
}
