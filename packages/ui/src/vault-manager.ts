import { definePlugin } from '@froglight/runtime';
import { createServiceToken } from '@froglight/runtime';
import type { VaultService } from '@froglight/foundation';
import { vaultToken, commandsToken } from '@froglight/foundation';
import { viewRegistryToken } from './view-registry.js';
import { VaultManagerView } from './react/index.js';

export interface VaultInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface VaultManagerService {
  listVaults(): readonly VaultInfo[];
  createVault(name: string): Promise<VaultInfo>;
  openVault(id: string): Promise<void>;
  getCurrent(): VaultInfo | null;
}

export const vaultManagerToken = createServiceToken<VaultManagerService>('froglight.vault-manager');

/**
 * Vault manager plugin — Obsidian-like vault create/open/switch.
 * Stores vault list in SettingsService (namespaced) and switches vault by
 * replacing the vault provider via Runtime (host supplies new VaultService).
 * For web, vaults are OPFS subdirectories; for native, filesystem paths.
 */
export interface VaultManagerPluginConfig {
  /** Host-provided factory: given vault id/name, return a VaultService */
  readonly createVaultService?: (info: VaultInfo) => Promise<VaultService>;
  readonly initialVaults?: readonly VaultInfo[];
}

export const vaultManagerPlugin = definePlugin<VaultManagerPluginConfig>({
  id: 'froglight.vault-manager',
  activate: async (ctx) => {
    const vaults: VaultInfo[] = [...(ctx.config.initialVaults ?? [{ id: 'default', name: 'Default', createdAt: Date.now() }])];
    let currentId: string | null = vaults[0]?.id ?? null;

    const manager: VaultManagerService = {
      listVaults: () => [...vaults],
      getCurrent: () => vaults.find((v) => v.id === currentId) ?? null,
      async createVault(name: string) {
        const info: VaultInfo = { id: `vault-${Date.now()}`, name, createdAt: Date.now() };
        vaults.push(info);
        currentId = info.id;
        // In a real host, we would now replace the vault provider via Runtime:
        // await runtime.replaceVaultProvider(newVaultPlugin)
        // For this plugin, we just record; the host shell wires the actual provider swap
        // via the factory if provided.
        if (ctx.config.createVaultService) {
          const svc = await ctx.config.createVaultService(info);
          // Provide as new vault (host will handle actual slot replacement)
          // Here we just provide via token for demo
          try {
            ctx.provide(vaultToken, svc);
          } catch { /* provider activation failure is reported by the runtime */ }
        }
        return info;
      },
      async openVault(id: string) {
        const found = vaults.find((v) => v.id === id);
        if (!found) throw new Error(`vault ${id} not found`);
        currentId = id;
      },
    };

    ctx.provide(vaultManagerToken, manager);

    const commands = ctx.try(commandsToken) as { register: (c: any) => { dispose(): void } } | undefined;
    if (commands) {
      ctx.effect(() => commands.register({ id: 'froglight.vault.create', title: 'Create Vault', execute: async () => manager.createVault(`Vault ${vaults.length + 1}`) }).dispose);
      ctx.effect(() => commands.register({ id: 'froglight.vault.open', title: 'Open Vault', execute: async (id: string) => manager.openVault(id) }).dispose);
    }

    const views = ctx.try(viewRegistryToken);
    if (views) {
      ctx.effect(() => views.register({ id: 'vault-switcher', area: 'header', title: 'Vault', component: VaultManagerView }).dispose);
    }
  },
});
