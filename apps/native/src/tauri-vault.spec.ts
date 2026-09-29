import { describe, expect, it, vi } from 'vitest';
import {
  createNativeVaultAdapter,
  type NativeVaultBridge,
} from './tauri-vault.js';

describe('native vault launcher adapter', () => {
  it('opens the directory selected by the host instead of creating a vault', async () => {
    const existing = {
      id: 'selected-existing',
      name: 'Research',
      location: '/vaults/Research',
      lastOpenedAt: 42,
    };
    const bridge: NativeVaultBridge = {
      listRecent: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue(existing),
      createVault: vi.fn().mockRejectedValue(new Error('must not create')),
      markOpened: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
    };
    const controller = {
      openVault: vi.fn().mockResolvedValue(undefined),
      listDocuments: vi.fn().mockReturnValue([]),
    };
    const adapter = createNativeVaultAdapter(controller, bridge);

    const choice = await adapter.openVault();
    expect(choice).toMatchObject(existing);
    expect(bridge.pickDirectory).toHaveBeenCalledWith(true);
    expect(bridge.createVault).not.toHaveBeenCalled();

    if (choice === null)
      throw new Error('host did not return the selected vault');
    await choice.activate();
    expect(controller.openVault).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'froglight.tauri-vault' }),
      { vaultId: 'selected-existing', localVaultId: 'selected-existing' },
    );
    expect(controller.listDocuments).toHaveBeenCalledOnce();
    expect(bridge.markOpened).toHaveBeenCalledWith('selected-existing');
  });

  it('staging discard forgets recents only and never deletes physical data', async () => {
    const created = {
      id: 'native-staging-store',
      name: 'Physics',
      location: '/vaults/Physics',
      lastOpenedAt: 7,
    };
    const bridge: NativeVaultBridge = {
      listRecent: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue({
        id: 'parent',
        name: 'Files',
        location: 'Files',
        lastOpenedAt: 1,
      }),
      createVault: vi.fn().mockResolvedValue(created),
      markOpened: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
    };
    const controller = {
      openVault: vi.fn().mockResolvedValue(undefined),
      listDocuments: vi.fn().mockReturnValue([]),
    };
    const adapter = createNativeVaultAdapter(controller, bridge);
    const store = await adapter.createEmptyVaultStore?.('Physics');
    expect(store).not.toBeNull();
    expect(bridge.createVault).toHaveBeenCalledWith('parent', 'Physics');
    // Native policy: discard only forgets the temporary record. There is no
    // recursive-delete bridge call at all, and the raw staging vault is
    // materialized in place.
    await store!.discard();
    expect(bridge.forget).toHaveBeenCalledWith('native-staging-store');
    expect(controller.openVault).not.toHaveBeenCalled();

    // After activation, discard is a non-destructive no-op.
    const reopened = await adapter.createEmptyVaultStore?.('Physics');
    expect(reopened).not.toBeNull();
    await reopened!.activate();
    expect(controller.openVault).toHaveBeenCalledTimes(1);
    const forgetCalls = (bridge.forget as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await reopened!.discard();
    expect(
      (bridge.forget as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(forgetCalls);
  });

  it('rejects activation when the workspace capability did not come online', async () => {
    const existing = {
      id: 'mobile-vault:folder|',
      name: 'Research',
      location: 'Files',
      lastOpenedAt: 42,
    };
    const bridge: NativeVaultBridge = {
      listRecent: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue(existing),
      createVault: vi.fn(),
      markOpened: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
    };
    const controller = {
      openVault: vi.fn().mockResolvedValue(undefined),
      listDocuments: vi
        .fn()
        .mockImplementation(() => {
          throw new Error('workspace capability is unavailable');
        }),
    };
    const adapter = createNativeVaultAdapter(controller, bridge);
    const choice = await adapter.openVault();
    if (choice === null) throw new Error('expected selected vault');

    await expect(choice.activate()).rejects.toThrow(
      'workspace capability is unavailable',
    );
    expect(bridge.markOpened).not.toHaveBeenCalled();
  });
});
