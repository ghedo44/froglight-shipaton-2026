/**
 * Deterministic mock handwriting recognizer: the replaceable
 * provider proof for the explicit recognition flow. Maps each stroke count
 * to a canned line so tests assert merge/clear behavior without an OCR
 * engine.
 */

import type {
  HandwritingQueryPage,
  HandwritingRecognizer,
  RecognizedHandwritingLine,
} from '../notebooks/recognition.js';

export class MockHandwritingRecognizer implements HandwritingRecognizer {
  readonly id = 'mock-handwriting';
  readonly #lines: readonly string[];

  constructor(lines: readonly string[] = ['recognized words']) {
    this.#lines = lines;
  }

  recognize(
    pages: readonly HandwritingQueryPage[],
  ): readonly RecognizedHandwritingLine[] {
    const out: RecognizedHandwritingLine[] = [];
    for (const page of pages) {
      // Deterministic chunking: one line per two strokes, in stroke order.
      for (let i = 0; i < page.strokes.length; i += 2) {
        const group = page.strokes.slice(i, i + 2);
        out.push({
          pageId: page.pageId,
          strokeIds: group.map((stroke) => String(stroke.id)),
          text: this.#lines[out.length % this.#lines.length]!,
        });
      }
    }
    return out;
  }
}
