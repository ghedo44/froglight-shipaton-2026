import { afterEach, expect, it, vi } from 'vitest';
import { createErasurePreparation } from './erasure-preparation.js';
import type { SurfaceObjectRecord } from '@froglight/foundation';

afterEach(() => vi.unstubAllGlobals());
it('rejects synchronous worker creation and submission failures without hanging accepted work', async () => {
  for (const creation of [true, false]) {
    const terminate = vi.fn();
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          if (creation) throw new Error('worker unavailable');
        }
        postMessage() {
          throw new DOMException('clone failed', 'DataCloneError');
        }
        terminate = terminate;
      },
    );
    const lane = createErasurePreparation();
    lane.stage(
      1,
      's',
      [
        [
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
          ],
        ],
      ],
      { id: 'source', type: 'froglight.ink.source' } as SurfaceObjectRecord,
    );
    await expect(lane.finish(1)).rejects.toThrow('worker stopped');
    lane.restart?.();
    lane.stage(
      2,
      's',
      [
        [
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
          ],
        ],
      ],
      { id: 'source', type: 'froglight.ink.source' } as SurfaceObjectRecord,
    );
    await expect(lane.finish(2)).rejects.toThrow('worker stopped');
    lane.dispose();
    if (!creation) expect(terminate).toHaveBeenCalled();
  }
});
