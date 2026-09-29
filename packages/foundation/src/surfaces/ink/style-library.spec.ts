import { describe, expect, it } from 'vitest';
import { InMemorySettingsService } from '../../settings.js';
import { InkPresetStore } from './presets.js';
import { SurfaceStyleLibrary } from './style-library.js';

describe('SurfaceStyleLibrary', () => {
  it('keeps saved styles immutable until explicit update', () => {
    const settings = new InMemorySettingsService();
    const presets = new InkPresetStore({ settings });
    presets.setTool('fountain', { color: '#123456', size: 3 });
    const library = new SurfaceStyleLibrary({
      presets,
      settings,
      idFactory: () => 'style-a',
    });
    const id = library.saveCurrent('fountain', 'Blue Fountain');
    presets.setTool('fountain', { color: '#abcdef' });
    expect(library.isModified('fountain')).toBe(true);
    expect(library.styles('fountain')[0]?.preset.color).toBe('#123456');
    expect(library.update(id!)).toBe(true);
    expect(library.styles('fountain')[0]?.preset.color).toBe('#abcdef');
  });

  it('restores complete styles across surfaces and restarts', () => {
    const settings = new InMemorySettingsService();
    const ink = new InkPresetStore({ settings });
    ink.setTool('brush', {
      color: '#994455',
      size: 8,
      brush: { streamline: 0.8 },
    });
    const first = new SurfaceStyleLibrary({
      presets: ink,
      settings,
      idFactory: () => 'brush-a',
    });
    first.saveCurrent('brush', 'Lettering');
    ink.setTool('brush', {
      color: '#000000',
      size: 2,
      brush: { streamline: 0.1 },
    });
    const notebook = new InkPresetStore({ settings });
    const restarted = new SurfaceStyleLibrary({ presets: notebook, settings });
    expect(restarted.apply('brush-a')).toBe(true);
    expect(notebook.getTool('brush')).toMatchObject({
      color: '#994455',
      size: 8,
      brush: { streamline: 0.8 },
    });
  });

  it('renames, favorites, reorders, deletes, and rejects invalid orders', () => {
    const presets = new InkPresetStore();
    const ids = ['a', 'b'];
    const library = new SurfaceStyleLibrary({
      presets,
      idFactory: () => ids.shift()!,
    });
    library.saveCurrent('pen', 'One');
    library.saveCurrent('pen', 'Two');
    expect(library.rename('a', 'Primary')).toBe(true);
    expect(library.setFavorite('a', true)).toBe(true);
    expect(library.reorder('pen', ['b', 'a'])).toBe(true);
    expect(library.styles('pen').map((style) => style.id)).toEqual(['b', 'a']);
    expect(library.reorder('pen', ['a'])).toBe(false);
    expect(library.delete('a')).toBe(true);
    expect(library.styles('pen')).toHaveLength(1);
  });

  it('synchronizes saved-style metadata between live surface libraries', () => {
    const settings = new InMemorySettingsService();
    const ink = new SurfaceStyleLibrary({
      presets: new InkPresetStore({ settings }),
      settings,
      idFactory: () => 'shared',
    });
    const notebook = new SurfaceStyleLibrary({
      presets: new InkPresetStore({ settings }),
      settings,
    });
    let changes = 0;
    notebook.onChange(() => changes++);
    ink.saveCurrent('fountain', 'Shared Fountain');
    expect(notebook.styles('fountain').map((style) => style.name)).toEqual([
      'Shared Fountain',
    ]);
    expect(changes).toBe(1);
    ink.dispose();
    notebook.dispose();
  });

  it('resets working state to the saved preset without mutating it', () => {
    const settings = new InMemorySettingsService();
    const presets = new InkPresetStore({ settings });
    presets.setTool('pen', { color: '#111111', size: 2 });
    const library = new SurfaceStyleLibrary({
      presets,
      settings,
      idFactory: () => 'reset-a',
    });
    const id = library.saveCurrent('pen', 'Resettable');
    expect(library.isModified('pen')).toBe(false);
    expect(library.reset('pen')).toBe(true);
    presets.setTool('pen', { color: '#222222', size: 6 });
    expect(library.isModified('pen')).toBe(true);
    expect(library.styles('pen')[0]?.preset.color).toBe('#111111');
    expect(library.reset('pen')).toBe(true);
    expect(presets.getTool('pen')).toMatchObject({
      color: '#111111',
      size: 2,
    });
    expect(library.isModified('pen')).toBe(false);
    expect(id).toBe('reset-a');
  });

  it('rejects reset with no selected style', () => {
    const library = new SurfaceStyleLibrary({
      presets: new InkPresetStore(),
    });
    expect(library.reset('pen')).toBe(false);
    expect(library.isModified('pen')).toBe(false);
  });

  it('keeps save-as-new stable: new id, old unchanged, current moves', () => {
    const presets = new InkPresetStore();
    const ids = ['a', 'b'];
    const library = new SurfaceStyleLibrary({
      presets,
      idFactory: () => ids.shift()!,
    });
    presets.setTool('fountain', { color: '#111111', size: 2 });
    expect(library.saveCurrent('fountain', 'First')).toBe('a');
    presets.setTool('fountain', { color: '#222222', size: 6 });
    expect(library.saveCurrent('fountain', 'Second')).toBe('b');
    expect(library.snapshot().currentStyleByTool.fountain).toBe('b');
    expect(
      library.styles('fountain').find((style) => style.id === 'a')?.preset,
    ).toMatchObject({ color: '#111111', size: 2 });
    expect(
      library.styles('fountain').find((style) => style.id === 'b')?.preset,
    ).toMatchObject({ color: '#222222', size: 6 });
    expect(library.isModified('fountain')).toBe(false);
  });

  it('persists styles and selection across restarts through shared settings', () => {
    const settings = new InMemorySettingsService();
    const firstPresets = new InkPresetStore({ settings });
    firstPresets.setTool('pencil', { color: '#333333', size: 4 });
    const first = new SurfaceStyleLibrary({
      presets: firstPresets,
      settings,
      idFactory: () => 'persist-a',
    });
    first.saveCurrent('pencil', 'Persisted');
    first.setFavorite('persist-a', true);
    first.dispose();
    // Restart: new stores over the same settings service.
    const secondPresets = new InkPresetStore({ settings });
    const second = new SurfaceStyleLibrary({
      presets: secondPresets,
      settings,
    });
    expect(second.styles('pencil').map((style) => style.name)).toEqual([
      'Persisted',
    ]);
    expect(second.styles('pencil')[0]?.favorite).toBe(true);
    expect(second.snapshot().currentStyleByTool.pencil).toBe('persist-a');
    expect(secondPresets.getTool('pencil')).toMatchObject({
      color: '#333333',
      size: 4,
    });
    second.dispose();
  });

  it('shares one style library across Ink, Notebook, and Whiteboard', () => {
    const settings = new InMemorySettingsService();
    const inkPresets = new InkPresetStore({ settings });
    const notebookPresets = new InkPresetStore({ settings });
    const whiteboardPresets = new InkPresetStore({ settings });
    inkPresets.setTool('fountain', { color: '#0a2540', size: 3.5 });
    const ink = new SurfaceStyleLibrary({
      presets: inkPresets,
      settings,
      idFactory: () => 'cross-doc',
    });
    const notebook = new SurfaceStyleLibrary({
      presets: notebookPresets,
      settings,
    });
    const whiteboard = new SurfaceStyleLibrary({
      presets: whiteboardPresets,
      settings,
    });
    ink.saveCurrent('fountain', 'Cross-doc Fountain');
    for (const library of [notebook, whiteboard]) {
      expect(library.styles('fountain').map((style) => style.name)).toEqual([
        'Cross-doc Fountain',
      ]);
      expect(library.apply('cross-doc')).toBe(true);
    }
    expect(notebookPresets.getTool('fountain')).toMatchObject({
      color: '#0a2540',
      size: 3.5,
    });
    expect(whiteboardPresets.getTool('fountain')).toMatchObject({
      color: '#0a2540',
      size: 3.5,
    });
    ink.dispose();
    notebook.dispose();
    whiteboard.dispose();
  });

  it('rejects unsupported versions and corrupt payloads without throwing', () => {
    const settings = new InMemorySettingsService();
    settings.set(
      'ink.style-library',
      JSON.stringify({
        version: 2,
        styles: [
          {
            id: 'future',
            name: 'Future',
            toolKind: 'pen',
            preset: {},
            favorite: false,
            order: 0,
          },
        ],
        currentStyleByTool: { pen: 'future' },
      }),
    );
    const unsupported = new SurfaceStyleLibrary({
      presets: new InkPresetStore(),
      settings,
    });
    expect(unsupported.styles()).toEqual([]);
    expect(unsupported.snapshot().currentStyleByTool.pen).toBeNull();
    settings.set('ink.style-library', '{not json');
    const corrupt = new SurfaceStyleLibrary({
      presets: new InkPresetStore(),
      settings,
    });
    expect(corrupt.styles()).toEqual([]);
    settings.set(
      'ink.style-library',
      JSON.stringify({
        version: 1,
        styles: [
          {
            id: 'good',
            name: 'Good',
            toolKind: 'pen',
            preset: { color: '#111111' },
            favorite: false,
            order: 0,
          },
          { id: '', name: '', toolKind: 'nope', preset: {}, order: 0 },
        ],
        currentStyleByTool: { pen: 'good' },
      }),
    );
    const filtered = new SurfaceStyleLibrary({
      presets: new InkPresetStore(),
      settings,
    });
    expect(filtered.styles().map((style) => style.id)).toEqual(['good']);
    unsupported.dispose();
    corrupt.dispose();
    filtered.dispose();
  });
});
