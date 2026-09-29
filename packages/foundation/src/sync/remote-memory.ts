/**
 * In-memory `SyncRemote`.
 *
 * Conformance double for the merge engine and multi-device tests: one
 * shared instance stands in for Firestore (HEAD docs) + Storage
 * (immutable manifests, content-addressed blobs) with identical
 * crash-safety semantics — manifests and blobs are uploaded before the
 * transactional HEAD swap, so an interrupted commit leaves the previous
 * HEAD valid and the new objects harmlessly orphaned.
 *
 * Call counters (`uploads`, `downloads`, …) let tests prove work
 * efficiency (e.g. large unchanged assets are not re-uploaded).
 */

import { sha256Hex } from '../hashing.js';
import { VaultSyncError } from './errors.js';
import {
  canonicalizeManifest,
  hashBytes,
  parseRemoteHead,
  parseSyncManifest,
} from './manifest.js';
import type {
  ExpectedHead,
  ManifestHash,
  RemoteHead,
  RemoteHeadInput,
  RemoteVaultInfo,
  SyncManifest,
  SyncRemote,
} from './contract.js';

interface StoredVault {
  head: RemoteHead | null;
  manifests: Map<ManifestHash, string>;
  blobs: Map<string, Uint8Array>;
  listeners: Set<(head: RemoteHead | null) => void>;
  errorListeners: Set<(error: unknown) => void>;
}

export class MemorySyncRemote implements SyncRemote {
  private readonly vaults = new Map<string, StoredVault>();
  /** Test-visible operation counters, per vault + method. */
  readonly calls: string[] = [];

  private vaultState(vaultId: string): StoredVault {
    let state = this.vaults.get(vaultId);
    if (state === undefined) {
      state = {
        head: null,
        manifests: new Map(),
        blobs: new Map(),
        listeners: new Set(),
        errorListeners: new Set(),
      };
      this.vaults.set(vaultId, state);
    }
    return state;
  }

  async listVaults(): Promise<readonly RemoteVaultInfo[]> {
    this.calls.push('listVaults');
    const out: RemoteVaultInfo[] = [];
    for (const [cloudVaultId, state] of [...this.vaults].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (state.head === null) continue;
      out.push({
        cloudVaultId,
        name: state.head.name,
        revision: state.head.revision,
        updatedAt: state.head.updatedAt,
      });
    }
    return out;
  }

  async readHead(vaultId: string): Promise<RemoteHead | null> {
    this.calls.push(`readHead:${vaultId}`);
    const head = this.vaultState(vaultId).head;
    return head === null ? null : parseRemoteHead({ ...head });
  }

  async loadManifest(
    vaultId: string,
    manifestHash: ManifestHash,
    _manifestObject?: string,
  ): Promise<SyncManifest> {
    void _manifestObject;
    this.calls.push(`loadManifest:${vaultId}:${manifestHash}`);
    const canonical = this.vaultState(vaultId).manifests.get(manifestHash);
    if (canonical === undefined) {
      throw new VaultSyncError(
        'REMOTE_NOT_FOUND',
        `manifest ${manifestHash} not found for vault ${vaultId}`,
      );
    }
    return parseSyncManifest(JSON.parse(canonical));
  }

  async hasBlob(vaultId: string, blob: string): Promise<boolean> {
    this.calls.push(`hasBlob:${vaultId}:${blob}`);
    return this.vaultState(vaultId).blobs.has(blob);
  }

  async uploadBlob(
    vaultId: string,
    blob: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.calls.push(`uploadBlob:${vaultId}:${blob}`);
    // Defense in depth (content-address safety): never store bytes that do
    // not hash to the requested address. A mismatched upload is a caller
    // bug or a scan→upload race that the engine must retry as
    // LOCAL_CHANGED — never silently poison the immutable key.
    const actual = await hashBytes(bytes);
    if (actual !== blob) {
      throw new VaultSyncError(
        'HASH_MISMATCH',
        `upload bytes do not match requested hash ${blob} (got ${actual})`,
      );
    }
    const state = this.vaultState(vaultId);
    const existing = state.blobs.get(blob);
    if (existing !== undefined) {
      // Idempotent success for byte-identical duplicates (crash retry,
      // duplicate blob race). A different byte sequence under the same
      // hash is impossible without a collision/bug — fail loudly, never
      // overwrite.
      if (
        existing.length !== bytes.length ||
        !existing.every((value, index) => value === bytes[index])
      ) {
        throw new VaultSyncError(
          'CORRUPT_MANIFEST',
          `immutable blob ${blob} already exists with different content`,
        );
      }
      return;
    }
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    // Immutability guard: identical hash must mean identical bytes.
    state.blobs.set(blob, copy);
  }

