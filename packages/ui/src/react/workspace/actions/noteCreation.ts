/**
 * New-note naming: filesystem-safe single segments for note paths.
 *
 * Pure string handling extracted from the workspace shell; the controller
 * call (`createAndOpen`) stays with the caller.
 */

/** Filesystem-safe single segment for a new note name. */
export function sanitizeNoteName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\\/g, '-')
    .split('')
    .filter((character) => character.charCodeAt(0) > 0x1f)
    .join('');
  return cleaned === '' || cleaned === '.' || cleaned === '..'
    ? 'Untitled'
    : cleaned;
}

/** Vault-relative path for a new note of the given kind extension. */
export function buildNotePath(name: string, extension: string): string {
  return `${sanitizeNoteName(name)}.${extension.replace(/^\./, '')}`;
}
