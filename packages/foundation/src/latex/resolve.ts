/**
 * Pure path resolution for LaTeX includes/assets.
 *
 * References resolve relative to the referencing file's directory, stay
 * inside the workspace root, and never touch host filesystem semantics.
 * `WorkspacePath` itself rejects `..`/`.`/backslashes; these helpers give
 * LaTeX-specific normalization with `LATEX_RESOLVE_DENIED` on escape
 * attempts so the vault-backed resolver (application layer) can stay thin.
 */

import { FroglightError } from '../errors.js';

function denied(reason: string): FroglightError {
  return new FroglightError('LATEX_RESOLVE_DENIED', reason);
}

/** Directory part of a workspace-relative path ('' at root). */
export function latexDirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Join a LaTeX reference (relative to `baseDir`) into a normalized
 * workspace-relative POSIX path. Rejects absolute references, backslashes,
 * drive letters, NUL, and traversal above the workspace root.
 */
export function latexJoinPath(baseDir: string, ref: string): string {
  if (ref === '') throw denied('empty reference');
  if (ref.includes('\0')) throw denied('reference contains NUL');
  if (ref.includes('\\')) throw denied('reference contains a backslash');
  if (ref.startsWith('/')) throw denied(`absolute reference is not workspace-relative: ${ref}`);
  if (/^[a-zA-Z]:/.test(ref)) throw denied(`drive-letter reference is not workspace-relative: ${ref}`);

  const segments: string[] = [];
  for (const part of `${baseDir === '' ? '' : `${baseDir}/`}${ref}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        throw denied(`reference escapes the workspace root: ${ref}`);
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) throw denied(`reference resolves to the workspace root: ${ref}`);
  return segments.join('/');
}

/**
 * Lenient join used by the flattener: `..` segments may escape `baseDir`
 * (the flattener's namespace is relative to the entry document, so real
 * workspace-root enforcement belongs to the vault-backed resolver, which
 * validates against the actual document directory). Absolute references,
 * backslashes, drive letters, and NUL are still rejected here.
 */
export function latexRelativeJoinPath(baseDir: string, ref: string): string {
  if (ref === '') throw denied('empty reference');
  if (ref.includes('\0')) throw denied('reference contains NUL');
  if (ref.includes('\\')) throw denied('reference contains a backslash');
  if (ref.startsWith('/')) throw denied(`absolute reference is not workspace-relative: ${ref}`);
  if (/^[a-zA-Z]:/.test(ref)) throw denied(`drive-letter reference is not workspace-relative: ${ref}`);

  const segments: string[] = [];
  for (const part of `${baseDir === '' ? '' : `${baseDir}/`}${ref}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) segments.push('..');
      else if (segments[segments.length - 1] === '..') segments.push('..');
      else segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) throw denied(`reference resolves to the workspace root: ${ref}`);
  return segments.join('/');
}

/** Append `.tex` for `\input`/`\include` targets without an extension. */
export function latexEnsureTexExtension(path: string): string {
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.') ? path : `${path}.tex`;
}

/** Append `.bib` for `\bibliography` targets without an extension. */
export function latexEnsureBibExtension(path: string): string {
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.') ? path : `${path}.bib`;
}
