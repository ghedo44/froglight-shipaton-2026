/**
 * Keyboard coordinator seam (keyboard coordinator split).
 *
 * The ShellController in `../keyboard-inset.js` retains the public shell
 * API and the transition lifecycle; the pure policy helpers it calls live
 * in the sibling modules (`flip-animator`, `focus`, `slots`,
 * `viewport-source`, `band`), so each concern is owned in exactly one
 * place. This module re-exports the service contract so new code imports
 * from the coordinator seam.
 */

export type {
  KeyboardInsetService,
  KeyboardInsetSnapshot,
} from '@froglight/foundation';
