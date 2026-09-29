/**
 * Node.js filesystem error → `VaultError` translation.
 *
 * Host error objects never cross the provider boundary: every
 * expected failure is a `VaultError` with a stable code. The mapping is
 * code-first; anything unrecognized becomes `IO` so consumers never see
 * raw `NodeJS.ErrnoException` objects.
 */

import { VaultError } from '@froglight/foundation';
import type { WorkspacePath } from '@froglight/foundation';
import type { VaultErrorCode } from '@froglight/foundation';

/** The subset of Node error codes the provider understands. */
type NodeFsErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'ENOTEMPTY'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'EACCES'
  | 'EPERM'
  | 'ENOSPC'
  | 'EDQUOT'
  | 'EROFS';

const CODE_MAP: Readonly<Record<NodeFsErrorCode, VaultErrorCode>> = {
  ENOENT: 'NOT_FOUND',
  EEXIST: 'ALREADY_EXISTS',
  ENOTEMPTY: 'CONFLICT',
  EISDIR: 'IS_DIRECTORY',
  ENOTDIR: 'NOT_DIRECTORY',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
  ENOSPC: 'QUOTA_EXCEEDED',
  EDQUOT: 'QUOTA_EXCEEDED',
  EROFS: 'UNSUPPORTED',
};

function errnoCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** True when `error` is a Node `ENOENT` (missing file/directory). */
export function isFsNotFound(error: unknown): boolean {
  return errnoCode(error) === 'ENOENT';
}

/** Translate a Node filesystem failure into a structured `VaultError`. */
export function mapFsError(error: unknown, path: WorkspacePath): VaultError {
  const code = errnoCode(error);
  const vaultCode = code !== null ? (CODE_MAP[code as NodeFsErrorCode] ?? 'IO') : 'IO';
  const detail = error instanceof Error ? error.message : String(error);
  return new VaultError(vaultCode, `native filesystem: ${detail}`, { path, cause: error });
}
