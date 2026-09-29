/** Durable vault sync metadata validation and merge-base verification. */

import { VaultSyncError } from './errors.js';
import { isValidWorkspacePath } from '../paths.js';
import { hashManifest, isManifestHash, parseSyncManifest } from './manifest.js';
import type {
  AccountSyncState,
  StoredSyncState,
  SyncBase,
  SyncManifest,
  VaultSyncBinding,
  VaultSyncConflictSummary,
} from './contract.js';

/** Bound persisted/UI state so corrupt metadata cannot grow without limit. */
export const MAX_CONFLICTS_PER_BINDING = 1_000;

/**
 * True for a durable numeric generation/version field: safe non-negative
 * integer only. Rejects NaN, ±Infinity, negatives, fractions, and unsafe
 * integers — `typeof === 'number'` alone is insufficient for persisted
 * envelopes that cross restarts and attacker-visible storage.
 */
export function isSafeNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (value as number) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Structural validation of one persisted `SyncBase`. The merge ancestor
 * is untrusted input: it must parse through
 * the canonical manifest validator, carry a well-formed hash, and
 * belong to the binding's cloud vault. Cryptographic verification
 * (`hashManifest(manifest) === hash`) is necessarily async and happens
 * in `verifyPersistedSyncBase()` before the base can influence merge.
 *
 * Returns the parsed base, `'corrupt'` for a malformed manifest/hash/
 * vault mismatch, or null when the raw value is not even a base shape.
 * Corruption is NEVER repaired here: the caller preserves the binding
 * and marks it `baseCorrupt` so the replica is never mistaken for a
 * brand-new vault.
 */
function parseSyncBaseStructural(
  value: unknown,
  cloudVaultId: string,
): SyncBase | 'corrupt' | null {
  if (!isRecord(value)) return null;
  if (!isManifestHash(value.hash)) return 'corrupt';
  let manifest: SyncManifest;
  try {
    manifest = parseSyncManifest(value.manifest);
  } catch {
    return 'corrupt';
  }
  if (manifest.vaultId !== cloudVaultId) return 'corrupt';
  return { manifest, hash: value.hash };
}

function parseConflictSummaries(
  value: unknown,
): readonly VaultSyncConflictSummary[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONFLICTS_PER_BINDING) {
    return null;
  }
  const seen = new Set<string>();
  const parsed: VaultSyncConflictSummary[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    if (
      !isNonEmptyString(raw.id) ||
      seen.has(raw.id) ||
      !isValidWorkspacePath(raw.path) ||
      raw.path.length === 0 ||
      (raw.conflictPath !== null &&
        (!isValidWorkspacePath(raw.conflictPath) ||
          raw.conflictPath.length === 0)) ||
      !['edit-edit', 'delete-edit', 'edit-delete', 'file-directory'].includes(
        raw.kind as string,
      ) ||
      !['local', 'remote'].includes(raw.kept as string) ||
      !isNonEmptyString(raw.detectedAt) ||
      (raw.recoveredAt !== null && !isNonEmptyString(raw.recoveredAt))
    ) {
      return null;
    }
    seen.add(raw.id);
    parsed.push({
      id: raw.id,
      path: raw.path,
      kind: raw.kind as VaultSyncConflictSummary['kind'],
      conflictPath: raw.conflictPath as string | null,
      kept: raw.kept as VaultSyncConflictSummary['kept'],
      detectedAt: raw.detectedAt,
      recoveredAt: raw.recoveredAt as string | null,
    });
  }
  return parsed;
}

/**
 * Validate one persisted binding envelope. Gross envelope malformation
 * (missing ids/device/enabled) degrades to a fresh start — survival of
 * local vaults never depends on this data. A corrupt BASE is different:
 * silently dropping only the base would make the next reconcile treat a
 * previously bound replica as brand new and could produce an incorrect
 * first-sync merge against a cloud vault with history. The binding is
 * therefore preserved with `baseCorrupt: true`, which parks
 * reconciliation with `CORRUPT_SYNC_METADATA` until the base is rebuilt
 * from verified remote state. The base digest is recomputed before
 * merge use (`verifyPersistedSyncBase`).
 */
