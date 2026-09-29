/**
 * Host sync-metadata storage.
 *
 * `VaultSyncStore` persists device/replica metadata (cloud id, base
 * revision/hash, enabled flag) outside the vault so restarts reconstruct
 * pending work by reconciliation. This module binds that contract to the
 * host key-value store both app hosts already have — `localStorage` in
 * the PWA and in the Tauri WebView — with an in-memory fallback so
 * private-mode hosts still boot (signed-out, sync parked) instead of
 * failing initialization.
 *
 * Only metadata lives here, never canonical vault content.
 * Corrupt or unreadable state degrades to a fresh start: `load()`
 * returns null and the service rebuilds from a full scan on the next
 * enable.
 */

import type { StoredSyncState, VaultSyncStorage } from '@froglight/foundation';

/** Minimal key-value surface (localStorage-shaped) for sync metadata. */
export interface SyncStorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryBackend(): SyncStorageBackend {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function defaultBackend(): SyncStorageBackend {
  try {
    const candidate = (
      globalThis as unknown as { localStorage?: SyncStorageBackend }
    ).localStorage;
    if (
      candidate !== undefined &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      // Probe once: private-mode hosts expose the object but throw on use.
      candidate.getItem('__froglight_probe__');
      return candidate;
    }
  } catch {
    // Fall through to memory.
  }
  return memoryBackend();
}

export interface LocalStorageSyncStorageOptions {
  /** Storage key for the sync envelope; defaults to a namespaced key. */
  readonly key?: string;
  /** Injected backend; defaults to localStorage with memory fallback. */
  readonly backend?: SyncStorageBackend;
}

export const DEFAULT_SYNC_STORAGE_KEY = 'froglight.vault-sync';

/**
 * Create the host `VaultSyncStorage` for `VaultSyncStore`. Payloads are
 * plain JSON; structural validation stays in the service
 * (`parseStoredSyncState`), so unknown/future envelopes degrade to a
 * fresh start instead of bricking local use.
 */
export function createLocalStorageSyncStorage(
  options: LocalStorageSyncStorageOptions = {},
): VaultSyncStorage {
  const key = options.key ?? DEFAULT_SYNC_STORAGE_KEY;
  const backend = options.backend ?? defaultBackend();
  return {
    async load(): Promise<StoredSyncState | null> {
      let raw: string | null;
      try {
        raw = backend.getItem(key);
      } catch {
        return null;
      }
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as StoredSyncState | null;
      } catch {
        return null;
      }
    },
    async save(state): Promise<void> {
      backend.setItem(key, JSON.stringify(state));
    },
    async clear(): Promise<void> {
      try {
        backend.removeItem(key);
      } catch {
        // Clearing is best-effort; a stale envelope degrades to fresh
        // through validation on the next load.
      }
    },
  };
}
