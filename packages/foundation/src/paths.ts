/**
 * Portable workspace paths.
 *
 * A `WorkspacePath` is a branded string that represents a logical location
 * inside a workspace vault. It is deliberately distinct from raw OS/browser
 * paths: the provider translates it to its local representation.
 *
 * Semantics:
 *
 * - `""` is the one and only root value;
 * - `/` is the only logical separator;
 * - non-root paths have no leading or trailing slash;
 * - `.`, `..`, repeated empty segments, NUL, and backslash are rejected;
 * - user spelling, case, and Unicode code points are preserved exactly —
 *   paths are never lowercased and Unicode normalization is never applied
 *   silently by the portable layer;
 * - the value is a plain string, so it is trivially serializable.
 *
 * Host-specific path conventions (Windows separators, absolute paths,
 * drive letters) are never valid workspace paths.
 */

import { VaultError } from './errors.js';

/** Branded portable workspace path. */
export type WorkspacePath = string & { readonly __workspacePath: unique symbol };

/** The root of every workspace vault. */
export const ROOT_PATH: WorkspacePath = '' as WorkspacePath;

const INVALID = (input: string) =>
  new VaultError('INVALID_PATH', `invalid workspace path: ${JSON.stringify(input)}`);

/** Validate the raw string form of a workspace path (without branding). */
export function isValidWorkspacePath(input: unknown): input is string {
  if (typeof input !== 'string') {
    return false;
  }
  if (input === '') {
    return true;
  }
  if (input.includes('\0') || input.includes('\\')) {
    return false;
  }
  if (input.startsWith('/') || input.endsWith('/')) {
    return false;
  }
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }
  return true;
}

/** Validate a single path segment name (no separators allowed). */
export function isValidSegment(input: unknown): input is string {
  return (
    typeof input === 'string' &&
    input !== '' &&
    input !== '.' &&
    input !== '..' &&
    !input.includes('/') &&
    !input.includes('\\') &&
    !input.includes('\0')
  );
}

/**
 * Brand a validated string as a `WorkspacePath`. Throws `VaultError` with
 * code `INVALID_PATH` for invalid input.
 */
export function workspacePath(input: string): WorkspacePath {
  if (!isValidWorkspacePath(input)) {
    throw INVALID(input);
  }
  return input as WorkspacePath;
}

/** True if `value` is a valid workspace path string. Never throws. */
export function isWorkspacePath(value: unknown): value is WorkspacePath {
  return isValidWorkspacePath(value);
}

/** Throw `INVALID_PATH` unless `value` is a valid workspace path. */
export function assertWorkspacePath(value: unknown): asserts value is WorkspacePath {
  if (!isValidWorkspacePath(value)) {
    throw INVALID(String(value));
  }
}

/** The path segments of a non-root path; `[]` for the root. */
export function parsePath(path: WorkspacePath): readonly string[] {
  assertWorkspacePath(path);
  if (path === '') {
    return [];
  }
  return path.split('/');
}

/** True when `path` is the root. */
export function isRootPath(path: WorkspacePath): boolean {
  return path === ROOT_PATH;
}

/**
 * Join a path prefix with one or more segment names. Segments must be valid
 * single names: they may not contain `/`, `\`, NUL, and must not be empty,
 * `.`, or `..`. `joinPath('a/b', 'c') === 'a/b/c'`.
 */
export function joinPath(prefix: WorkspacePath, ...segments: readonly string[]): WorkspacePath {
  assertWorkspacePath(prefix);
  const parts = [...parsePath(prefix)];
  for (const segment of segments) {
    if (!isValidSegment(segment)) {
      throw INVALID(segment);
    }
    parts.push(segment);
  }
  return parts.join('/') as WorkspacePath;
}

/** The parent of `path`; the root for the root and for single-segment paths. */
export function parentPath(path: WorkspacePath): WorkspacePath {
  assertWorkspacePath(path);
  const segments = parsePath(path);
  return segments.slice(0, -1).join('/') as WorkspacePath;
}

/** The last segment name of `path`, or `null` for the root. */
export function pathName(path: WorkspacePath): string | null {
  assertWorkspacePath(path);
  const segments = parsePath(path);
  return segments.length === 0 ? null : (segments[segments.length - 1] ?? null);
}

/** The number of segments in `path` (0 for the root). */
export function pathDepth(path: WorkspacePath): number {
  return parsePath(path).length;
}

/**
 * True when `path` equals `ancestor` or lives below it
 * (`isWithinPath('a/b/c', 'a')` is true; `isWithinPath('ab/c', 'a')` is false).
 */
export function isWithinPath(path: WorkspacePath, ancestor: WorkspacePath): boolean {
  assertWorkspacePath(path);
  assertWorkspacePath(ancestor);
  return path === ancestor || path.startsWith(`${ancestor}/`);
}