  async downloadBlob(vaultId: string, blob: string): Promise<Uint8Array> {
    this.calls.push(`downloadBlob:${vaultId}:${blob}`);
    const stored = this.vaultState(vaultId).blobs.get(blob);
    if (stored === undefined) {
      throw new VaultSyncError(
        'REMOTE_NOT_FOUND',
        `blob ${blob} not found for vault ${vaultId}`,
      );
    }
    const copy = new Uint8Array(stored.length);
    copy.set(stored);
    return copy;
  }

  async uploadManifest(
    vaultId: string,
    manifest: SyncManifest,
  ): Promise<{ hash: ManifestHash; object: string }> {
    this.calls.push(`uploadManifest:${vaultId}`);
    const parsed = parseSyncManifest({
      ...manifest,
      entries: [...manifest.entries],
    });
    if (parsed.vaultId !== vaultId) {
      throw new VaultSyncError(
        'CORRUPT_MANIFEST',
        `manifest vault ${parsed.vaultId} does not match vault ${vaultId}`,
      );
    }
    const canonical = canonicalizeManifest(parsed);
    const hex = await sha256Hex(new TextEncoder().encode(canonical));
    const hash = `sha256:${hex}`;
    const state = this.vaultState(vaultId);
    const existing = state.manifests.get(hash);
    if (existing !== undefined) {
      // Idempotent retry (crash after manifest upload, before HEAD):
      // byte-identical duplicates succeed. Different bytes under the same
      // hash would be a collision/bug — fail loudly.
      if (existing !== canonical) {
        throw new VaultSyncError(
          'CORRUPT_MANIFEST',
          `immutable manifest ${hash} already exists with different content`,
        );
      }
    } else {
      state.manifests.set(hash, canonical);
    }
    return {
      hash,
      object: `memory/${vaultId}/manifests/${parsed.revision}-${hex}.json`,
    };
  }

  async compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ): Promise<RemoteHead> {
    this.calls.push(`compareAndSwapHead:${vaultId}:${next.revision}`);
    const state = this.vaultState(vaultId);
    const current = state.head;
    const matches =
      expected === null
        ? current === null
        : current !== null &&
          current.revision === expected.revision &&
          current.manifestHash === expected.manifestHash;
    if (!matches) {
      throw new VaultSyncError(
        'REMOTE_CHANGED',
        `HEAD changed under vault ${vaultId}: expected revision ${expected?.revision ?? 'none'}`,
      );
    }
    const now = new Date().toISOString();
    const head: RemoteHead = parseRemoteHead({
      protocolVersion: 1,
      name: next.name,
      revision: next.revision,
      manifestHash: next.manifestHash,
      manifestObject: next.manifestObject,
      fileCount: next.fileCount,
      totalBytes: next.totalBytes,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      updatedByDeviceId: next.updatedByDeviceId,
    });
    state.head = head;
    for (const listener of [...state.listeners]) {
      try {
        listener({ ...head });
      } catch {
        // Listener failures must never break the commit path.
      }
    }
    return { ...head };
  }

  watchHead(
    vaultId: string,
    onHead: (head: RemoteHead | null) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const state = this.vaultState(vaultId);
    state.listeners.add(onHead);
    if (onError !== undefined) state.errorListeners.add(onError);
    return () => {
      state.listeners.delete(onHead);
      if (onError !== undefined) state.errorListeners.delete(onError);
    };
  }

  /**
   * Test seam: deliver a subscription-local watcher failure for one
   * vault. Invokes only the `onError` callbacks registered for that
   * vault id — never a global hook — mirroring the Firebase provider's
   * per-subscription error channel.
   */
  failWatch(vaultId: string, error: unknown): void {
    for (const listener of [...this.vaultState(vaultId).errorListeners]) {
      try {
        listener(error);
      } catch {
        // Error reporting must never break the watcher.
      }
    }
  }
}
