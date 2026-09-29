/**
 * Sync manifest format.
 *
 * Versioned, deterministic, provider-neutral: identical vault states
 * produce byte-identical canonical JSON and therefore identical hashes.
 * Remote manifests are untrusted input — `parseSyncManifest` validates
 * every field (format, version, vault id, revision, paths, duplicates,
 * hash shape, sizes, entry limits, directory/file collisions) before the
 * engine materializes anything, and every path passes through the
 * existing `WorkspacePath` layer (never raw host paths).
 */

import { sha256Hex } from '../hashing.js';
import { isValidWorkspacePath } from '../paths.js';
import { VaultSyncError } from './errors.js';
import {
  SYNC_MANIFEST_FORMAT,
  SYNC_PROTOCOL_VERSION,
  type ManifestHash,
  type RemoteHead,
  type SyncManifest,
  type SyncManifestEntry,
} from './contract.js';

/** Re-exported format discriminators for single-import consumers. */
export { SYNC_MANIFEST_FORMAT, SYNC_PROTOCOL_VERSION };

/** V1 resource limits against pathological manifests and objects. */
export const SYNC_LIMITS = {
  /** Maximum entries per manifest (also the Firestore HEAD `fileCount` bound). */
  maxEntries: 100_000,
  /** Maximum canonical manifest bytes (mirrors the Storage rule). */
  maxManifestBytes: 8 * 1024 * 1024,
  /** Maximum synced file bytes (mirrors the Storage rule). */
  maxBlobBytes: 512 * 1024 * 1024,
  /** Maximum UTF-8 bytes per entry path. */
  maxPathBytes: 1024,
} as const;

const BLOB_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** True for well-formed `sha256:<hex>` content references. Never throws. */
export function isBlobRef(value: unknown): value is string {
  return typeof value === 'string' && BLOB_REF_PATTERN.test(value);
}

/** True for well-formed `sha256:<hex>` manifest hashes. Never throws. */
export function isManifestHash(value: unknown): value is ManifestHash {
  return typeof value === 'string' && MANIFEST_HASH_PATTERN.test(value);
}

/** Build a `sha256:<hex>` reference from raw hex digest. */
export function blobRef(hex: string): string {
  return `sha256:${hex}`;
}

/** Hex digest portion of a validated blob reference. */
export function blobHex(ref: string): string {
  if (!isBlobRef(ref)) {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      `malformed blob reference: ${ref}`,
    );
  }
  return ref.slice('sha256:'.length);
}

