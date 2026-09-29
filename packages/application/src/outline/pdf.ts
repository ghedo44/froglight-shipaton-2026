/**
 * PDF outline stub.
 *
 * The real PDF outline is async and provider-owned
 * (`PdfDocumentHandle.getOutline`): it requires opening the source bytes
 * through a `PdfProvider`, which cannot fit the synchronous headless
 * `extract(model)` contract. The stub is registered so every first-party
 * kind resolves in the registry, and returns no rows until an async seam
 * replaces it.
 */

import { pdfKindId } from '@froglight/foundation';
import type { OutlineExtractor } from './types.js';

export const pdfOutlineExtractor: OutlineExtractor = {
  kindId: pdfKindId,
  available: false,
  extract: () => [],
};
