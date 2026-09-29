/**
 * Host sync-metadata storage.
 *
 * localStorage-backed `VaultSyncStorage` with memory fallback: round
 * trips the persisted envelope, degrades corrupt/unreadable state to a
 * fresh start (never bricks boot), and clears best-effort.
 */

import { describe, expect, it } from 'vitest';
import type { StoredSyncState } from '@froglight/foundation';
import {
  createLocalStorageSyncStorage,
  type SyncStorageBackend,
} from './sync-storage.js';

function memoryBackend(
  initial: Record<string, string> = {},
): SyncStorageBackend & {
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

const ENVELOPE: StoredSyncState = {
  version: 1,
  deviceId: 'device-1',
  accounts: {
    'uid-alice': {
      bindings: {
        'local-1': {
          cloudVaultId: 'cloud-1',
          localVaultId: 'local-1',
          name: 'University',
          deviceId: 'device-1',
          base: null,
          lastSyncedAt: null,
          lastRevision: null,
          enabled: true,
        },
      },
      activeLocalVaultId: 'local-1',
    },
  },
};

describe('localStorage sync storage', () => {
  it('round-trips the persisted envelope', async () => {
    const backend = memoryBackend();
    const storage = createLocalStorageSyncStorage({ backend });
    expect(await storage.load()).toBeNull();
    await storage.save(ENVELOPE);
    expect(await storage.load()).toEqual(ENVELOPE);
    await storage.clear();
    expect(await storage.load()).toBeNull();
  });

  it('degrades corrupt payloads to a fresh start', async () => {
    const backend = memoryBackend({ 'froglight.vault-sync': '{oops' });
    const storage = createLocalStorageSyncStorage({ backend });
    expect(await storage.load()).toBeNull();
  });

  it('degrades throwing backends to a fresh start', async () => {
    const storage = createLocalStorageSyncStorage({
      backend: {
        getItem: () => {
          throw new Error('private mode');
        },
        setItem: () => {
          throw new Error('private mode');
        },
        removeItem: () => {
          throw new Error('private mode');
        },
      },
    });
    expect(await storage.load()).toBeNull();
    await storage.clear();
  });

  it('namespaces concurrent vaults by key', async () => {
    const backend = memoryBackend();
    const first = createLocalStorageSyncStorage({ backend, key: 'sync:a' });
    const second = createLocalStorageSyncStorage({ backend, key: 'sync:b' });
    await first.save({ ...ENVELOPE, deviceId: 'device-a' });
    expect(await second.load()).toBeNull();
  });
});
