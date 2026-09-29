/**
 * Notebook surface-text selection derivation.
 *
 * Pure unit coverage for `deriveSurfaceTextSelectionState`: style
 * mapping (Body/H1/H2/H3 via role + effective size), unanimous font size,
 * additive bold/italic trait reads, effective align, unanimous text color,
 * wrap detection, mixed aggregation, group expansion, and dormant no-text
 * states. Fixtures use the canonical `textObject` constructor — no engine,
 * no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  textObject,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '@froglight/foundation';
import { deriveSurfaceTextSelectionState } from './text-selection.js';

function surfaceWith(
  records: readonly SurfaceObjectRecord[],
): Pick<SurfaceModel, 'order' | 'objects'> {
  const surface = emptySurface(boundedFrame(800, 600));
  for (const record of records) {
    surface.objects[record.id] = record;
    surface.order.push(record.id);
  }
  return surface;
}

const body = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    ...textObject(id, { x: 0, y: 0, text: 'body' }),
    ...extra,
  }) as SurfaceObjectRecord;

describe('deriveSurfaceTextSelectionState', () => {
  it('is dormant without a surface, ids, or text', () => {
    expect(deriveSurfaceTextSelectionState(null, ['t1'])).toMatchObject({
      hasText: false,
    });
    const surface = surfaceWith([body('t1')]);
    expect(deriveSurfaceTextSelectionState(surface, [])).toMatchObject({
      hasText: false,
    });
    // Unknown ids and non-text records stay dormant.
    const stroke = {
      id: 's1',
      type: 'froglight.ink.stroke',
      points: [],
    } as unknown as SurfaceObjectRecord;
    const mixed = surfaceWith([body('t1'), stroke]);
    expect(
      deriveSurfaceTextSelectionState(mixed, ['s1', 'missing']),
    ).toMatchObject({ hasText: false });
  });

  it('reads Body for body roles at any size', () => {
    const surface = surfaceWith([body('t1', { size: 48 })]);
    expect(deriveSurfaceTextSelectionState(surface, ['t1'])).toMatchObject({
      hasText: true,
      style: 'body',
      align: 'start',
      bold: { active: false, mixed: false },
      italic: { active: false, mixed: false },
      wrap: { active: false, mixed: false },
    });
  });

  it('reads H1/H2/H3 from heading roles via the size split', () => {
    const h1 = surfaceWith([
      body('a', { role: 'heading', size: 24 }),
      body('b', { role: 'heading', appearance: { size: 30 } }),
    ]);
    expect(deriveSurfaceTextSelectionState(h1, ['a'])).toMatchObject({
      style: 'h1',
      size: 24,
    });
    // appearance.size wins over the record size (preview).
    expect(deriveSurfaceTextSelectionState(h1, ['b'])).toMatchObject({
      style: 'h1',
      size: 30,
    });
    const h2 = surfaceWith([
      body('c', { role: 'heading', size: 20 }),
      body('e', { role: 'heading', size: 18 }),
      body('d', { role: 'heading' }),
    ]);
    expect(deriveSurfaceTextSelectionState(h2, ['c'])).toMatchObject({
      style: 'h2',
      size: 20,
    });
    expect(deriveSurfaceTextSelectionState(h2, ['e'])).toMatchObject({
      style: 'h3',
      size: 18,
    });
    // Default size 16 reads as H3, never H1/H2.
    expect(deriveSurfaceTextSelectionState(h2, ['d'])).toMatchObject({
      style: 'h3',
      size: 16,
    });
  });

  it('reads unanimous size and color with mixed aggregation', () => {
    const surface = surfaceWith([
      body('t1', { size: 24, color: '#c4554d' }),
      body('t2', { size: 24, color: '#c4554d' }),
    ]);
    expect(deriveSurfaceTextSelectionState(surface, ['t1', 't2'])).toMatchObject(
      { hasText: true, size: 24, color: '#c4554d' },
    );
    const mixed = surfaceWith([
      body('u1', { size: 24, color: '#c4554d' }),
      body('u2', { size: 18, color: '#7c6cf0' }),
    ]);
    expect(deriveSurfaceTextSelectionState(mixed, ['u1', 'u2'])).toMatchObject(
      { hasText: true, size: 'mixed', color: 'mixed' },
    );
    // Absent color reads the default; absent size reads 16.
    const bare = surfaceWith([body('v1')]);
    expect(deriveSurfaceTextSelectionState(bare, ['v1'])).toMatchObject({
      hasText: true,
      size: 16,
      color: '#37352f',
    });
  });

  it('aggregates mixed styles honestly', () => {
    const surface = surfaceWith([
      body('t1'),
      body('t2', { role: 'heading', size: 24 }),
    ]);
    expect(
      deriveSurfaceTextSelectionState(surface, ['t1', 't2']),
    ).toMatchObject({ hasText: true, style: 'mixed' });
  });

  it('reads additive bold/italic traits with mixed aggregation', () => {
    const surface = surfaceWith([
      body('t1', { appearance: { bold: true } }),
      body('t2', { appearance: { bold: true, italic: true } }),
    ]);
    expect(deriveSurfaceTextSelectionState(surface, ['t1', 't2'])).toMatchObject(
      {
        bold: { active: true, mixed: false },
        italic: { active: false, mixed: true },
      },
    );
    // Non-boolean trait members read inactive, never throw.
    const loose = surfaceWith([
      body('t3', { appearance: { bold: 'yes' } }),
    ]);
    expect(deriveSurfaceTextSelectionState(loose, ['t3'])).toMatchObject({
      bold: { active: false, mixed: false },
    });
  });

  it('reads effective align and wrap with mixed aggregation', () => {
    const surface = surfaceWith([
      body('t1', { appearance: { align: 'center', wrapWidth: 120 } }),
      body('t2', { appearance: { align: 'end' } }),
    ]);
    expect(deriveSurfaceTextSelectionState(surface, ['t1', 't2'])).toMatchObject(
      {
        align: 'mixed',
        wrap: { active: false, mixed: true },
      },
    );
    expect(deriveSurfaceTextSelectionState(surface, ['t1'])).toMatchObject({
      align: 'center',
      wrap: { active: true, mixed: false },
    });
    // Unknown aligns degrade to start (rendering-honest), invalid wrap to off.
    const degraded = surfaceWith([
      body('t4', { appearance: { align: 'justify', wrapWidth: -5 } }),
    ]);
    expect(deriveSurfaceTextSelectionState(degraded, ['t4'])).toMatchObject({
      align: 'start',
      wrap: { active: false, mixed: false },
    });
  });

  it('expands group selections to members', () => {
    const surface = surfaceWith([body('t1', { role: 'heading', size: 24 })]);
    const group = {
      id: 'g1',
      type: 'froglight.group',
      children: ['t1'],
    } as unknown as SurfaceObjectRecord;
    surface.objects[group.id] = group;
    surface.order.push(group.id);
    expect(deriveSurfaceTextSelectionState(surface, ['g1'])).toMatchObject({
      hasText: true,
      style: 'h1',
    });
  });

  it('ignores non-text members when text is present', () => {
    const stroke = {
      id: 's1',
      type: 'froglight.ink.stroke',
      points: [],
    } as unknown as SurfaceObjectRecord;
    const surface = surfaceWith([
      body('t1', { appearance: { bold: true } }),
      stroke,
    ]);
    expect(
      deriveSurfaceTextSelectionState(surface, ['t1', 's1']),
    ).toMatchObject({
      hasText: true,
      style: 'body',
      bold: { active: true, mixed: false },
    });
  });
});
