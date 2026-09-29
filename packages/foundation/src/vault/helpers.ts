/**
 * Portable vault helpers built purely on the `VaultService` contract.
 */

import { parsePath, ROOT_PATH } from '../paths.js';
import type { WorkspacePath } from '../paths.js';
import type { VaultService } from './contract.js';

/**
 * Recursively create `path` and any missing ancestors. Idempotent: succeeds
 * when the directory already exists. Built on the exact `createDirectory`
 * contract so providers never need a recursive mode.
 */
export async function ensureDirectory(vault: VaultService, path: WorkspacePath): Promise<void> {
  const segments = parsePath(path);
  let prefix: WorkspacePath = ROOT_PATH;
  for (const segment of segments) {
    prefix = `${prefix === '' ? '' : `${prefix}/`}${segment}` as WorkspacePath;
    try {
      await vault.createDirectory(prefix);
    } catch (error) {
      if (isAlreadyExists(error)) {
        continue;
      }
      throw error;
    }
  }
}

/** True if `error` is the vault's structured "already exists" failure. */
export function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ALREADY_EXISTS'
  );
}