function parseBinding(value: unknown): VaultSyncBinding | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.cloudVaultId) ||
    !isNonEmptyString(value.localVaultId) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.deviceId)
  ) {
    return null;
  }
  if (typeof value.enabled !== 'boolean') return null;
  let base: SyncBase | null = null;
  let baseCorrupt = value.baseCorrupt === true;
  if (value.base !== null) {
    const parsed = parseSyncBaseStructural(value.base, value.cloudVaultId);
    if (parsed === null) {
      baseCorrupt = true;
    } else if (parsed === 'corrupt') {
      baseCorrupt = true;
    } else {
      base = parsed;
    }
  }
  if (value.lastSyncedAt !== null && typeof value.lastSyncedAt !== 'string') {
    return null;
  }
  // Strict numeric durability: lastRevision is null or a safe
  // non-negative integer. NaN/Infinity/negatives/fractions/unsafe
  // integers degrade the envelope rather than persisting corrupt sync
  // progress across restarts.
  if (
    value.lastRevision !== null &&
    !isSafeNonNegativeInt(value.lastRevision)
  ) {
    return null;
  }
  const conflicts = parseConflictSummaries(value.conflicts);
  if (conflicts === null) return null;
  return {
    cloudVaultId: value.cloudVaultId,
    localVaultId: value.localVaultId,
    name: value.name,
    deviceId: value.deviceId,
    base,
    ...(baseCorrupt ? { baseCorrupt: true } : {}),
    lastSyncedAt: value.lastSyncedAt as string | null,
    lastRevision: value.lastRevision as number | null,
    enabled: value.enabled,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

/**
 * Cryptographic verification of a persisted merge base. The digest must
 * recompute from the canonical manifest. A
 * mismatch means the metadata is corrupt: callers must surface
 * `CORRUPT_SYNC_METADATA`, park reconciliation for the binding, and
 * preserve every local file — never treat the replica as brand new
 * (which could produce an incorrect first-sync merge against a cloud
 * vault with history).
 */
export async function verifyPersistedSyncBase(
  base: SyncBase,
  cloudVaultId: string,
): Promise<SyncBase> {
  if (base.manifest.vaultId !== cloudVaultId) {
    throw new VaultSyncError(
      'CORRUPT_SYNC_METADATA',
      'persisted sync base belongs to a different cloud vault',
    );
  }
  let computed: string;
  try {
    computed = await hashManifest(base.manifest);
  } catch (error) {
    throw new VaultSyncError(
      'CORRUPT_SYNC_METADATA',
      'persisted sync base manifest could not be hashed',
      { cause: error },
    );
  }
  if (computed !== base.hash) {
    throw new VaultSyncError(
      'CORRUPT_SYNC_METADATA',
      'persisted sync base hash does not match its manifest',
    );
  }
  return base;
}

function parseAccountState(value: unknown): AccountSyncState | null {
  if (!isRecord(value)) return null;
  if (
    value.activeLocalVaultId !== null &&
    !isNonEmptyString(value.activeLocalVaultId)
  ) {
    return null;
  }
  if (!isRecord(value.bindings)) return null;
  const bindings: Record<string, VaultSyncBinding> = {};
  for (const [localVaultId, raw] of Object.entries(value.bindings)) {
    if (localVaultId.length === 0) return null;
    const parsed = parseBinding(raw);
    if (parsed === null) return null;
    // The map key is authoritative for the local vault identity: a
    // binding smuggled under the wrong key degrades the whole envelope
    // rather than attaching one vault's cloud state to another.
    if (parsed.localVaultId !== localVaultId) return null;
    bindings[localVaultId] = parsed;
  }
  return {
    bindings,
    activeLocalVaultId:
      value.activeLocalVaultId === null
        ? null
        : (value.activeLocalVaultId as string),
  };
}

/**
 * Validate persisted UID-scoped sync state. Anything
 * malformed degrades to a fresh start (never bricks local use).
 */
export function parseStoredSyncState(value: unknown): StoredSyncState | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (!isNonEmptyString(value.deviceId)) return null;
  if (!isRecord(value.accounts)) return null;
  const accounts: Record<string, AccountSyncState> = {};
  for (const [uid, raw] of Object.entries(value.accounts)) {
    if (uid.length === 0) return null;
    const parsed = parseAccountState(raw);
    if (parsed === null) return null;
    accounts[uid] = parsed;
  }
  return { version: 1, deviceId: value.deviceId, accounts };
}
