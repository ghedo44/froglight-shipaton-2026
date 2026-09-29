/**
 * Canvas backend Surface text: role/align/wrapWidth plain-data.
 * Headless recording-context assertions only — the backend branches on
 * draw items, never on payloads; unknown roles compile to body upstream
 * (see `text-format.spec.ts`) and defensively render as body here.
 */

import { describe, expect, it } from 'vitest';
import type { TextItem } from '@froglight/foundation';
import {
  effectiveTextSizeOf,
  textV2Lines,
  textWrapWidthOf,
} from '@froglight/foundation';
import { CanvasSurfaceRendererBackend } from './canvas-backend.js';

function recordingCtx(): {
  ctx: CanvasRenderingContext2D;
  log: Array<[string, ...unknown[]]>;
} {
  const log: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void log.push([name, ...args]);
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    rect: record('rect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    ellipse: record('ellipse'),
    translate: record('translate'),
    rotate: record('rotate'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
    clearRect: record('clearRect'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
  } as unknown as CanvasRenderingContext2D;
  for (const prop of [
    'fillStyle',
    'strokeStyle',
    'font',
    'lineWidth',
    'lineCap',
    'lineJoin',
    'globalAlpha',
    'textAlign',
  ] as const) {
    let value: unknown = '';
    Object.defineProperty(ctx, prop, {
      get: () => value,
      set: (next: unknown) => {
        value = next;
        log.push([`set:${prop}`, next]);
      },
    });
  }
  return { ctx, log };
}

function textItem(overrides: Partial<TextItem> & { text: string }): TextItem {
  return {
    kind: 'text',
    objectId: 't1',
    bounds: { x: 10, y: 20, width: 100, height: 20 },
    rotation: 0,
    size: 16,
    ...overrides,
  };
}

const fillTexts = (log: Array<[string, ...unknown[]]>) =>
  log.filter(([name]) => name === 'fillText');

describe('canvas backend Surface text', () => {
  it('fills the available line using the actual font width', () => {
    const { ctx, log } = recordingCtx();
    ctx.measureText = (text) => ({ width: text.length * 4 }) as TextMetrics;
    new CanvasSurfaceRendererBackend(ctx).draw(
      textItem({ text: 'thin iii iii', size: 41, wrapWidth: 100 }),
    );
    expect(fillTexts(log).map((entry) => entry[1])).toEqual(['thin iii iii']);
  });

  it('splits wide words by measured width without overflowing the box', () => {
    const { ctx, log } = recordingCtx();
    ctx.measureText = (text) => ({ width: text.length * 20 }) as TextMetrics;
    new CanvasSurfaceRendererBackend(ctx).draw(
      textItem({ text: 'WWWWWW', size: 16, wrapWidth: 50 }),
    );
    expect(fillTexts(log).map((entry) => entry[1])).toEqual(['WW', 'WW', 'WW']);
  });

  it('draws single-line body/start at (x, y + size) with normal font', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    backend.draw(textItem({ text: 'hi', role: 'body', align: 'start' }));
    const draws = fillTexts(log);
    expect(draws).toHaveLength(1);
    expect(draws[0]).toEqual(['fillText', 'hi', 10, 36]);
    expect(log).toContainEqual(['set:font', '16px sans-serif']);
    expect(log).toContainEqual(['set:textAlign', 'left']);
  });

  it('renders heading bold and unknown roles as body without payload knowledge', () => {
    const heading = recordingCtx();
    new CanvasSurfaceRendererBackend(heading.ctx).draw(
      textItem({ text: 'Chapter', role: 'heading' }),
    );
    expect(heading.log).toContainEqual(['set:font', 'bold 16px sans-serif']);

    const unknown = recordingCtx();
    new CanvasSurfaceRendererBackend(unknown.ctx).draw(
      textItem({ text: 'future', role: 'pull-quote' as never }),
    );
    expect(unknown.log).toContainEqual(['set:font', '16px sans-serif']);
    // Unknown align falls back to start.
    const badAlign = recordingCtx();
    new CanvasSurfaceRendererBackend(badAlign.ctx).draw(
      textItem({ text: 'hi', align: 'justify' as never }),
    );
    expect(badAlign.log).toContainEqual(['set:textAlign', 'left']);
  });

  it('renders additive bold/italic traits inside the envelope', () => {
    const bold = recordingCtx();
    new CanvasSurfaceRendererBackend(bold.ctx).draw(
      textItem({ text: 'hi', role: 'body', bold: true }),
    );
    expect(bold.log).toContainEqual(['set:font', 'bold 16px sans-serif']);

    const italic = recordingCtx();
    new CanvasSurfaceRendererBackend(italic.ctx).draw(
      textItem({ text: 'hi', role: 'body', italic: true }),
    );
    expect(italic.log).toContainEqual(['set:font', 'italic 16px sans-serif']);

    const both = recordingCtx();
    new CanvasSurfaceRendererBackend(both.ctx).draw(
      textItem({ text: 'hi', role: 'body', bold: true, italic: true }),
    );
    expect(both.log).toContainEqual([
      'set:font',
      'italic bold 16px sans-serif',
    ]);

    // Heading + italic composes (weight from role, style from trait).
    const headingItalic = recordingCtx();
    new CanvasSurfaceRendererBackend(headingItalic.ctx).draw(
      textItem({ text: 'hi', role: 'heading', italic: true }),
    );
    expect(headingItalic.log).toContainEqual([
      'set:font',
      'italic bold 16px sans-serif',
    ]);
  });

  it('positions center/end lines inside [x, x + boxWidth] (align-invariant envelope)', () => {
    const center = recordingCtx();
    new CanvasSurfaceRendererBackend(center.ctx).draw(
      textItem({
        text: 'hi',
        align: 'center',
        bounds: { x: 10, y: 20, width: 100, height: 20 },
      }),
    );
    expect(fillTexts(center.log)[0]).toEqual(['fillText', 'hi', 60, 36]);
    expect(center.log).toContainEqual(['set:textAlign', 'center']);

    const end = recordingCtx();
    new CanvasSurfaceRendererBackend(end.ctx).draw(
      textItem({
        text: 'hi',
        align: 'end',
        bounds: { x: 10, y: 20, width: 100, height: 20 },
      }),
    );
    expect(fillTexts(end.log)[0]).toEqual(['fillText', 'hi', 110, 36]);
    expect(end.log).toContainEqual(['set:textAlign', 'right']);
  });

  it('wraps on explicit and soft breaks with 1.25x line spacing', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    // "a bb ccc" with tiny wrapWidth forces multiple lines (maxChars=1).
    backend.draw(
      textItem({
        text: 'a\nbb ccc',
        bounds: { x: 0, y: 0, width: 9.6, height: 80 },
        size: 16,
        wrapWidth: 9.6,
      }),
    );
    const draws = fillTexts(log);
    // Explicit break (2 lines) + wrapped second line (>1 sub-line).
    expect(draws.length).toBeGreaterThan(2);
    // First baseline at y + size, each next +1.25*size.
    expect(draws[0]![3]).toBeCloseTo(16, 9);
    expect(draws[1]![3]).toBeCloseTo(16 + 20, 9);
    expect(draws[2]![3]).toBeCloseTo(16 + 40, 9);
  });

  it('rotates around the envelope center (Surface text pivot)', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    backend.draw(
      textItem({
        text: 'hi',
        bounds: { x: 0, y: 0, width: 100, height: 40 },
        rotation: Math.PI / 2,
      }),
    );
    // Center (50, 20): translate(center), rotate, draw at (x-center).
    expect(log).toContainEqual(['translate', 50, 20]);
    expect(log).toContainEqual(['rotate', Math.PI / 2]);
    const draws = fillTexts(log);
    expect(draws).toHaveLength(1);
    // baseX (10? here 0) minus center.x, baseline minus center.y.
    expect(draws[0]![2]).toBeCloseTo(0 - 50, 9);
    expect(draws[0]![3]).toBeCloseTo(16 - 20, 9);
  });
});

