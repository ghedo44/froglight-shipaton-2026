/**
 * OPFS DOMException → `VaultError` translation.
 *
 * Host error objects never cross the provider boundary: every
 * expected failure is a `VaultError` with a stable code.
 */

import { VaultError } from '@froglight/foundation';
import type { WorkspacePath } from '@froglight/foundation';
import type { VaultErrorCode } from '@froglight/foundation';

function domCode(error: unknown): string | null {
  if (error instanceof DOMException) {
    return error.name;
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

const CODE_MAP: Readonly<Record<string, VaultErrorCode>> = {
  NotFoundError: 'NOT_FOUND',
  TypeMismatchError: 'NOT_DIRECTORY',
  InvalidStateError: 'CONFLICT',
  NoModificationAllowedError: 'PERMISSION_DENIED',
  QuotaExceededError: 'QUOTA_EXCEEDED',
  NotAllowedError: 'PERMISSION_DENIED',
};

/** Translate an OPFS failure into a structured `VaultError`. */
export function mapOpfsError(error: unknown, path: WorkspacePath): VaultError {
  const code = domCode(error);
  const vaultCode = code !== null ? (CODE_MAP[code] ?? 'IO') : 'IO';
  const detail = error instanceof Error ? error.message : String(error);
  return new VaultError(vaultCode, `OPFS: ${detail}`, { path, cause: error });
}

/** Check if error is a DOMException with given name. */
export function isDomException(error: unknown, name: string): boolean {
  return domCode(error) === name;
}
