import { expect, it } from 'vitest';
import { emptyBlockPage, paragraphBlock } from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';

/**
 * Structural responsiveness gate for a 5000-block page (replaces a
 * wall-clock <300ms threshold that was objectively incorrect).
 *
 * Root cause of the CI failure (30 keystrokes 467ms > 300ms on a loaded
 * shared runner, ~50ms locally with no code change): wall-clock measures
 * machine speed + parallel load (nx parallel=3), not algorithmic
 * complexity. The implementation is already incremental (Tiptap handle
 * `#syncNow` takes the leavesOnly path — only changed leaf blocks
 * re-decode, unchanged records share refs; ProseMirror re-renders only
 * the edited paragraph, not all 5000). A wall-clock gate flakes with
 * runner variance while proving nothing about complexity.
 *
 * Deterministic counters (`syncStats`: blocksVisited / blocksDecoded /
 * fullDecodes) pin the work honestly: reference preservation alone does
 * not prove O(1) — the counters do. Steady typing decodes exactly the
 * changed leaves (bounded, typically 1 per keystroke) with zero full
 * decodes; `blocksVisited` documents the O(n) cheap identity scan
 * (pointer comparisons, no decoding) rather than hiding it.
 *
 * Wall-clock remains only as a generous hang guard (5000ms), never a
 * performance gate, so loaded CI cannot flake it while hangs still fail.
 */
it('keeps repeated cursor movement and typing responsive in a 5000-block page', () => {
  const model = emptyBlockPage();
  model.rootOrder = Array.from({ length: 5000 }, (_, index) => `p${index}`);
  model.blocks = Object.fromEntries(
    model.rootOrder.map((id) => [
      id,
      paragraphBlock(id, [{ text: 'A paragraph of ordinary writing.' }]),
    ]),
  );
  const parent = document.createElement('div');
  document.body.append(parent);
  let changes = 0;
  const seenModels: Array<{ blocks: Record<string, unknown> }> = [];
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: (next) => {
      changes++;
      seenModels.push(next as unknown as { blocks: Record<string, unknown> });
    },
  });
  try {
    const start = performance.now();
    for (let index = 0; index < 30; index++)
      expect(
        handle.blockCommand?.('set-selection', { from: 1 + (index % 20) }),
      ).toBe(true);
    const elapsed = performance.now() - start;
    expect(changes).toBe(0);
    // Hang guard only (not a performance gate): selections are O(1)
    // ProseMirror selection dispatches with no model work (changes==0
    // above proves it). Wall-clock variance on shared CI cannot flake this.
    expect(
      elapsed,
      `30 cursor movements took ${elapsed.toFixed(0)} ms`,
    ).toBeLessThan(5000);
    const typingStart = performance.now();
    for (let index = 0; index < 30; index++)
      expect(handle.blockCommand?.('insert-text', { text: 'x' })).toBe(true);
    const typingElapsed = performance.now() - typingStart;
    // Structural proof (deterministic, machine-independent): 30
    // keystrokes produced 30 incremental models, each sharing unchanged
    // block refs (leavesOnly path — a full clone would break sharing).
    // Untouched tail block p4999 keeps identical ref across all models;
    // the edited head block changes (new text), proving only leaves
    // re-decoded.
    expect(changes).toBe(30);
    expect(seenModels).toHaveLength(30);
    const tailId = 'p4999';
    const firstTail = seenModels[0]!.blocks[tailId];
    for (const next of seenModels) {
      expect(next.blocks[tailId]).toBe(firstTail);
    }
    // Deterministic work counters: bounded decode work per keystroke (the
    // edited leaf only — never the full 5000), zero full-document
    // decodes. `blocksVisited` records the O(n) identity scan honestly
    // (cheap pointer comparisons, no decoding) instead of claiming the
    // scan is O(1).
    const stats = (
      handle as unknown as {
        syncStats?: () => {
          blocksVisited: number;
          blocksDecoded: number;
          fullDecodes: number;
        };
      }
    ).syncStats?.();
    expect(stats).toBeDefined();
    expect(stats!.fullDecodes).toBe(0);
    expect(stats!.blocksDecoded).toBe(30);
    expect(stats!.blocksVisited).toBe(30 * 5000);
    // Hang guard only (see above): typing is incremental (sharing above
    // proves it); wall-clock cannot gate CI health.
    expect(
      typingElapsed,
      `30 keystrokes took ${typingElapsed.toFixed(0)} ms`,
    ).toBeLessThan(5000);
  } finally {
    handle.destroy();
    parent.remove();
  }
});
