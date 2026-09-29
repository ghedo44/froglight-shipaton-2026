import { invoke, type InvokeOptions } from '@tauri-apps/api/core';
import { bytesToBase64 } from './derived-cache-storage.js';
import {
  DEMO_VAULT_ID,
  installDemoVault,
  type WorkbenchController,
} from '@froglight/application';
import {
  VaultError,
  readVaultProfile,
  writeVaultProfile,
  type VaultAppearance,
  localVaultIdentity,
  localVaultIdentityToken,
  vaultToken,
  type VaultCapabilities,
  type VaultEntry,
  type VaultErrorCode,
  type VaultOperationOptions,
  type VaultService,
  type VaultStat,
  type WorkspacePath,
} from '@froglight/foundation';
import { definePlugin, type PluginConfig } from '@froglight/runtime';
import {
  isMobileVaultId,
  isMobileVaultUnsupported,
  mobileVaults,
} from './mobile-vault.js';
import type {
  EmptyVaultStore,
  VaultChoice,
  VaultCreateLocation,
  VaultHostAdapter,
} from '@froglight/ui';

export interface NativeVaultDescriptor {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly lastOpenedAt: number;
}

export interface NativeVaultBridge {
  demoVault?(): Promise<NativeVaultDescriptor>;
  listRecent(): Promise<readonly NativeVaultDescriptor[]>;
  pickDirectory(registerRecent: boolean): Promise<NativeVaultDescriptor | null>;
  createVault(parentId: string, name: string): Promise<NativeVaultDescriptor>;
  markOpened(id: string): Promise<void>;
  forget(id: string): Promise<void>;
}

type Invoke = <T>(
  command: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: InvokeOptions,
) => Promise<T>;

/**
 * The Tauri IPC surface only exists inside the Tauri webview. When the dev
 * server URL is opened in a plain browser tab, every bridge call would fail
 * with an opaque "reading 'invoke'" TypeError — fail with an actionable
 * message instead.
 */
function ensureTauriRuntime(): void {
  if (
    typeof window !== 'undefined' &&
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
      undefined
  ) {
    throw new Error(
      'The native host is not running: this dev server serves the Tauri app and must be opened through the Tauri shell (e.g. `pnpm tauri dev`), not directly in a browser. For browser use, run the web host instead.',
    );
  }
}

const defaultInvoke: Invoke = (command, args, options) => {
  ensureTauriRuntime();
  return invoke(command, args, options);
};

export function createTauriVaultBridge(
  call: Invoke = defaultInvoke,
): NativeVaultBridge {
  return {
    demoVault: () => call('native_vault_demo'),
    async listRecent() {
      ensureTauriRuntime();
      try {
        const mobile = await mobileVaults.listRecent();
        const internal = await call<NativeVaultDescriptor[]>(
          'native_vault_list_recent',
        );
        return [...mobile, ...internal];
      } catch (error) {
        if (!isMobileVaultUnsupported(error)) throw error;
        return call('native_vault_list_recent');
      }
    },
    async pickDirectory(registerRecent) {
      ensureTauriRuntime();
      try {
        return await mobileVaults.pickDirectory(registerRecent);
      } catch (error) {
        if (!isMobileVaultUnsupported(error)) throw error;
        return call('native_vault_pick_directory', { registerRecent });
      }
    },
    createVault: (parentId, name) => {
      ensureTauriRuntime();
      return isMobileVaultId(parentId)
        ? mobileVaults.createVault(parentId, name)
        : call('native_vault_create', { parentId, name });
    },
    markOpened: (id) => {
      ensureTauriRuntime();
      return isMobileVaultId(id)
        ? mobileVaults.markOpened(id)
        : call('native_vault_mark_opened', { id });
    },
    forget: (id) => {
      ensureTauriRuntime();
      return isMobileVaultId(id)
        ? mobileVaults.forget(id)
        : call('native_vault_forget', { id });
    },
  };
}

type VaultController = Pick<WorkbenchController, 'openVault' | 'listDocuments'>;

