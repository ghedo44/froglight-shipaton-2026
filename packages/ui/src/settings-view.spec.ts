// @vitest-environment jsdom
/**
 * Appearance binder lifecycle.
 *
 * Proves the AGENTS.md lifecycle invariant for `bindAppearanceToDocument`:
 * activate -> one registration, dispose -> zero registrations,
 * reactivate -> one registration — with no leaked theme/font effects.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  bindAppearanceToDocument,
  FONT_SIZE_KEY,
  THEME_KEY,
} from './settings-view.js';
import type {
  WorkspaceSettingsService,
  WorkspaceSettingsValue,
} from './workspace-settings.js';
import { MOTION_KEY, isMotionReduced } from './motion.js';

function fakeSettings(
  initial: Record<string, WorkspaceSettingsValue> = {},
): WorkspaceSettingsService & {
  listenerCount(): number;
} {
  const values: Record<string, WorkspaceSettingsValue> = { ...initial };
  const listeners = new Set<
    (key: string, value: WorkspaceSettingsValue) => void
  >();
  return {
    get<T extends WorkspaceSettingsValue>(key: string, defaultValue: T): T {
      const value = values[key];
      return (value === undefined ? defaultValue : value) as T;
    },
    set(key: string, value: WorkspaceSettingsValue): void {
      values[key] = value;
      for (const listener of [...listeners]) listener(key, value);
    },
    onChange(listener: (key: string, value: WorkspaceSettingsValue) => void): {
      dispose(): void;
    } {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    listenerCount: (): number => listeners.size,
  };
}

function resetDocument(): void {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.flMotion;
  document.documentElement.style.removeProperty('--fl-editor-font-size');
  document.documentElement.style.removeProperty('--editor-font-size');
}

afterEach(resetDocument);

describe('bindAppearanceToDocument lifecycle', () => {
  it('overrides the system, updates live, and releases the motion policy on dispose', () => {
    const settings = fakeSettings({ [MOTION_KEY]: 'off' });
    const binding = bindAppearanceToDocument(settings);
    expect(isMotionReduced()).toBe(true);
    settings.set(MOTION_KEY, 'on');
    expect(isMotionReduced()).toBe(false);
    settings.set(MOTION_KEY, 'unexpected');
    expect(document.documentElement.dataset.flMotion).toBe('system');
    settings.set(MOTION_KEY, 'off');
    binding.dispose();
    binding.dispose();
    expect(document.documentElement.dataset.flMotion).toBeUndefined();
    expect(settings.listenerCount()).toBe(0);
    settings.set(MOTION_KEY, 'on');
    expect(document.documentElement.dataset.flMotion).toBeUndefined();
  });

  it('applies dark theme plus both font vars on bind', () => {
    const settings = fakeSettings({ [THEME_KEY]: 'dark', [FONT_SIZE_KEY]: 18 });
    const binding = bindAppearanceToDocument(settings);
    try {
      expect(settings.listenerCount()).toBe(1);
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-editor-font-size',
        ),
      ).toBe('18px');
      expect(
        document.documentElement.style.getPropertyValue('--editor-font-size'),
      ).toBe('18px');
    } finally {
      binding.dispose();
    }
  });

  it('dispose clears theme, both font vars, and listeners; double-dispose is safe', () => {
    const settings = fakeSettings({ [THEME_KEY]: 'dark', [FONT_SIZE_KEY]: 18 });
    const binding = bindAppearanceToDocument(settings);
    expect(document.documentElement.dataset.theme).toBe('dark');

    binding.dispose();

    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(
      document.documentElement.style.getPropertyValue('--fl-editor-font-size'),
    ).toBe('');
    expect(
      document.documentElement.style.getPropertyValue('--editor-font-size'),
    ).toBe('');
    expect(settings.listenerCount()).toBe(0);

    // Idempotent-safe: double-dispose must not throw.
    expect(() => binding.dispose()).not.toThrow();

    // No further updates flow after dispose.
    settings.set(THEME_KEY, 'light');
    settings.set(FONT_SIZE_KEY, 20);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(
      document.documentElement.style.getPropertyValue('--fl-editor-font-size'),
    ).toBe('');
    expect(
      document.documentElement.style.getPropertyValue('--editor-font-size'),
    ).toBe('');
  });

  it('rebind works: activate -> 1 / dispose -> 0 / reactivate -> 1', () => {
    const settings = fakeSettings({ [THEME_KEY]: 'dark', [FONT_SIZE_KEY]: 18 });

    const first = bindAppearanceToDocument(settings);
    expect(settings.listenerCount()).toBe(1);
    expect(document.documentElement.dataset.theme).toBe('dark');
    first.dispose();
    expect(settings.listenerCount()).toBe(0);
    expect(document.documentElement.dataset.theme).toBeUndefined();

    settings.set(THEME_KEY, 'light');
    settings.set(FONT_SIZE_KEY, 20);
    const second = bindAppearanceToDocument(settings);
    try {
      expect(settings.listenerCount()).toBe(1);
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-editor-font-size',
        ),
      ).toBe('20px');
      expect(
        document.documentElement.style.getPropertyValue('--editor-font-size'),
      ).toBe('20px');
    } finally {
      second.dispose();
    }
    expect(settings.listenerCount()).toBe(0);
  });
});