describe('canvas backend / geometry layout contract', () => {
  function laidTextsFor(item: TextItem): string[] {
    const { ctx, log } = recordingCtx();
    new CanvasSurfaceRendererBackend(ctx).draw(item);
    return fillTexts(log).map(([, text]) => text as string);
  }

  function expectedLaidLines(
    text: string,
    size: unknown,
    wrapWidth: unknown,
  ): string[] {
    const effectiveSize = effectiveTextSizeOf({ size });
    const effectiveWrap = textWrapWidthOf({
      appearance: { wrapWidth },
    });
    return textV2Lines(text, effectiveSize, effectiveWrap);
  }

  it('backend laid lines identical to geometry.textV2Lines (CRLF, empty, long-word, narrow)', () => {
    const fixtures: Array<{
      name: string;
      text: string;
      size: number;
      wrapWidth?: number;
    }> = [
      { name: 'crlf', text: 'a\r\nb\nc', size: 16, wrapWidth: 10000 },
      { name: 'crlf-unbounded', text: 'a\r\nb\rc\nd', size: 16 },
      { name: 'empty-unbounded', text: '', size: 16 },
      { name: 'empty-wrapped', text: '', size: 16, wrapWidth: 50 },
      {
        name: 'long-word-char-split',
        text: 'supercalifragilisticexpialidocious',
        size: 16,
        wrapWidth: 9.6,
      },
      {
        name: 'narrow-greedy',
        text: 'hello world foo bar',
        size: 16,
        wrapWidth: 50,
      },
      {
        name: 'explicit-plus-soft',
        text: 'a\nbb ccc',
        size: 16,
        wrapWidth: 9.6,
      },
    ];
    for (const fixture of fixtures) {
      const item = textItem({
        text: fixture.text,
        size: fixture.size,
        ...(fixture.wrapWidth !== undefined
          ? { wrapWidth: fixture.wrapWidth }
          : {}),
      });
      const expected = expectedLaidLines(
        fixture.text,
        fixture.size,
        fixture.wrapWidth,
      );
      expect(laidTextsFor(item), `fixture ${fixture.name}`).toEqual(expected);
    }
  });

  it('invalid wrapWidth degrades to explicit breaks only (parity with textWrapWidthOf)', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const item = textItem({
        text: 'a\nb c',
        size: 16,
        wrapWidth: bad as number,
      });
      const expected = expectedLaidLines('a\nb c', 16, bad);
      expect(laidTextsFor(item), `wrapWidth ${String(bad)}`).toEqual(expected);
      // Explicit breaks only: no soft wrapping.
      expect(expected).toEqual(['a', 'b c']);
    }
  });
});
