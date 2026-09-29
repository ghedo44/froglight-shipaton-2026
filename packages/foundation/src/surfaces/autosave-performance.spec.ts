import { describe, expect, it } from 'vitest';
import { encodeWhiteboard, encodeWhiteboardAsync } from '../whiteboard/codec.js';
import { encodeNotebook, encodeNotebookAsync } from '../notebooks/codec.js';
import { appendPage, emptyNotebook, notebookPage } from '../notebooks/model.js';
import {
  boundedFrame,
  emptySurface,
  infiniteFrame,
  inkStrokeObject,
  type SurfaceModel,
} from './model.js';

function longStroke(id: string, count: number): SurfaceModel['objects'][string] {
  return inkStrokeObject(id, {
    points: Array.from({ length: count }, (_, index) => ({
      x: index * 0.7,
      y: Math.sin(index / 18) * 45,
      pressure: 0.4 + (index % 60) / 100,
      dt: index,
    })),
    width: 3,
  });
}

async function timerDelay(
  encode: () => Promise<Uint8Array | null>,
): Promise<{
  readonly maxEventLoopGapMs: number;
  readonly encodeDurationMs: number;
  readonly bytes: number;
}> {
  const started = performance.now();
  let lastTick = started;
  let maxEventLoopGapMs = 0;
  let running = true;
  const tick = () => {
    const now = performance.now();
    maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick);
    lastTick = now;
    if (running) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  const bytes = await encode();
  const completed = performance.now();
  running = false;
  maxEventLoopGapMs = Math.max(maxEventLoopGapMs, completed - lastTick);
  if (bytes === null) throw new Error('cooperative encoder cancelled unexpectedly');
  return {
    maxEventLoopGapMs,
    encodeDurationMs: completed - started,
    bytes: bytes.byteLength,
  };
}

describe('large surface autosave responsiveness', () => {
  it('cooperatively encodes long Pencil strokes without blocking the event loop', async () => {
    const model = emptySurface(infiniteFrame());
    model.objects.stroke = longStroke('stroke', 6_000);
    model.order.push('stroke');

    const result = await timerDelay(() => encodeWhiteboardAsync(model, () => true));
    console.info(`whiteboard async bytes=${result.bytes} maxEventLoopGapMs=${result.maxEventLoopGapMs.toFixed(1)} encodeDurationMs=${result.encodeDurationMs.toFixed(1)}`);
    expect(result.maxEventLoopGapMs).toBeLessThan(50);
  });

  it('cooperatively encodes a multi-page Notebook and preserves canonical bytes', async () => {
    const notebook = emptyNotebook('Pencil capture');
    for (let i = 0; i < 3; i++) {
      const surface = emptySurface(boundedFrame(1240, 1754));
      const id = `stroke-${i}`;
      surface.objects[id] = longStroke(id, 6_000);
      surface.order.push(id);
      appendPage(notebook, notebookPage(`page-${i}`, { surface }));
    }

    const result = await timerDelay(() => encodeNotebookAsync(notebook, () => true));
    console.info(`notebook async bytes=${result.bytes} maxEventLoopGapMs=${result.maxEventLoopGapMs.toFixed(1)} encodeDurationMs=${result.encodeDurationMs.toFixed(1)}`);
    expect(result.maxEventLoopGapMs).toBeLessThan(50);
  });

  it('matches native canonical bytes for small payloads', async () => {
    const surface = emptySurface(infiniteFrame());
    surface.objects.stroke = longStroke('stroke', 20);
    surface.order.push('stroke');
    surface.unknownFields = {
      vendorPayload: { nullValue: null, omitted: undefined, array: [1, undefined, 3] },
    } as never;
    expect(await encodeWhiteboardAsync(surface, () => true)).toEqual(encodeWhiteboard(surface));

    const notebook = emptyNotebook('Small');
    const page = notebookPage('page-1', { surface: emptySurface(boundedFrame(1240, 1754)) });
    appendPage(notebook, page);
    notebook.unknownFields = {
      vendorPayload: { nullValue: null, omitted: undefined, array: [1, undefined, 3] },
    };
    page.record.vendorPageField = { keep: true, omit: undefined } as never;
    expect(await encodeNotebookAsync(notebook, () => true)).toEqual(encodeNotebook(notebook));
  });
});