export function createNativeVaultAdapter(
  controller: VaultController,
  bridge: NativeVaultBridge = createTauriVaultBridge(),
  options: { readonly includeDemo?: boolean } = {},
): VaultHostAdapter {
  let demoId: string | null = null;
  const toChoice = (record: NativeVaultDescriptor): VaultChoice => ({
    ...record,
    async activate() {
      if (record.id === demoId)
        await installDemoVault(new TauriVault(record.id));
      // The physical backing id and the sync replica identity enter the
      // runtime together, so the sync attachment can never infer which
      // local vault was opened.
      await controller.openVault(tauriVaultPlugin, {
        vaultId: record.id,
        localVaultId: record.id === demoId ? DEMO_VAULT_ID : record.id,
      });
      controller.listDocuments();
      await bridge.markOpened(record.id).catch(() => undefined);
    },
  });

  async function profileChoice(
    record: NativeVaultDescriptor,
  ): Promise<VaultChoice> {
    try {
      const profile = await readVaultProfile(new TauriVault(record.id));
      return {
        ...toChoice(record),
        ...(profile === null ? {} : { profile, name: profile.name }),
      };
    } catch (error) {
      return {
        ...toChoice(record),
        profileError:
          error instanceof Error
            ? error.message
            : 'Could not read vault details.',
      };
    }
  }

  return {
    async openForBackup(id) {
      const record = (await bridge.listRecent()).find((item) => item.id === id);
      if (record === undefined) throw new Error('Vault is no longer available');
      return new TauriVault(record.id);
    },
    async listRecent() {
      if (
        options.includeDemo &&
        localStorage.getItem(`${DEMO_VAULT_ID}.hidden`) !== 'true' &&
        bridge.demoVault
      ) {
        demoId = (await bridge.demoVault()).id;
        await installDemoVault(new TauriVault(demoId));
      }
      return Promise.all((await bridge.listRecent()).map(profileChoice));
    },
    async chooseCreateLocation(): Promise<VaultCreateLocation | null> {
      const parent = await bridge.pickDirectory(false);
      if (parent === null) return null;
      return {
        label: parent.location,
        async create(name: string, appearance?: VaultAppearance) {
          const record = await bridge.createVault(parent.id, name);
          if (appearance !== undefined) {
            const vault = new TauriVault(record.id);
            if ((await readVaultProfile(vault)) !== null)
              throw new Error(
                'That folder already contains a vault. Open it to edit its details.',
              );
            await writeVaultProfile(vault, { name, ...appearance });
          }
          return profileChoice(record);
        },
      };
    },
    async createEmptyVaultStore(name: string): Promise<EmptyVaultStore | null> {
      const parent = await bridge.pickDirectory(false);
      if (parent === null) return null;
      // Raw backing store only: no workspace is opened inside it, so the
      // first materialization cannot merge against initialized metadata.
      const record = await bridge.createVault(parent.id, name);
      const choice = toChoice(record);
      // Ownership-safe lifecycle, native policy (fail-closed, deliberately
      // non-destructive — differs from web staging cleanup):
      //
      // - Web creates an unguessable `.froglight-download-<id>` directory
      //   and may recursive-delete it ONLY when state===staging AND
      //   ownedForDeletion===true AND the name matches the staging
      //   namespace; uncertain ownership degrades to forget-only.
      // - Native CANNOT prove exclusive temporary ownership through the
      //   IPC bridge (no exclusive-create + emptiness proof), so
      //   ownedForDeletion is effectively always false here: discard may
      //   only forget the transaction-owned staging record while still in
      //   staging; after activate() the vault is an opened user vault and
      //   discard is a non-destructive no-op. Native never recursively
      //   deletes physical user data. A true staging-dir deletion API can
      //   be added later once exclusive temporary ownership is provable on
      //   the bridge.
      let state: 'staging' | 'activated' | 'discarded' = 'staging';
      return {
        id: record.id,
        vault: new TauriVault(record.id),
        activate: async () => {
          if (state === 'discarded') return null;
          await choice.activate();
          state = 'activated';
          return profileChoice(record);
        },
        discard: async () => {
          // Best-effort: forget the fresh destination from recents. Never
          // delete user-created data and never throw to hide the primary
          // error — an unbound empty vault is harmless.
          try {
            if (state !== 'staging') return;
            state = 'discarded';
            await bridge.forget(record.id);
          } catch {
            // Swallow: cleanup must not hide download/activation failures.
          }
        },
      };
    },
    async openVault() {
      const selected = await bridge.pickDirectory(true);
      return selected === null ? null : profileChoice(selected);
    },
    forgetVault(id: string) {
      if (id === demoId)
        localStorage.setItem(`${DEMO_VAULT_ID}.hidden`, 'true');
      return bridge.forget(id);
    },
  };
}

