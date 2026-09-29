/**
 * Keyboard background fill band (keyboard coordinator split).
 *
 * The band paints the keyboard's region with the app surface so rounded
 * keyboard corners blend in instead of revealing the transparent WebView
 * base. Zero-height while the keyboard is down. Pure helpers here stay
 * DOM-free and testable; the ShellController owns element lifecycle.
 */

/** Opaque-background detection for one computed background string. */
export function isOpaqueBackground(backgroundColor: string): boolean {
  if (backgroundColor === '' || backgroundColor === 'transparent') {
    return false;
  }
  return !backgroundColor.endsWith(', 0)');
}

/** Band height is the max of the live keyboard height and the slot floor. */
export function bandHeightFor(
  keyboardHeight: number,
  bandFloor: number,
): number {
  return Math.max(keyboardHeight, bandFloor);
}
