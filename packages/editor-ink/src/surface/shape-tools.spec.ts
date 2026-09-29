/**
 * Provider-owned shape tool construction.
 *
 * Rectangle/ellipse/line/text tool construction lives here instead of
 * interleaved with surface lifecycle. Tool registration remains
 * provider-local and uses the existing SurfaceToolRegistry contract.
 */

import { describe, expect, it } from 'vitest';
import type { PenStyleRef, SurfaceTool } from '@froglight/foundation';
import {
  boxPreview,
  createInkShapeTools,
  SHAPE_WIDTH_FALLBACK,
} from './shape-tools.js';

function penStyle(): PenStyleRef {
  return { color: '#37352f', width: 2 };
}

describe('boxPreview', () => {
  it('pads the envelope by half the stroke width', () => {
    const preview = boxPreview(
      'rect',
      '@shape',
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      penStyle(),
    );
    expect(preview.kind).toBe('rect');
    expect(preview.objectId).toBe('@shape');
    // pad = 2 → envelope x = 0 - 1, width = 10 + 2
    expect(preview.bounds.x).toBe(-1);
    expect(preview.bounds.width).toBe(12);
  });

  it('falls back to a default width when the style omits it', () => {
    const preview = boxPreview(
      'ellipse',
      '@shape',
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      {},
    );
    expect(preview.bounds.width).toBe(4 + SHAPE_WIDTH_FALLBACK);
  });
});

describe('createInkShapeTools', () => {
  function drive(
    tool: SurfaceTool,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) {
    const added: Array<{ id: string; type: string; [k: string]: unknown }> = [];
    let preview: readonly unknown[] = [];
    const ctx = {
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      newObjectId: () => 'new-id',
      addObject: (record: {
        id: string;
        type: string;
        [k: string]: unknown;
      }) => {
        added.push(record);
      },
      setPreview: (items: readonly unknown[]) => {
        preview = items;
      },
    };
    tool.onDown?.(ctx as never, { point: a } as never);
    tool.onMove?.(ctx as never, { point: b } as never);
    expect(preview.length).toBe(1);
    tool.onUp?.(ctx as never, { point: b } as never);
    return added;
  }

  it('creates rect/ellipse/line tools plus a text placeholder entry', () => {
    const tools = createInkShapeTools(penStyle());
    expect(tools.map((t) => t.toolId)).toEqual([
      'froglight.ink.rect',
      'froglight.ink.ellipse',
      'froglight.ink.line',
      'froglight.ink.text',
      'froglight.ink.triangle',
      'froglight.ink.diamond',
    ]);
  });

  it.each(['triangle', 'diamond'] as const)(
    'creates an unfilled %s with the chosen stroke',
    (shape) => {
      const tool = createInkShapeTools(penStyle(), {
        shapeAppearance: () => 'outline',
        cornerRadius: () => 14,
      }).find((tool) => tool.toolId === `froglight.ink.${shape}`)!;
      const [record] = drive(tool, { x: 10, y: 10 }, { x: 60, y: 40 });
      expect(record).toMatchObject({
        type: 'froglight.rectangle',
        cornerRadius: 14,
        shape,
        stroke: '#37352f',
        strokeWidth: 2,
      });
      expect(record!.fill).toBeUndefined();
    },
  );

  it('commits a rectangle from a drag', () => {
    const [rect] = createInkShapeTools(penStyle());
    const added = drive(rect!, { x: 10, y: 10 }, { x: 60, y: 40 });
    expect(added[0]!.type).toBe('froglight.rectangle');
    expect(added[0]!.width).toBe(50);
    expect(added[0]!.height).toBe(30);
  });

  it.each([
    ['none', undefined],
    ['start', 'start'],
    ['end', 'end'],
    ['both', 'both'],
  ] as const)(
    'uses %s arrow setting for preview and commit',
    (arrows, expected) => {
      const line = createInkShapeTools(penStyle(), {
        lineArrows: () => arrows,
      })[2]!;
      const added = drive(line, { x: 10, y: 10 }, { x: 60, y: 40 });
      expect(added[0]!.arrows).toBe(expected);
    },
  );

  it('commits a small default object on tap (Paint behavior)', () => {
    const [rect] = createInkShapeTools(penStyle());
    const added = drive(rect!, { x: 10, y: 10 }, { x: 11, y: 10 });
    // tapped → target = anchor + (40, 24)
    expect(added[0]!.width).toBe(40);
    expect(added[0]!.height).toBe(24);
  });

  it('cancel after down/move commits nothing and clears preview', () => {
    const [rect] = createInkShapeTools(penStyle());
    const added: Array<{ id: string }> = [];
    let preview: readonly unknown[] = ['stale'];
    const ctx = {
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      newObjectId: () => 'new-id',
      addObject: (record: { id: string }) => {
        added.push(record);
      },
      setPreview: (items: readonly unknown[]) => {
        preview = items;
      },
    };
    rect!.onDown?.(ctx as never, { point: { x: 10, y: 10 } } as never);
    rect!.onMove?.(ctx as never, { point: { x: 60, y: 40 } } as never);
    rect!.onCancel?.(ctx as never);
    expect(added).toEqual([]);
    expect(preview).toEqual([]);
  });
});
