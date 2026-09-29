// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { defaultThemeCss } from './theme.js';
import {
  FL_THEME_TOKEN_NAMES,
  FL_TOKEN_NAMES,
  applyThemeTokens,
  defineTheme,
  type ThemeDefinition,
} from './theme-contract.js';
import { defineThemeTokenPlugin } from './theme.js';

/**
 * Theme contract (spec sections 1,3,4,5,7) — TDD red seam.
 * Agreed seam: token + computed styles (composed CSS text + jsdom outcomes),
 * never stylesheet source order or pixels.
 */
describe('theme contract (--fl-* stable API)', () => {
  it('exposes a namespaced public token list', () => {
    for (const name of [
      '--fl-surface-app',
      '--fl-surface-sidebar',
      '--fl-surface-raised',
      '--fl-surface-editor',
      '--fl-surface-input',
      '--fl-text-primary',
      '--fl-text-secondary',
      '--fl-text-muted',
      '--fl-accent',
      '--fl-accent-strong',
      '--fl-border-default',
      '--fl-border-strong',
      '--fl-radius-sm',
      '--fl-radius-md',
      '--fl-radius-lg',
      '--fl-shadow-low',
      '--fl-shadow-medium',
      '--fl-shadow-overlay',
      '--fl-motion-fast',
      '--fl-motion-normal',
      '--fl-ease-standard',
    ]) {
      expect(FL_TOKEN_NAMES, `missing token ${name}`).toContain(name);
    }
  });

  it('publishes layout metrics and platform env as non-overridable contract names', () => {
    for (const name of [
      '--fl-layout-sidebar-width',
      '--fl-layout-ribbon-width',
      '--fl-layout-tab-height',
      '--fl-safe-area-top',
    ]) {
      expect(FL_TOKEN_NAMES, `contract name ${name}`).toContain(name);
      // A Dracula-like theme overrides color/typography, never geometry:
      // layout + safe-area live in their own files, not the theme values.
      expect(FL_THEME_TOKEN_NAMES, `theme override ${name}`).not.toContain(
        name,
      );
    }
    expect(defaultThemeCss).toContain('--fl-layout-sidebar-width');
    expect(defaultThemeCss).toContain('--fl-safe-area-top');
  });

  it('defines every public token in the default bundle with light + dark values', () => {
    for (const token of FL_TOKEN_NAMES) {
      expect(defaultThemeCss, `missing ${token}`).toContain(token);
    }
    expect(defaultThemeCss).toContain("[data-theme='dark']");
  });

  it('does not publish pre-namespaced aliases', () => {
    for (const legacy of ['--bg', '--text', '--accent', '--border']) {
      expect(defaultThemeCss).not.toContain(`${legacy}:`);
    }
  });

  it('token overrides accept documented names and reject geometry/unknown', () => {
    expect(() =>
      defineThemeTokenPlugin('ok-fl', { tokens: { '--fl-accent': '#fff' } }),
    ).not.toThrow();
    for (const name of [
      '--bg',
      '--sidebar-w',
      '--fl-layout-sidebar-width',
      '--safe-top',
      '--fl-safe-area-top',
      'color',
    ]) {
      expect(() =>
        defineThemeTokenPlugin(`bad-${name}`, { tokens: { [name]: 'x' } }),
      ).toThrow(/invalid theme token name/);
    }
  });

  it('defineTheme applies typed tokens to the root without arbitrary CSS', () => {
    const def: ThemeDefinition = {
      id: 'nord-test',
      label: 'Nord test',
      mode: 'dark',
      tokens: {
        surfaceApp: '#2e3440',
        textPrimary: '#eceff4',
        accent: '#88c0d0',
      },
    };
    const plugin = defineTheme(def);
    expect(plugin.id).toContain('nord-test');
    const root = document.createElement('div');
    const dispose = applyThemeTokens(root, def);
    expect(root.style.getPropertyValue('--fl-surface-app')).toBe('#2e3440');
    expect(root.style.getPropertyValue('--fl-text-primary')).toBe('#eceff4');
    expect(root.style.getPropertyValue('--fl-accent')).toBe('#88c0d0');
    dispose();
    expect(root.style.getPropertyValue('--fl-surface-app')).toBe('');
  });
});
