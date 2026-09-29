/**
 * Reading-mode preference for the workspace shell.
 *
 * Which presentation mode a freshly opened tab gets. Whether `reading`
 * mounts a registered reader is decided exclusively through the required
 * `WorkbenchReadingPort.readingPresentation` query — there is no per-kind
 * branching in the shell and no probing of optional seam methods.
 */

import type { DefaultViewMode } from '../../../settings-view.js';

export type ReadingPreference = DefaultViewMode;

/** Presentation mode for a freshly opened document tab. */
export function preferredReadingMode(input: {
  /** Per-document "always open in reading view" preference. */
  readonly perDocumentReading: boolean;
  /** Workspace-wide default view for new tabs. */
  readonly defaultView: DefaultViewMode;
  /** Modes declared by this document kind. */
  readonly availableModes: readonly ReadingPreference[];
}): ReadingPreference {
  const preferred = input.perDocumentReading ? 'reading' : input.defaultView;
  return input.availableModes.includes(preferred) ? preferred : 'edit';
}
