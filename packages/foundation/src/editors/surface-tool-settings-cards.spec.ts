/**
 * Structured saved-style payload.
 *
 * The generic `value`/`options`/`label` triple is insufficient for visual
 * cards: labels lose brush kind, opacity, pressure, and tip, forcing
 * fragile parsing. The additive `savedStyles`/`savedStyleModified`/
 * `workingPreset` fields carry the same styles structurally while
 * preserving legacy rendering; per-card favorite/delete accept an explicit
 * style id without forcing a selection change (legacy absent value keeps
 * current-style behavior).
 */

import { describe, expect, it } from 'vitest';
import {
  buildActiveToolSettingsControls,
  executeSurfaceToolSettingsControl,
  type SurfaceToolSettingsHost,
} from './surface-tool-settings.js';
import type { SurfaceStylePreset } from '../surfaces/ink/style-library.js';

function style(
  id: string,
  name: string,
  overrides: Partial<SurfaceStylePreset> = {},
): SurfaceStylePreset {
  return {
    id,
    name,
    toolKind: 'fountain',
    preset: { color: '#123456', size: 3.5 },
    favorite: false,
    order: 0,
    ...overrides,
  };
}

function host(
  overrides: Partial<SurfaceToolSettingsHost> = {},
): SurfaceToolSettingsHost {
  return {
    activeToolId: () => 'froglight.ink.fountain',
    setTool: () => undefined,
    toolPreset: () => ({ color: '#abcdef', size: 5 }),
    setToolPreset: () => undefined,
    eraserPreset: () => ({}),
    setEraserPreset: () => undefined,
    lassoPreset: () => ({}),
    setLassoPreset: () => undefined,
    recentColors: () => [],
    savedStyles: () => [
      style('a', 'Blue', {
        favorite: true,
        preset: {
          color: '#123456',
          size: 3.5,
          opacity: 0.9,
          brush: {
            kind: 'fountain',
            pressure: { enabled: true, minFactor: 0.5, maxFactor: 1.7 },
            tip: { shape: 'flat', aspect: 0.35, cap: 'round' },
          },
        },
      }),
      style('b', 'Notes', {
        preset: { color: '#ff0000', size: 6 },
      }),
    ],
    currentStyleId: () => 'a',
    savedStyleModified: () => true,
    ...overrides,
  };
}

const OPTIONS = {
  prefix: 'ink',
  swatches: ['#111111'],
  widths: [2, 3.5, 6],
} as const;

describe('saved-style structured payload', () => {
  it('carries structured styles, modified flag, and working preset', () => {
    const controls = buildActiveToolSettingsControls(host(), OPTIONS);
    const saved = controls.find(
      (entry) => entry.id === 'ink.settings.fountain.saved-style',
    );
    expect(saved?.kind).toBe('choice');
    if (saved?.kind !== 'choice') return;
    expect(saved.value).toBe('a');
    expect(saved.savedStyleModified).toBe(true);
    expect(saved.workingPreset).toMatchObject({ color: '#abcdef', size: 5 });
    expect(saved.savedStyles).toHaveLength(2);
    expect(saved.savedStyles?.[0]).toMatchObject({
      id: 'a',
      name: 'Blue',
      toolKind: 'fountain',
      favorite: true,
      preset: {
        color: '#123456',
        size: 3.5,
        opacity: 0.9,
        brush: {
          kind: 'fountain',
          pressure: { enabled: true, minFactor: 0.5, maxFactor: 1.7 },
          tip: { shape: 'flat', aspect: 0.35 },
        },
      },
    });
    // Legacy triple survives for old renderers (stylus palette, tests).
    expect(saved.options.map((option) => option.value)).toEqual(['', 'a', 'b']);
    expect(saved.semanticRole).toBe('surface.style.saved');
  });

  it('reports clean working state without modification', () => {
    const controls = buildActiveToolSettingsControls(
      host({ savedStyleModified: () => false }),
      OPTIONS,
    );
    const saved = controls.find(
      (entry) => entry.id === 'ink.settings.fountain.saved-style',
    );
    if (saved?.kind !== 'choice') throw new Error('missing saved-style');
    expect(saved.savedStyleModified).toBe(false);
  });

  it('copies presets by value so card data never aliases live state', () => {
    const live = { color: '#111111', size: 2 };
    const controls = buildActiveToolSettingsControls(
      host({
        toolPreset: () => live,
        savedStyles: () => [style('a', 'Blue', { preset: live })],
      }),
      OPTIONS,
    );
    const saved = controls.find(
      (entry) => entry.id === 'ink.settings.fountain.saved-style',
    );
    if (saved?.kind !== 'choice') throw new Error('missing saved-style');
    live.color = '#mutated';
    expect(saved.workingPreset?.color).toBe('#111111');
    expect(saved.savedStyles?.[0]?.preset.color).toBe('#111111');
  });

  it('toggles a non-selected card favorite by explicit id', () => {
    const calls: string[] = [];
    const h = host({
      favoriteSavedStyle: (id, favorite) => (
        calls.push(`${id}:${favorite}`),
        true
      ),
    });
    expect(
      executeSurfaceToolSettingsControl(
        h,
        OPTIONS,
        'ink.settings.fountain.favorite-style',
        'b',
      ),
    ).toBe(true);
    // `b` was not favorite → toggles to true without touching current `a`.
    expect(calls).toEqual(['b:true']);
  });

  it('keeps legacy current-style favorite when no value is passed', () => {
    const calls: string[] = [];
    const h = host({
      favoriteSavedStyle: (id, favorite) => (
        calls.push(`${id}:${favorite}`),
        true
      ),
    });
    expect(
      executeSurfaceToolSettingsControl(
        h,
        OPTIONS,
        'ink.settings.fountain.favorite-style',
      ),
    ).toBe(true);
    // Current `a` was favorite → toggles to false.
    expect(calls).toEqual(['a:false']);
  });

  it('deletes a non-selected card by explicit id', () => {
    const calls: string[] = [];
    const h = host({
      deleteSavedStyle: (id) => (calls.push(id), true),
    });
    expect(
      executeSurfaceToolSettingsControl(
        h,
        OPTIONS,
        'ink.settings.fountain.delete-style',
        'b',
      ),
    ).toBe(true);
    expect(calls).toEqual(['b']);
  });

  it('rejects unknown favorite/delete ids without side effects', () => {
    const h = host({
      favoriteSavedStyle: () => {
        throw new Error('must not favorite unknown');
      },
      deleteSavedStyle: () => {
        throw new Error('must not delete unknown');
      },
    });
    expect(
      executeSurfaceToolSettingsControl(
        h,
        OPTIONS,
        'ink.settings.fountain.favorite-style',
        'missing',
      ),
    ).toBe(false);
    expect(
      executeSurfaceToolSettingsControl(
        h,
        OPTIONS,
        'ink.settings.fountain.delete-style',
        'missing',
      ),
    ).toBe(false);
  });
});
