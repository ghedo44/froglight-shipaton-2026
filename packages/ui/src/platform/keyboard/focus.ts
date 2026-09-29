/**
 * Keyboard focus tracking (keyboard coordinator split).
 *
 * The caret/editable seam lives here and the ShellController in
 * `../keyboard-inset.js` imports it from this module, so focus policy is
 * owned in exactly one place.
 */

export {
  createCaretGuard,
  ensureFocusedEditableVisible,
  findInternalScrollableAncestor,
  isKeyboardEditable,
} from '../keyboard-caret.js';
