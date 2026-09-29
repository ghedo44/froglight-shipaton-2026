/**
 * Family-shared live preset state: live color/size are shared inside
 * the pen family (pen/fountain/brush/pencil) with the highlighter
 * independent; opacity, straight-line hold, and brush tuning stay
 * per-tool. Primitives persist through an optional SettingsService
 * (shared across Ink/Notebook/Whiteboard without sharing live objects);
 * brush tuning stays per-tool. Fully headless.
 */

import { describe, expect, it } from 'vitest';
import { InMemorySettingsService } from '../../settings.js';
import {
  ERASER_MODE_BY_SEMANTIC_ROLE,
  ERASER_SEMANTIC_ROLE_BY_MODE,
  INK_PEN_FAMILY_TOOLS,
  InkPresetStore,
  eraserSemanticRoleForPreset,
  inkSlotFamilyForTool,
  normalizeEraserMode,
} from './presets.js';
import { DEFAULT_ERASER_MODE, isEraserMode } from './eraser-geometry.js';

describe('tool preset defaults', () => {
  it('starts every drawing tool with an empty preset', () => {
    const store = new InkPresetStore();
    for (const tool of [
      'pen',
      'fountain',
      'brush',
      'pencil',
      'highlighter',
    ] as const) {
      expect(store.getTool(tool)).toEqual({});
    }
    expect(store.getEraser()).toEqual({});
    store.dispose();
  });
});

