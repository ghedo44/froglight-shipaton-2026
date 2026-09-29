/**
 * Accent capability conformance.
 *
 * Catalog integrity, override rendering across all three theme worlds,
 * singular element ownership, and settings binding. Runs in
 * plain node (no DOM): specs that need `document` install a minimal stub.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ACCENT_ID,
  ACCENTS,
  ACCENT_KEY,
  applyAccent,
  bindAccentToDocument,
  accentById,
  accentCss,
} from './accents.js';

describe('pro accent catalog', () => {
  it('ships the five selectable accents with stable ids, names, and swatches', () => {
    expect(ACCENTS.map((accent) => accent.id)).toEqual([
      'forest',
      'violet',
      'ocean',
      'ember',
      'rose',
    ]);
    for (const accent of ACCENTS) {
      expect(accent.id.length).toBeGreaterThan(0);
      expect(accent.name.length).toBeGreaterThan(0);
      expect(accent.swatch).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps every accent selectable with no lock concept', () => {
    for (const accent of ACCENTS) {
      expect(accentById(accent.id)).toBe(accent);
    }
    expect(accentById('nope')).toBeUndefined();
  });
});

describe('pro accent stylesheet', () => {
  it('renders nothing for the default accent', () => {
    expect(accentCss(DEFAULT_ACCENT_ID)).toBeNull();
    expect(accentCss('violet')).toContain('--fl-accent: #7c6cf0;');
    expect(accentCss('nope')).toBeNull();
  });

  it('covers light, explicit dark, and system dark worlds', () => {
    const css = accentCss('ocean');
    expect(css).not.toBeNull();
    const text = css as string;
    expect(text).toContain('@layer theme-overrides');
    expect(text).toContain(':root {');
    expect(text).toContain(":root[data-theme='dark']");
    expect(text).toContain('@media (prefers-color-scheme: dark)');
    expect(text).toContain('--fl-accent: #0284c7;');
    expect(text).toContain('--fl-accent-strong: #0369a1;');
    expect(text).toContain('--fl-accent-contrast: #ffffff;');
    expect(text).toContain('--fl-accent: #38bdf8;');
    expect(text).toContain('--fl-accent-contrast: #0c1a24;');
    // Tokens only: the only selectors are the world switches, no
    // structure, no classes, no element rules.
    expect(text.match(/:root/g)).toHaveLength(3);
    expect(text).not.toMatch(/(^|\n)\s*\.[a-zA-Z]/);
    expect(text).not.toMatch(/(^|\n)\s*button[\s,{]/);
  });

  it('keeps every accent structurally complete', () => {
    for (const accent of ACCENTS) {
      if (accent.id === DEFAULT_ACCENT_ID) continue;
      const css = accentCss(accent.id) as string;
      for (const token of [
        '--fl-accent:',
        '--fl-accent-strong:',
        '--fl-accent-contrast:',
        '--fl-accent-soft:',
      ]) {
        expect(css.split(token).length).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

interface StubElement {
  id: string;
  textContent: string | null;
  parentNode: null | object;
  remove(): void;
}

function installDocumentStub(initialAccent = DEFAULT_ACCENT_ID): {
  elements: Map<string, StubElement>;
  settings: {
    value: string;
    listeners: Set<(key: string, value: unknown) => void>;
    get(key: string, defaultValue: string): string;
    onChange(listener: (key: string, value: unknown) => void): { dispose(): void };
    set(value: string): void;
  };
} {
  const elements = new Map<string, StubElement>();
  const settings = {
    value: initialAccent,
    listeners: new Set<(key: string, value: unknown) => void>(),
    get(_key: string, defaultValue: string): string {
      void _key;
      return settings.value ?? defaultValue;
    },
    onChange(listener: (key: string, value: unknown) => void) {
      settings.listeners.add(listener);
      return { dispose: () => settings.listeners.delete(listener) };
    },
    set(value: string) {
      settings.value = value;
      for (const listener of [...settings.listeners]) {
        listener(ACCENT_KEY, value);
      }
    },
  };
  const documentStub = {
    head: { appendChild: vi.fn() },
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (_tag: string) => {
      void _tag;
      const element: StubElement = {
        id: '',
        textContent: null,
        parentNode: {},
        remove() {
          element.parentNode = null;
          if (element.id !== '') elements.delete(element.id);
        },
      };
      const proxy = new Proxy(element, {
        set(target, property, value) {
          if (property === 'id') {
            target.id = value as string;
            elements.set(value as string, proxy as unknown as StubElement);
            return true;
          }
          (target as unknown as Record<string | symbol, unknown>)[property] = value;
          return true;
        },
      });
      return proxy;
    },
  };
  (globalThis as Record<string, unknown>).document = documentStub;
  return { elements, settings };
}

describe('pro accent application', () => {
  it('owns exactly one override element and disposes it', () => {
    const { elements } = installDocumentStub();
    try {
      const first = applyAccent('ocean');
      expect(elements.has('froglight-accent')).toBe(true);
      const second = applyAccent('violet');
      expect(elements.has('froglight-accent')).toBe(true);
      expect(elements.size).toBe(1);
      second.dispose();
      first.dispose();
      expect(elements.has('froglight-accent')).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });

  it('default removes the override', () => {
    const { elements } = installDocumentStub();
    try {
      applyAccent('ocean');
      expect(elements.size).toBe(1);
      applyAccent(DEFAULT_ACCENT_ID);
      expect(elements.size).toBe(0);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });

  it('binds to settings changes and releases on dispose', () => {
    const { elements, settings } = installDocumentStub();
    try {
      const binding = bindAccentToDocument(settings);
      expect(elements.size).toBe(0);
      settings.set('ocean');
      expect(elements.size).toBe(1);
      settings.set(DEFAULT_ACCENT_ID);
      expect(elements.size).toBe(0);
      binding.dispose();
      settings.set('ocean');
      expect(elements.size).toBe(0);
      expect(settings.listeners.size).toBe(0);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });
});
