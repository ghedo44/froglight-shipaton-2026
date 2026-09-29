/**
 * Promise-based modal prompts, rendered through the shared React overlay
 * host. No window.prompt/confirm — Tauri webviews disable those; styled
 * modals match the workbench anyway.
 *
 * The public contract is unchanged from the previous hand-rolled DOM
 * implementation: calling returns a promise and the modal is mounted,
 * focused, and keyboard-wired synchronously.
 */

import {
  uiConfirmReact,
  uiPromptNewNoteReact,
  uiPromptReact,
  type NewNoteChoice,
} from './react/overlays.jsx';
import type { NewNoteOptions } from './react/NewNoteModal.jsx';

export type { NewNoteChoice } from './react/NewNoteModal.jsx';

export function uiPrompt(
  title: string,
  options: {
    placeholder?: string;
    initialValue?: string;
    confirmLabel?: string;
    description?: string;
    inputType?: 'text' | 'password';
  } = {},
): Promise<string | null> {
  return uiPromptReact(title, options);
}

export function uiConfirm(
  title: string,
  description?: string,
  confirmLabel?: string,
): Promise<boolean> {
  return uiConfirmReact(title, description, confirmLabel);
}

/** New-note picker resolving to a name + kind choice, or null on dismissal. */
export function uiNewNote(options: NewNoteOptions): Promise<NewNoteChoice | null> {
  return uiPromptNewNoteReact(options);
}