describe('family-shared live values', () => {
  it('shares color and size across pen-family switches', () => {
    const store = new InkPresetStore();
    store.setTool('pen', { color: '#ff0000', size: 2 });
    store.setTool('highlighter', { color: '#00ff00', size: 14 });
    // Switching inside the pen family keeps the shared pair; the
    // highlighter family stays independent.
    expect(store.getTool('pen')).toEqual({ color: '#ff0000', size: 2 });
    expect(store.getTool('fountain')).toEqual({ color: '#ff0000', size: 2 });
    expect(store.getTool('highlighter')).toEqual({
      color: '#00ff00',
      size: 14,
    });
    store.setTool('pen', { size: 5 });
    expect(store.getTool('pen')).toEqual({ color: '#ff0000', size: 5 });
    expect(store.getTool('fountain')).toEqual({ color: '#ff0000', size: 5 });
    expect(store.getTool('brush')).toEqual({ color: '#ff0000', size: 5 });
    expect(store.getTool('pencil')).toEqual({ color: '#ff0000', size: 5 });
    expect(store.getTool('highlighter')).toEqual({
      color: '#00ff00',
      size: 14,
    });
    store.dispose();
  });

  it('keeps the repro shared: Fountain Thick -> Pen Thick', () => {
    const store = new InkPresetStore();
    store.setTool('fountain', { size: 6 });
    expect(store.getTool('pen').size).toBe(6);
    expect(store.getTool('fountain').size).toBe(6);
    store.setTool('brush', { color: '#123456' });
    expect(store.getTool('pencil').color).toBe('#123456');
    expect(store.getTool('pen').color).toBe('#123456');
    store.dispose();
  });

  it('keeps opacity, straight-line hold, and brush tuning per-tool', () => {
    const store = new InkPresetStore();
    store.setTool('pen', {
      color: '#111111',
      size: 2,
      opacity: 0.8,
      brush: { stabilization: 0.6 },
    });
    store.setTool('fountain', { opacity: 0.4, brush: { streamline: 0.2 } });
    store.setTool('highlighter', { straight: true });
    // Shared pair moved everywhere in the family…
    expect(store.getTool('fountain')).toMatchObject({
      color: '#111111',
      size: 2,
    });
    // …while advanced tuning stayed on its own tool.
    expect(store.getTool('pen')).toMatchObject({
      opacity: 0.8,
      brush: { stabilization: 0.6 },
    });
    expect(store.getTool('fountain')).toMatchObject({
      opacity: 0.4,
      brush: { streamline: 0.2 },
    });
    expect(store.getTool('pen').straight).toBeUndefined();
    expect(store.getTool('highlighter').straight).toBe(true);
    expect(store.getTool('highlighter').opacity).toBeUndefined();
    store.dispose();
  });

  it('converges divergent legacy presets pen-first without throwing', () => {
    const settings = new InMemorySettingsService();
    settings.set('ink.preset.fountain.color', '#222222');
    settings.set('ink.preset.brush.color', '#333333');
    settings.set('ink.preset.pencil.size', 9);
    settings.set('ink.preset.fountain.size', 3);
    // Corrupt values never break the read; they are skipped.
    settings.set('ink.preset.pen.color', 42 as never);
    settings.set('ink.preset.pen.size', -4);
    const store = new InkPresetStore({ settings });
    // Pen entries are corrupt → first VALID wins (fountain here).
    expect(store.getTool('pen').color).toBe('#222222');
    expect(store.getTool('brush').color).toBe('#222222');
    expect(store.getTool('pencil').size).toBe(3);
    // A stored pen value wins over every sibling (canonical order).
    settings.set('ink.preset.pen.color', '#111111');
    settings.set('ink.preset.pen.size', 2);
    expect(store.getTool('fountain')).toMatchObject({
      color: '#111111',
      size: 2,
    });
    expect(store.getTool('pencil')).toMatchObject({
      color: '#111111',
      size: 2,
    });
    // The highlighter never joins the pen convergence.
    expect(store.getTool('highlighter')).toEqual({});
    store.dispose();
  });

  it('clears the family pair when one sibling clears it', () => {
    const store = new InkPresetStore();
    store.setTool('pen', { color: '#ff0000', size: 2 });
    store.setTool('fountain', { color: '' });
    expect(store.getTool('pen').color).toBeUndefined();
    expect(store.getTool('fountain').color).toBeUndefined();
    expect(store.getTool('pen').size).toBe(2);
    store.dispose();
  });

  it('persists brush tuning through the settings service', () => {
    const settings = new InMemorySettingsService();
    const store = new InkPresetStore({ settings });
    store.setTool('fountain', {
      color: '#111111',
      brush: { stabilization: 0.6 },
    });
    expect(store.getTool('fountain')).toEqual({
      color: '#111111',
      brush: { stabilization: 0.6 },
    });
    // Primitives persist per key; brush tuning persists as one validated
    // JSON record per tool (tuning survives reload).
    // The color fans out to every pen-family member so the
    // shared pair survives reload for all four siblings.
    expect([...settings.entries().keys()].sort()).toEqual([
      'ink.preset.brush.color',
      'ink.preset.fountain.brush',
      'ink.preset.fountain.color',
      'ink.preset.pen.color',
      'ink.preset.pencil.color',
    ]);
    const second = new InkPresetStore({ settings });
    expect(second.getTool('fountain')).toEqual({
      color: '#111111',
      brush: { stabilization: 0.6 },
    });
    // Reload reads the shared pair on every pen-family sibling; brush
    // tuning stays on fountain alone.
    expect(second.getTool('pen')).toEqual({ color: '#111111' });
    expect(second.getTool('brush')).toEqual({ color: '#111111' });
    store.dispose();
    second.dispose();
  });

  it('ignores corrupt brush records instead of throwing', () => {
    const settings = new InMemorySettingsService();
    settings.set('ink.preset.pen.brush', 'not-json{{{');
    const store = new InkPresetStore({ settings });
    expect(store.getTool('pen')).toEqual({});
    // Partially corrupt records keep their valid fields.
    settings.set(
      'ink.preset.pen.brush',
      JSON.stringify({ stabilization: 0.7, size: -4, tip: { shape: 'cube' } }),
    );
    expect(store.getTool('pen')).toEqual({ brush: { stabilization: 0.7 } });
    store.dispose();
  });
});

