/**
 * Core notebook templates.
 * §3: template ids compile to plain-data background draw items rendered
 * beneath page objects. Presentation derived from canonical ids only —
 * never stored as objects; unknown values render blank.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTEBOOK_TEMPLATE,
  NOTEBOOK_TEMPLATES,
  isCoreNotebookTemplate,
  templateBackgroundDrawItems,
} from './templates.js';

describe('core template catalog', () => {
  it('ships the five core templates including Cornell', () => {
    expect(NOTEBOOK_TEMPLATES).toEqual([
      'froglight.blank',
      'froglight.lined',
      'froglight.grid',
      'froglight.dots',
      'froglight.cornell',
    ]);
    expect(DEFAULT_NOTEBOOK_TEMPLATE).toBe('froglight.blank');
    expect(isCoreNotebookTemplate('froglight.grid')).toBe(true);
    expect(isCoreNotebookTemplate('froglight.cornell')).toBe(true);
    expect(isCoreNotebookTemplate('acme.music')).toBe(false);
    expect(isCoreNotebookTemplate(undefined)).toBe(false);
  });
});

describe('template background draw items', () => {
  it('renders nothing for blank or absent templates', () => {
    expect(templateBackgroundDrawItems(undefined, 1240, 1754)).toEqual([]);
    expect(templateBackgroundDrawItems('froglight.blank', 1240, 1754)).toEqual([]);
  });

  it('renders nothing for unknown template ids instead of inventing content', () => {
    expect(templateBackgroundDrawItems('acme.music', 800, 600)).toEqual([]);
  });

  it('compiles ruled lines spanning the full page width at a regular gap', () => {
    const width = 400;
    const height = 220;
    const items = templateBackgroundDrawItems('froglight.lined', width, height);
    expect(items.length).toBeGreaterThan(3);
    for (const item of items) {
      if (item.kind !== 'line') throw new Error(`unexpected item kind ${item.kind}`);
      expect(item.bounds.x).toBe(0);
      expect(item.bounds.width).toBe(width);
      expect(item.y).toBe(item.y2);
      expect(item.y).toBeLessThanOrEqual(height);
    }
    // Regular vertical spacing between consecutive rules.
    const ys = items.map((item) => ('y' in item ? item.y : 0));
    const gap = ys[1]! - ys[0]!;
    expect(gap).toBeGreaterThan(0);
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]! - ys[i - 1]!).toBeCloseTo(gap, 6);
    }
  });

  it('compiles grid rules in both axes covering the page extent', () => {
    const items = templateBackgroundDrawItems('froglight.grid', 200, 100);
    const horizontal = items.filter((item) => item.kind === 'line' && item.y === item.y2);
    const vertical = items.filter((item) => item.kind === 'line' && item.x === item.x2);
    expect(horizontal.length).toBeGreaterThan(1);
    expect(vertical.length).toBeGreaterThan(1);
    expect(horizontal[0]!.bounds.width).toBe(200);
    expect(vertical[0]!.bounds.height).toBe(100);
  });

  it('compiles dot grids as small filled marks on a regular lattice', () => {
    const items = templateBackgroundDrawItems('froglight.dots', 120, 120);
    expect(items.length).toBeGreaterThan(8);
    for (const item of items) {
      // Dots are tiny closed shapes, not strokes.
      expect(['ellipse', 'rect']).toContain(item.kind);
      expect(Math.max(item.bounds.width, item.bounds.height)).toBeLessThan(4);
    }
  });

  it('compiles Cornell paper with rules plus cue and summary guides', () => {
    const width = 400;
    const height = 500;
    const items = templateBackgroundDrawItems('froglight.cornell', width, height);
    const lines = items.filter((item) => item.kind === 'line');
    expect(lines.length).toBeGreaterThan(4);
    // Cue column near one third of the width, summary near four fifths down.
    const vertical = lines.filter(
      (item) => item.kind === 'line' && item.x === item.x2,
    );
    const horizontal = lines.filter(
      (item) => item.kind === 'line' && item.y === item.y2,
    );
    expect(vertical.length).toBe(1);
    expect(vertical[0]!.x).toBeCloseTo(width * 0.32, 6);
    const summary = horizontal[horizontal.length - 1]!;
    expect(summary.kind === 'line' && summary.y).toBeCloseTo(height * 0.78, 6);
    // Rules above the summary stay regularly spaced.
    const rules = horizontal.slice(0, -1).map((item) => (item.kind === 'line' ? item.y : 0));
    const gap = rules[1]! - rules[0]!;
    expect(gap).toBeGreaterThan(0);
    for (let i = 1; i < rules.length; i += 1) {
      expect(rules[i]! - rules[i - 1]!).toBeCloseTo(gap, 6);
    }
    for (const y of rules) expect(y).toBeLessThan(height * 0.78);
  });

  it('honors a custom spacing override for ruled paper', () => {
    const def = templateBackgroundDrawItems('froglight.lined', 400, 220);
    const wide = templateBackgroundDrawItems('froglight.lined', 400, 220, {
      spacing: 110,
    });
    expect(wide.length).toBeGreaterThan(0);
    expect(wide.length).toBeLessThan(def.length);
    const ys = wide
      .filter((item) => item.kind === 'line')
      .map((item) => (item.kind === 'line' ? item.y : 0));
    expect(ys[1]! - ys[0]!).toBeCloseTo(110, 6);
  });

  it('prepends a full-page fill for tinted paper without touching rules', () => {
    const items = templateBackgroundDrawItems('froglight.lined', 400, 220, {
      paperColor: '#faf7ef',
    });
    expect(items[0]).toMatchObject({
      kind: 'rect',
      bounds: { x: 0, y: 0, width: 400, height: 220 },
      fill: '#faf7ef',
    });
    expect(items.slice(1).every((item) => item.kind === 'line')).toBe(true);
  });

  it('emits only the fill for tinted blank paper', () => {
    const items = templateBackgroundDrawItems('froglight.blank', 400, 220, {
      paperColor: '#faf7ef',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'rect', fill: '#faf7ef' });
  });
});