interface TauriVaultPluginConfig extends PluginConfig {
  readonly vaultId: string;
  /** Host sync identity; defaults to the physical backing id. */
  readonly localVaultId?: string;
}

export const tauriVaultPlugin = definePlugin<TauriVaultPluginConfig>({
  id: 'froglight.tauri-vault',
  activate: (ctx) => {
    if (typeof ctx.config.vaultId !== 'string' || ctx.config.vaultId === '') {
      throw new Error('invalid native vault id');
    }
    ctx.provide(vaultToken, new TauriVault(ctx.config.vaultId));
    ctx.provide(
      localVaultIdentityToken,
      localVaultIdentity(ctx.config.localVaultId ?? ctx.config.vaultId),
    );
  },
});

interface NativeVaultErrorPayload {
  readonly code: VaultErrorCode;
  readonly message: string;
}

export class TauriVault implements VaultService {
  readonly capabilities: VaultCapabilities = {
    caseSensitivity: 'unknown',
    nameNormalization: 'none',
    atomicReplace: false,
    durableFlush: 'unknown',
    supportsMove: true,
    supportsReopen: true,
  };

  readonly #id: string;
  readonly #invoke: Invoke;

  constructor(id: string, call: Invoke = defaultInvoke) {
    this.#id = id;
    this.#invoke = call;
  }