describe('settings persistence', () => {
  it('shares user defaults across stores through one service', () => {
    const settings = new InMemorySettingsService();
    const first = new InkPresetStore({ settings });
    first.setTool('pen', { color: '#123456', size: 4, opacity: 0.8 });
    first.setEraser({ radius: 12 });
    // A second store (another surface) reads the same user defaults
    // without sharing live objects.
    const second = new InkPresetStore({ settings });
    expect(second.getTool('pen')).toEqual({
      color: '#123456',
      size: 4,
      opacity: 0.8,
    });
    expect(second.getEraser()).toEqual({ radius: 12 });
    second.setTool('pen', { color: '#654321' });
    expect(first.getTool('pen').color).toBe('#654321');
    first.dispose();
    second.dispose();
  });

  it('notifies subscribers on preset and external settings changes', () => {
    const settings = new InMemorySettingsService();
    const store = new InkPresetStore({ settings });
    let notifications = 0;
    const sub = store.onChange(() => {
      notifications += 1;
    });
    store.setTool('pen', { size: 6 });
    expect(notifications).toBe(1);
    // External writes (another surface) propagate too.
    settings.set('ink.preset.pen.color', '#abcdef');
    expect(notifications).toBe(2);
    expect(store.getTool('pen').color).toBe('#abcdef');
    // Disposal cuts both store and settings notifications.
    sub.dispose();
    store.dispose();
    store.setTool('pen', { size: 9 });
    settings.set('ink.preset.pen.color', '#000000');
    expect(notifications).toBe(2);
  });

  it('serializes and restores the full preset state', () => {
    const store = new InkPresetStore();
    store.setTool('pen', { color: '#ff0000', brush: { streamline: 0.9 } });
    store.setEraser({ radius: 14 });
    store.setLineArrows('none');
    const snapshot = store.snapshot();
    expect(snapshot.pen).toEqual({
      color: '#ff0000',
      brush: { streamline: 0.9 },
    });
    expect(snapshot.eraser).toEqual({ radius: 14 });
    expect(snapshot.lineArrows).toBe('none');
    const restored = new InkPresetStore();
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    store.dispose();
    restored.dispose();
  });

  it('restore replaces the full state instead of merging', () => {
    const store = new InkPresetStore();
    store.setTool('pen', {
      color: '#ff0000',
      size: 8,
      brush: { stabilization: 1 },
    });
    store.setEraser({ radius: 14, mode: 'precision' });
    store.restore({
      pen: { color: '#000000' },
      fountain: {},
      brush: {},
      pencil: {},
      highlighter: {},
      eraser: {},
      lasso: {},
    });
    // Absent fields are cleared — size and brush tuning do not survive.
    expect(store.getTool('pen')).toEqual({ color: '#000000' });
    expect(store.getEraser()).toEqual({});
    store.dispose();
  });

  it('exports and imports versioned preferences with validation', () => {
    const store = new InkPresetStore();
    store.setTool('pen', { color: '#123456', brush: { taperStart: 0.2 } });
    store.setEraser({ radius: 12 });
    store.setLineArrows('both');
    const exported = store.exportPreferences();
    expect(exported.version).toBe(1);
    expect(exported.pen).toEqual({
      color: '#123456',
      brush: { taperStart: 0.2 },
    });
    const restored = new InkPresetStore();
    expect(restored.importPreferences(exported)).toBe(true);
    expect(restored.snapshot()).toEqual(store.snapshot());
    // Unknown versions never touch current state.
    expect(restored.importPreferences({ version: 99, pen: {} })).toBe(false);
    expect(restored.getTool('pen')).toEqual({
      color: '#123456',
      brush: { taperStart: 0.2 },
    });
    // Non-objects are rejected without throwing.
    expect(restored.importPreferences(null)).toBe(false);
    expect(restored.importPreferences('nope')).toBe(false);
    store.dispose();
    restored.dispose();
  });

  it('stores lasso mode and filter, rejecting unknown values', () => {
    const settings = new InMemorySettingsService();
    const store = new InkPresetStore({ settings });
    expect(store.getLasso()).toEqual({});
    store.setLasso({ mode: 'rectangle', filter: 'shapes' });
    expect(store.getLasso()).toEqual({ mode: 'rectangle', filter: 'shapes' });
    expect([...settings.entries().keys()].sort()).toEqual([
      'ink.preset.lasso.filter',
      'ink.preset.lasso.mode',
    ]);
    store.setLasso({ mode: 'circle' as never });
    expect(store.getLasso()).toEqual({ filter: 'shapes' });
    expect(store.snapshot().lasso).toEqual({ filter: 'shapes' });
    store.dispose();
  });

  it('stores eraser mode, filter, and auto-return (persisted primitives)', () => {
    const settings = new InMemorySettingsService();
    const store = new InkPresetStore({ settings });
    store.setEraser({ mode: 'precision', filter: 'ink', autoReturn: true });
    expect(store.getEraser()).toEqual({
      mode: 'precision',
      filter: 'ink',
      autoReturn: true,
    });
    expect([...settings.entries().keys()].sort()).toEqual([
      'ink.preset.eraser.autoReturn',
      'ink.preset.eraser.filter',
      'ink.preset.eraser.mode',
    ]);
    // Invalid values reset to absent instead of persisting garbage.
    store.setEraser({
      mode: 'vaporize' as never,
      filter: 'everything' as never,
    });
    expect(store.getEraser()).toEqual({ autoReturn: true });
    // A second store shares the persisted preset.
    const second = new InkPresetStore({ settings });
    expect(second.getEraser()).toEqual({ autoReturn: true });
    store.dispose();
    second.dispose();
  });

  it('stores the straight-line flag per drawing tool', () => {
    const store = new InkPresetStore();
    expect(store.getTool('highlighter')).toEqual({});
    store.setTool('highlighter', { straight: true });
    expect(store.getTool('highlighter')).toEqual({ straight: true });
    store.setTool('highlighter', { straight: false });
    expect(store.getTool('highlighter')).toEqual({ straight: false });
    store.dispose();
  });

  it('tracks recent colors most-recent-first without duplicates', () => {
    const settings = new InMemorySettingsService();
    const store = new InkPresetStore({ settings });
    expect(store.getRecentColors()).toEqual([]);
    store.pushRecentColor('#111111');
    store.pushRecentColor('#222222');
    store.pushRecentColor('#111111');
    expect(store.getRecentColors()).toEqual(['#111111', '#222222']);
    expect(settings.get('ink.recent.colors')).toBe('["#111111","#222222"]');
    // Blank input never pollutes the list.
    store.pushRecentColor('   ');
    expect(store.getRecentColors()).toHaveLength(2);
    // Corrupt payloads read back empty.
    settings.set('ink.recent.colors', 'not-json{{{');
    expect(store.getRecentColors()).toEqual([]);
    store.dispose();
  });

  it('caps the recent list and shares it across stores', () => {
    const settings = new InMemorySettingsService();
    const store = new InkPresetStore({ settings });
    for (let i = 0; i < 12; i++) {
      store.pushRecentColor(`#c${i}`);
    }
    const recent = store.getRecentColors();
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe('#c11');
    const second = new InkPresetStore({ settings });
    expect(second.getRecentColors()).toEqual(recent);
    store.dispose();
    second.dispose();
  });
});