/** SHA-256 content address for bytes. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return blobRef(await sha256Hex(bytes));
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Manifest entries in deterministic (code-unit) path order. */
export function sortManifestEntries(
  entries: readonly SyncManifestEntry[],
): SyncManifestEntry[] {
  return [...entries].sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Canonical JSON encoding: fixed key order, entries sorted by path, no
 * whitespace. Byte-identical input states hash identically.
 */
export function canonicalizeManifest(manifest: SyncManifest): string {
  const entries = sortManifestEntries(manifest.entries)
    .map((entry) =>
      entry.kind === 'file'
        ? `{"blob":${JSON.stringify(entry.blob)},"kind":"file","path":${JSON.stringify(entry.path)},"size":${entry.size}}`
        : `{"kind":"directory","path":${JSON.stringify(entry.path)}}`,
    )
    .join(',');
  return (
    `{"entries":[${entries}],` +
    `"format":${JSON.stringify(manifest.format)},` +
    `"parentHash":${manifest.parentHash === null ? 'null' : JSON.stringify(manifest.parentHash)},` +
    `"revision":${manifest.revision},` +
    `"vaultId":${JSON.stringify(manifest.vaultId)},` +
    `"version":${manifest.version}}`
  );
}

/** Content hash of the canonical manifest encoding. */
export async function hashManifest(
  manifest: SyncManifest,
): Promise<ManifestHash> {
  return blobRef(
    await sha256Hex(new TextEncoder().encode(canonicalizeManifest(manifest))),
  );
}

/** Empty manifest: the merge base before the first sync. */
export function emptyManifest(vaultId: string): SyncManifest {
  return {
    format: SYNC_MANIFEST_FORMAT,
    version: SYNC_PROTOCOL_VERSION,
    vaultId,
    revision: 0,
    parentHash: null,
    entries: [],
  };
}

export interface BuildManifestInput {
  readonly vaultId: string;
  readonly revision: number;
  readonly parentHash: ManifestHash | null;
  readonly entries: readonly SyncManifestEntry[];
}

/** Build a manifest with deterministic entry ordering. */
export function buildManifest(input: BuildManifestInput): SyncManifest {
  return {
    format: SYNC_MANIFEST_FORMAT,
    version: SYNC_PROTOCOL_VERSION,
    vaultId: input.vaultId,
    revision: input.revision,
    parentHash: input.parentHash,
    entries: sortManifestEntries(input.entries),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(reason: string): never {
  throw new VaultSyncError(
    'CORRUPT_MANIFEST',
    `invalid sync manifest: ${reason}`,
  );
}

function checkPath(path: unknown): string {
  if (typeof path !== 'string') fail('entry path must be a string');
  if (path === '') fail('entry path must not be the vault root');
  if (!isValidWorkspacePath(path))
    fail(`invalid workspace path: ${JSON.stringify(path)}`);
  if (new TextEncoder().encode(path).length > SYNC_LIMITS.maxPathBytes) {
    fail(`entry path exceeds ${SYNC_LIMITS.maxPathBytes} bytes`);
  }
  return path;
}

/**
 * Parse and validate an untrusted manifest value. Rejects
 * unknown versions structurally instead of guessing. Never trusts
 * arbitrary Storage JSON: every field, limit, duplicate, and
 * directory/file collision is checked. Throws `CORRUPT_MANIFEST`.
 */
export function parseSyncManifest(value: unknown): SyncManifest {
  if (!isPlainObject(value)) fail('manifest must be an object');
  if (value.format !== SYNC_MANIFEST_FORMAT) {
    fail(`unknown manifest format: ${JSON.stringify(value.format)}`);
  }
  if (value.version !== SYNC_PROTOCOL_VERSION) {
    fail(`unsupported manifest version: ${JSON.stringify(value.version)}`);
  }
  if (typeof value.vaultId !== 'string' || value.vaultId.length === 0) {
    fail('manifest vaultId must be a non-empty string');
  }
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    fail('manifest revision must be a safe non-negative integer');
  }
  if (value.parentHash !== null && !isManifestHash(value.parentHash)) {
    fail('manifest parentHash must be null or a sha256 reference');
  }
  if (!Array.isArray(value.entries)) fail('manifest entries must be an array');
  if (value.entries.length > SYNC_LIMITS.maxEntries) {
    fail(`manifest exceeds ${SYNC_LIMITS.maxEntries} entries`);
  }
  const entries: SyncManifestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.entries) {
    if (!isPlainObject(raw)) fail('manifest entry must be an object');
    const path = checkPath(raw.path);
    if (seen.has(path))
      fail(`duplicate manifest path: ${JSON.stringify(path)}`);
    seen.add(path);
    if (raw.kind === 'file') {
      if (!isBlobRef(raw.blob))
        fail(`malformed blob reference at ${JSON.stringify(path)}`);
      if (
        typeof raw.size !== 'number' ||
        !Number.isSafeInteger(raw.size) ||
        raw.size < 0 ||
        raw.size > SYNC_LIMITS.maxBlobBytes
      ) {
        fail(`invalid file size at ${JSON.stringify(path)}`);
      }
      entries.push({ path, kind: 'file', blob: raw.blob, size: raw.size });
    } else if (raw.kind === 'directory') {
      if (raw.blob !== undefined || raw.size !== undefined) {
        fail(
          `directory entry must not carry blob/size at ${JSON.stringify(path)}`,
        );
      }
      entries.push({ path, kind: 'directory' });
    } else {
      fail(`unknown entry kind at ${JSON.stringify(path)}`);
    }
  }
  // One namespace: no path may sit beneath another present path, in any
  // file/directory combination (explicit dirs and file-implied ancestors
  // alike). Ancestor lookup per path keeps this linear in total segments.
  for (const path of seen) {
    const segments = path.split('/');
    let prefix = '';
    for (let end = 0; end < segments.length - 1; end += 1) {
      prefix = end === 0 ? segments[0]! : `${prefix}/${segments[end]}`;
      if (seen.has(prefix)) {
        fail(`directory/file collision at ${JSON.stringify(path)}`);
      }
    }
  }
  return {
    format: SYNC_MANIFEST_FORMAT,
    version: SYNC_PROTOCOL_VERSION,
    vaultId: value.vaultId,
    revision: value.revision,
    parentHash: value.parentHash,
    entries: sortManifestEntries(entries),
  };
}

/** Parse canonical manifest bytes (size-guarded before decode). */
export function parseManifestBytes(bytes: Uint8Array): SyncManifest {
  if (bytes.length > SYNC_LIMITS.maxManifestBytes) {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      `manifest exceeds ${SYNC_LIMITS.maxManifestBytes} bytes`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new VaultSyncError('CORRUPT_MANIFEST', 'manifest is not valid JSON');
  }
  return parseSyncManifest(decoded);
}

function checkHeadString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      `invalid HEAD field: ${field}`,
    );
  }
  return value;
}

