import { useEffect, useState } from 'react';
import {
  asObservableVault,
  readVaultProfile,
  VAULT_PROFILE_PATH,
  type VaultProfile,
  type VaultService,
  type VaultSyncService,
} from '@froglight/foundation';

/** Observe local commits and completed remote applies (which suppress local mutation events). */
export function useVaultProfile(
  vault: VaultService | null,
  sync: VaultSyncService | null,
  fallback: VaultProfile,
) {
  const [profile, setProfile] = useState(fallback);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const value = vault === null ? null : await readVaultProfile(vault);
        if (!alive || current !== generation) return;
        setProfile(value ?? fallback);
        setError(null);
      } catch (reason) {
        if (!alive || current !== generation) return;
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not read vault details.',
        );
      }
    };
    const offMutation =
      vault === null
        ? undefined
        : asObservableVault(vault)?.onMutation((event) => {
            if (
              event.type === 'move'
                ? event.from === VAULT_PROFILE_PATH ||
                  event.to === VAULT_PROFILE_PATH
                : event.path === VAULT_PROFILE_PATH
            )
              void refresh();
          });
    let lastSynced = sync?.snapshot().lastSyncedAt;
    const offSync = sync?.subscribe((snapshot) => {
      if (snapshot.lastSyncedAt !== lastSynced) {
        lastSynced = snapshot.lastSyncedAt;
        void refresh();
      }
    });
    void refresh();
    return () => {
      alive = false;
      offMutation?.();
      offSync?.();
    };
  }, [vault, sync, fallback]);
  return { profile, setProfile, error };
}