describe('eraser mode normalization', () => {
  it('maps every stored mode to its active eraser tool', () => {
    expect(normalizeEraserMode('stroke')).toBe('stroke');
    expect(normalizeEraserMode('precision')).toBe('precision');
    expect(eraserSemanticRoleForPreset({ mode: 'stroke' })).toBe(
      'surface.erase.stroke',
    );
    expect(eraserSemanticRoleForPreset({ mode: 'precision' })).toBe(
      'surface.erase.precision',
    );
    // Absent presets read as the default Stroke tool.
    expect(eraserSemanticRoleForPreset(undefined)).toBe('surface.erase.stroke');
    expect(eraserSemanticRoleForPreset({})).toBe('surface.erase.stroke');
  });

  it('degrades corrupt or absent stored modes to the default without throwing', () => {
    expect(DEFAULT_ERASER_MODE).toBe('stroke');
    for (const corrupt of [
      undefined,
      null,
      42,
      true,
      {},
      [],
      '',
      'vaporize',
      'STROKE',
    ]) {
      expect(isEraserMode(corrupt)).toBe(false);
      expect(normalizeEraserMode(corrupt)).toBe('stroke');
      expect(eraserSemanticRoleForPreset({ mode: corrupt as never })).toBe(
        'surface.erase.stroke',
      );
    }
  });

  it('keeps the mode↔role maps inverse of each other', () => {
    expect(ERASER_SEMANTIC_ROLE_BY_MODE).toEqual({
      stroke: 'surface.erase.stroke',
      precision: 'surface.erase.precision',
    });
    for (const [mode, role] of Object.entries(ERASER_SEMANTIC_ROLE_BY_MODE)) {
      expect(ERASER_MODE_BY_SEMANTIC_ROLE[role]).toBe(mode);
    }
    expect(ERASER_MODE_BY_SEMANTIC_ROLE['surface.erase']).toBeUndefined();
  });

  it('preserves radius/filter when normalizing the mode', () => {
    const store = new InkPresetStore();
    store.restore({
      pen: {},
      fountain: {},
      brush: {},
      pencil: {},
      highlighter: {},
      eraser: { radius: 18, mode: 'precision', filter: 'ink' },
      lasso: {},
    });
    expect(store.getEraser()).toEqual({
      radius: 18,
      mode: 'precision',
      filter: 'ink',
    });
    expect(eraserSemanticRoleForPreset(store.getEraser())).toBe(
      'surface.erase.precision',
    );
    const exported = store.exportPreferences();
    const restored = new InkPresetStore();
    expect(restored.importPreferences(exported)).toBe(true);
    expect(restored.getEraser()).toEqual({
      radius: 18,
      mode: 'precision',
      filter: 'ink',
    });
    // Corrupt stored modes still load the radius/filter around them.
    const settings = new InMemorySettingsService();
    settings.set('ink.preset.eraser.mode', 'vaporize');
    settings.set('ink.preset.eraser.radius', 14);
    const tolerant = new InkPresetStore({ settings });
    expect(tolerant.getEraser()).toEqual({ radius: 14 });
    expect(eraserSemanticRoleForPreset(tolerant.getEraser())).toBe(
      'surface.erase.stroke',
    );
    store.dispose();
    restored.dispose();
    tolerant.dispose();
  });
});