/**
 * Validate an untrusted HEAD document (shape). Manifest blobs
 * stay out of the HEAD doc by construction; this checks the pointer and
 * its bounds. Throws `CORRUPT_MANIFEST`.
 */
export function parseRemoteHead(value: unknown): RemoteHead {
  if (!isPlainObject(value)) {
    throw new VaultSyncError('CORRUPT_MANIFEST', 'invalid HEAD: not an object');
  }
  if (value.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      `invalid HEAD: unsupported protocolVersion ${JSON.stringify(value.protocolVersion)}`,
    );
  }
  const failField = (field: string): never => {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      `invalid HEAD field: ${field}`,
    );
  };
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision <= 0
  ) {
    failField('revision');
  }
  if (!isManifestHash(value.manifestHash)) failField('manifestHash');
  if (
    typeof value.fileCount !== 'number' ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    value.fileCount > SYNC_LIMITS.maxEntries
  ) {
    failField('fileCount');
  }
  if (
    typeof value.totalBytes !== 'number' ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0
  ) {
    failField('totalBytes');
  }
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    name: checkHeadString(value.name, 'name'),
    revision: value.revision as number,
    manifestHash: value.manifestHash as ManifestHash,
    manifestObject: checkHeadString(value.manifestObject, 'manifestObject'),
    fileCount: value.fileCount as number,
    totalBytes: value.totalBytes as number,
    createdAt: checkHeadString(value.createdAt, 'createdAt'),
    updatedAt: checkHeadString(value.updatedAt, 'updatedAt'),
    updatedByDeviceId: checkHeadString(
      value.updatedByDeviceId,
      'updatedByDeviceId',
    ),
  };
}

/** True when two manifests describe identical converged states. */
export function manifestsEqual(a: SyncManifest, b: SyncManifest): boolean {
  if (a.entries.length !== b.entries.length) return false;
  for (let index = 0; index < a.entries.length; index += 1) {
    const left = a.entries[index]!;
    const right = b.entries[index]!;
    if (
      left.path !== right.path ||
      left.kind !== right.kind ||
      left.blob !== right.blob ||
      left.size !== right.size
    ) {
      return false;
    }
  }
  return true;
}