  stat(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<VaultStat> {
    this.#assertActive(options, path);
    if (isMobileVaultId(this.#id)) {
      return this.#callMobile(path, () => mobileVaults.stat(this.#id, path));
    }
    return this.#call('native_vault_stat', { path });
  }

  list(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<readonly VaultEntry[]> {
    this.#assertActive(options, path);
    if (isMobileVaultId(this.#id)) {
      return this.#callMobile(path, () => mobileVaults.list(this.#id, path));
    }
    return this.#call('native_vault_list', { path });
  }

  createDirectory(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    this.#assertActive(options, path);
    if (isMobileVaultId(this.#id)) {
      return this.#callMobile(path, () =>
        mobileVaults.createDirectory(this.#id, path),
      );
    }
    return this.#call('native_vault_create_directory', { path });
  }

  async read(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<Uint8Array> {
    this.#assertActive(options, path);
    if (isMobileVaultId(this.#id)) {
      return this.#callMobile(path, () => mobileVaults.read(this.#id, path));
    }
    return new Uint8Array(
      await this.#call<ArrayBuffer>('native_vault_read', { path }),
    );
  }

  write(
    path: WorkspacePath,
    data: Uint8Array,
    options?: VaultOperationOptions,
  ): Promise<void> {
    this.#assertActive(options, path);
    if (isMobileVaultId(this.#id)) {
      return this.#callMobile(path, () =>
        mobileVaults.write(this.#id, path, data),
      );
    }
    return this.#writeBinary(path, data);
  }

  writeIfUnchanged(path: WorkspacePath, data: Uint8Array, checksum: string): Promise<void> {
    this.#assertActive(undefined, path);
    if (isMobileVaultId(this.#id)) return this.#callMobile(path, () => mobileVaults.write(this.#id, path, data, checksum));
    return this.#writeBinary(path, data, checksum);
  }

  async #writeBinary(path: WorkspacePath, data: Uint8Array, expectedChecksum?: string): Promise<void> {
    try {
      await this.#invoke('native_vault_write', data, { headers: {
        'x-froglight-vault-write': bytesToBase64(new TextEncoder().encode(JSON.stringify({ vaultId: this.#id, path, expectedChecksum }))),
      } });
    } catch (error) { const payload = asVaultError(error); throw new VaultError(payload.code, payload.message, { path, cause: error }); }
  }

  remove(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    this.#assertActive(options, path);
    if (isMobileVaultId(this.#id)) {
      return this.#callMobile(path, () => mobileVaults.remove(this.#id, path));
    }
    return this.#call('native_vault_remove', { path });
  }

  move(
    from: WorkspacePath,
    to: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    this.#assertActive(options, from);
    if (isMobileVaultId(this.#id)) {
      return this.#callMobile(from, () =>
        mobileVaults.move(this.#id, from, to),
      );
    }
    return this.#call('native_vault_move', { from, to });
  }

  #assertActive(
    options: VaultOperationOptions | undefined,
    path: WorkspacePath,
  ): void {
    if (options?.signal?.aborted) {
      throw new VaultError('ABORTED', 'operation aborted', { path });
    }
  }

  async #call<T>(command: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.#invoke<T>(command, { vaultId: this.#id, ...args });
    } catch (error) {
      const payload = asVaultError(error);
      throw new VaultError(payload.code, payload.message, {
        path:
          typeof args.path === 'string'
            ? (args.path as WorkspacePath)
            : typeof args.from === 'string'
              ? (args.from as WorkspacePath)
              : null,
        cause: error,
      });
    }
  }

  async #callMobile<T>(
    path: WorkspacePath,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const payload = asVaultError(error);
      throw new VaultError(payload.code, payload.message, {
        path,
        cause: error,
      });
    }
  }
}

/** Portable vault codes: the single source for the `isVaultErrorCode` guard. */
const PORTABLE_VAULT_CODES: readonly VaultErrorCode[] = [
  'INVALID_PATH',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'NOT_DIRECTORY',
  'IS_DIRECTORY',
  'PERMISSION_DENIED',
  'CONFLICT',
  'QUOTA_EXCEEDED',
  'UNSUPPORTED',
  'ABORTED',
  'IO',
];

/**
 * Native disk-full spellings that all mean QUOTA_EXCEEDED, so consumers can
 * distinguish "disk full" from other I/O errors. Listed once; the alias map
 * below is derived from this tuple.
 */
const QUOTA_NATIVE_SPELLINGS = [
  'QUOTA_EXCEEDED',
  'STORAGE_FULL',
  'ENOSPC',
  'EDQUOT',
] as const;

/** Host-specific codes translated at the IPC boundary (never exposed raw). */
const NATIVE_CODE_ALIASES: Record<string, VaultErrorCode> = {
  FOLDER_NOT_FOUND: 'NOT_FOUND',
  INVALID_ARGUMENT: 'INVALID_PATH',
  IO_ERROR: 'IO',
  NATIVE_ERROR: 'IO',
  STALE_BOOKMARK: 'PERMISSION_DENIED',
  ...Object.fromEntries(
    QUOTA_NATIVE_SPELLINGS.map(
      (spelling) => [spelling, 'QUOTA_EXCEEDED' as VaultErrorCode] as const,
    ),
  ),
};

function asVaultError(error: unknown): NativeVaultErrorPayload {
  if (typeof error === 'object' && error !== null) {
    const value = error as { code?: unknown; message?: unknown };
    if (isVaultErrorCode(value.code) && typeof value.message === 'string') {
      return { code: value.code, message: value.message };
    }
    if (typeof value.code === 'string' && typeof value.message === 'string') {
      const mapped = NATIVE_CODE_ALIASES[value.code] as
        | VaultErrorCode
        | undefined;
      if (mapped) return { code: mapped, message: value.message };
    }
  }
  return {
    code: 'IO',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isVaultErrorCode(value: unknown): value is VaultErrorCode {
  return (
    typeof value === 'string' &&
    (PORTABLE_VAULT_CODES as readonly string[]).includes(value)
  );
}