describe('slot families', () => {
  it('shares one slot set across the pen family; highlighter stands alone', () => {
    expect([...INK_PEN_FAMILY_TOOLS].sort()).toEqual(
      ['brush', 'fountain', 'pen', 'pencil'].sort(),
    );
    for (const tool of INK_PEN_FAMILY_TOOLS) {
      expect(inkSlotFamilyForTool(tool)).toBe('pen');
    }
    expect(inkSlotFamilyForTool('highlighter')).toBe('highlighter');
  });

  it('shares live color/size across the pen family; highlighter stands alone', () => {
    // Slot sets and live color/size are family-scoped — editing any
    // pen sibling moves the whole family — while the highlighter pair
    // and every tool's advanced tuning stay untouched.
    const store = new InkPresetStore();
    store.setTool('pen', { color: '#111111', size: 2 });
    store.setTool('fountain', { color: '#222222', size: 3 });
    store.setTool('highlighter', { color: '#ffd54f', size: 14 });
    // Last family write wins for every sibling (fountain's pair here).
    for (const tool of ['pen', 'fountain', 'brush', 'pencil'] as const) {
      expect(store.getTool(tool)).toMatchObject({
        color: '#222222',
        size: 3,
      });
    }
    expect(store.getTool('highlighter')).toMatchObject({
      color: '#ffd54f',
      size: 14,
    });
    store.setTool('pen', { size: 6 });
    for (const tool of ['pen', 'fountain', 'brush', 'pencil'] as const) {
      expect(store.getTool(tool)).toMatchObject({
        color: '#222222',
        size: 6,
      });
    }
    expect(store.getTool('highlighter')).toMatchObject({
      color: '#ffd54f',
      size: 14,
    });
    store.dispose();
  });

  it('converges divergent restore snapshots pen-first, then replaces', () => {
    const store = new InkPresetStore();
    store.setTool('pencil', { color: '#999999', size: 9 });
    store.restore({
      pen: { color: '#000000' },
      fountain: { color: '#222222', size: 3 },
      brush: {},
      pencil: { color: '#888888', size: 8 },
      highlighter: { color: '#ffd54f', size: 14 },
      eraser: {},
      lasso: {},
    });
    // Pen-first convergence per field: pen's color, fountain's size.
    for (const tool of ['pen', 'fountain', 'brush', 'pencil'] as const) {
      expect(store.getTool(tool)).toEqual({ color: '#000000', size: 3 });
    }
    expect(store.getTool('highlighter')).toEqual({
      color: '#ffd54f',
      size: 14,
    });
    // The pre-restore pencil pair is gone (replace, never merge)…
    const snapshot = store.snapshot();
    expect(snapshot.pencil).toEqual({ color: '#000000', size: 3 });
    // …and an empty restore clears the family's pair.
    store.restore({
      pen: {},
      fountain: {},
      brush: {},
      pencil: {},
      highlighter: {},
      eraser: {},
      lasso: {},
    });
    for (const tool of ['pen', 'fountain', 'brush', 'pencil'] as const) {
      expect(store.getTool(tool)).toEqual({});
    }
    store.dispose();
  });

  it('shares the family pair across stores and reloads', () => {
    const settings = new InMemorySettingsService();
    const first = new InkPresetStore({ settings });
    first.setTool('fountain', { color: '#123456', size: 6 });
    first.setTool('highlighter', { color: '#ffd54f', size: 14 });
    const second = new InkPresetStore({ settings });
    for (const tool of ['pen', 'fountain', 'brush', 'pencil'] as const) {
      expect(second.getTool(tool)).toEqual({ color: '#123456', size: 6 });
    }
    expect(second.getTool('highlighter')).toEqual({
      color: '#ffd54f',
      size: 14,
    });
    // A family edit from the second surface reaches the first.
    second.setTool('pencil', { size: 2 });
    expect(first.getTool('pen').size).toBe(2);
    expect(first.getTool('highlighter').size).toBe(14);
    first.dispose();
    second.dispose();
  });
});
