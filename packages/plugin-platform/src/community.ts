/**
 * CommunityPluginManager — product-facing lifecycle for vault-loaded
 * community plugins.
 *
 * Vault-loaded code runs in the application realm and is therefore trusted.
 * The permission broker controls access through Froglight's plugin facades;
 * it does not restrict ambient JavaScript capabilities. This manager does not
 * run plugins through the separate Worker host.
 *
 * Lifecycle rules:
 * - enablement intent persists in `.froglight/plugins.json` (vault record);
 * - every activation is effect-owned by a `community:<id>` slot, so disable,
 *   vault close, or safe mode leave zero registrations behind;
 * - activation failures are attributed to a CrashLoopTracker; a plugin that
   keeps failing is parked (`disabledBySafeMode`) so it cannot break startup;
 * - safe mode blocks every community plugin until explicitly turned off.
 */

import {
  createServiceToken,
  definePlugin,
  type PluginDefinition,
  type Runtime,
} from '@froglight/runtime';
import {
  commandsToken,
  settingsToken,
  vaultToken,
  blockRegistryToken,
  documentRegistryToken,
  propertyCatalogToken,
  type VaultService,
} from '@froglight/foundation';
import { markdownEditorProviderToken } from '@froglight/foundation';
import type { PluginManifest } from './manifest.js';
import { PermissionBroker } from './permissions.js';
import {
  createSdkFacades,
  uiViewsToken,
  uiSettingsToken,
  type SdkFacades,
} from './facades.js';
import { communityToolbarToken } from './toolbar.js';
import { CrashLoopTracker } from './crash-loop.js';
import { VaultPluginStore } from './vault-store.js';

/**
 * The activate function a plugin module exports. It receives broker-checked
 * facades and may return a disposer that the runtime owns.
 */
export type SdkActivateFn = (
  facades: SdkFacades,
  manifest: PluginManifest,
) => void | (() => void) | Promise<void | (() => void)>;

/**
 * Turns plugin source text into an activate function. Production uses blob
 * URL dynamic import; tests inject deterministic loaders. The seam keeps
 * evaluation strategy swappable without changing lifecycle semantics.
 */
export type PluginCodeLoader = (
  code: string,
  manifest: PluginManifest,
) => Promise<SdkActivateFn>;

/** Default loader for browser/Tauri webviews: ESM via blob object URL. */
export const blobModuleLoader: PluginCodeLoader = async (code) => {
  const blob = new Blob([code], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    const module = (await import(/* @vite-ignore */ url)) as {
      default?: unknown;
      activate?: unknown;
    };
    const activate = module.default ?? module.activate;
    if (typeof activate !== 'function') {
      throw new Error(
        'plugin main.js must export an activate function (default or named "activate")',
      );
    }
    return activate as SdkActivateFn;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Observed state of one community plugin, as shown in settings/devtools. */
export type CommunityPluginState =
  | 'active'
  | 'failed'
  | 'disabled'
  | 'blocked-safe-mode'
  | 'blocked-crash-loop';

export interface CommunityPluginInfo {
  readonly id: string;
  readonly state: CommunityPluginState;
  readonly manifest: PluginManifest | null;
  /** Validation/load error detail when the plugin cannot run. */
  readonly error: string | null;
}

export interface CommunityPluginManagerOptions {
  readonly runtime: Runtime;
  readonly loader?: PluginCodeLoader;
  readonly tracker?: CrashLoopTracker;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class CommunityPluginManager {
  readonly #runtime: Runtime;
  #loader: PluginCodeLoader;
  readonly #tracker: CrashLoopTracker;
  /** Code is loaded by same-realm dynamic import and is therefore trusted. */
  readonly #tier = 'trusted' as const;
  readonly #timeoutMs: number;
  readonly #clock: () => number;
  #store: VaultPluginStore | null = null;
  #safeMode = false;
  #lastAttachError: string | null = null;
  #ready: Promise<void> = Promise.resolve();
  #operations: Promise<void> = Promise.resolve();

  constructor(options: CommunityPluginManagerOptions) {
    this.#runtime = options.runtime;
    this.#loader = options.loader ?? blobModuleLoader;
    this.#tracker = options.tracker ?? new CrashLoopTracker();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#clock = options.clock ?? Date.now;
  }

  get safeMode(): boolean {
    return this.#safeMode;
  }

  get attached(): boolean {
    return this.#store !== null;
  }

  /** Error from the last attach, if any; surfaced for settings UI display. */
  get lastAttachError(): string | null {
    return this.#lastAttachError;
  }

  /**
   * Resolves when the most recent attach finished reconciling. Callers inside
   * a runtime activation must NOT await attach() itself — registering slots
   * while a reconcile pass is in flight deadlocks — but may await this.
   */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Swap the code loader (tests inject deterministic loaders). */
  setLoader(loader: PluginCodeLoader): void {
    this.#loader = loader;
  }

  /**
   * Attach to a freshly opened vault: creates the store, loads persisted
   * state, and reconciles enabled plugins into runtime slots.
   */
  attach(vault: VaultService): Promise<void> {
    const work = this.#enqueue(async () => {
      try {
        if (this.#store !== null) await this.#removeAllCommunitySlots();
        this.#store = new VaultPluginStore(vault);
        const state = await this.#store.loadState();
        this.#safeMode = state.disabledBySafeMode.includes(SAFE_MODE_SENTINEL);
        // Persisted crash-loop parks are honored on every boot.
        for (const id of state.disabledBySafeMode) {
          if (id === SAFE_MODE_SENTINEL) continue;
          this.#tracker.record({
            slotId: slotIdFor(id),
            atMillis: this.#clock(),
            phase: 'boot',
            message: 'parked by previous crash-loop protection',
          });
        }
        if (!this.#safeMode) {
          this.#tracker.recordBootSuccess();
        }
        await this.#sync();
        this.#lastAttachError = null;
      } catch (error) {
        this.#lastAttachError =
          error instanceof Error ? error.message : String(error);
      }
    });
    this.#ready = work;
    return work;
  }

  /** Detach from the current vault: unload everything, release the store. */
  detach(attachment?: Promise<void>): Promise<void> {
    return this.#enqueue(async () => {
      if (attachment !== undefined && attachment !== this.#ready) return;
      await this.#removeAllCommunitySlots();
      this.#store = null;
      this.#safeMode = false;
    });
  }

  /** Re-scan the vault and reconcile runtime slots with enablement intent. */
  sync(): Promise<void> {
    return this.#enqueue(() => this.#sync());
  }

  list(): CommunityPluginInfo[] {
    return this.#infos;
  }

  #infos: CommunityPluginInfo[] = [];

  install(input: {
    manifestJson: unknown;
    code: string;
  }): Promise<PluginManifest> {
    return this.#enqueue(async () => {
      const manifest = await this.#requireStore().install(input);
      await this.#sync();
      return manifest;
    });
  }

  remove(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const store = this.#requireStore();
      const state = await store.loadState();
      await store.saveState({
        ...state,
        enabled: state.enabled.filter((entry) => entry !== id),
      });
      await this.#removeSlot(id);
      await store.remove(id);
      await this.#sync();
    });
  }

  enable(id: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#safeMode)
        throw new Error(`cannot enable ${id} while safe mode is on`);
      if (this.#tracker.isCrashLoop(slotIdFor(id)))
        this.#tracker.clear(slotIdFor(id));
      const store = this.#requireStore();
      const state = await store.loadState();
      await store.saveState({
        ...state,
        enabled: unique([...state.enabled.filter((entry) => entry !== id), id]),
        disabledBySafeMode: state.disabledBySafeMode.filter(
          (entry) => entry !== id,
        ),
      });
      await this.#sync();
    });
  }

  disable(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const store = this.#requireStore();
      const state = await store.loadState();
      await store.saveState({
        ...state,
        enabled: state.enabled.filter((entry) => entry !== id),
      });
      await this.#removeSlot(id);
      await this.#sync();
    });
  }

  setSafeMode(on: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const store = this.#requireStore();
      const state = await store.loadState();
      const disabledBySafeMode = state.disabledBySafeMode.filter(
        (entry) => entry !== SAFE_MODE_SENTINEL,
      );
      await store.saveState({
        ...state,
        disabledBySafeMode: on
          ? unique([...disabledBySafeMode, SAFE_MODE_SENTINEL])
          : disabledBySafeMode,
      });
      await this.#sync();
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#operations.then(operation);
    this.#operations = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  async #removeSlot(id: string): Promise<void> {
    const slotId = slotIdFor(id);
    if (this.#runtime.inspect().slots.some((slot) => slot.id === slotId)) {
      await this.#runtime.removeSlot(slotId);
    }
  }

  async #removeAllCommunitySlots(): Promise<void> {
    for (const slot of this.#runtime.inspect().slots) {
      if (slot.id.startsWith(COMMUNITY_SLOT_PREFIX)) {
        // Global disposal owns every slot once the runtime stops accepting
        // removals. Vault withdrawal while running still removes them here.
        if (this.#runtime.inspect().runtimeState !== 'running') break;
        try {
          await this.#runtime.removeSlot(slot.id);
        } catch (error) {
          if (this.#runtime.inspect().runtimeState === 'running') throw error;
        }
      }
    }
    this.#infos = [];
  }

  #requireStore(): VaultPluginStore {
    if (this.#store === null) {
      throw new Error('community plugin manager is not attached to a vault');
    }
    return this.#store;
  }

  async #sync(): Promise<void> {
    const store = this.#requireStore();
    const [installed, state] = await Promise.all([
      store.listInstalled(),
      store.loadState(),
    ]);
    this.#safeMode = state.disabledBySafeMode.includes(SAFE_MODE_SENTINEL);

    if (this.#safeMode) {
      await this.#removeAllCommunitySlots();
      this.#infos = installed.map((plugin) => ({
        id: plugin.id,
        state: 'blocked-safe-mode' as const,
        manifest: plugin.manifest,
        error: plugin.error,
      }));
      return;
    }

    const enabledSet = new Set(state.enabled);
    const parkedSet = new Set(state.disabledBySafeMode);
    const desired = new Set(
      installed
        .filter(
          (plugin) =>
            plugin.error === null &&
            plugin.manifest !== null &&
            plugin.hasCode &&
            enabledSet.has(plugin.id) &&
            !parkedSet.has(plugin.id),
        )
        .map((plugin) => slotIdFor(plugin.id)),
    );
    for (const slot of this.#runtime.inspect().slots) {
      if (slot.id.startsWith(COMMUNITY_SLOT_PREFIX) && !desired.has(slot.id)) {
        await this.#runtime.removeSlot(slot.id);
      }
    }
    const infos: CommunityPluginInfo[] = [];

    for (const plugin of installed) {
      const slotId = slotIdFor(plugin.id);

      if (
        plugin.error !== null ||
        plugin.manifest === null ||
        !plugin.hasCode
      ) {
        infos.push({
          id: plugin.id,
          state: 'failed',
          manifest: plugin.manifest,
          error: plugin.error ?? (plugin.hasCode ? null : 'missing main.js'),
        });
        continue;
      }
      if (parkedSet.has(plugin.id)) {
        // Persisted park: stays blocked until the user explicitly re-enables.
        infos.push({
          id: plugin.id,
          state: 'blocked-crash-loop',
          manifest: plugin.manifest,
          error: null,
        });
        continue;
      }
      if (!enabledSet.has(plugin.id)) {
        infos.push({
          id: plugin.id,
          state: 'disabled',
          manifest: plugin.manifest,
          error: null,
        });
        continue;
      }

      // Enabled → ensure a live slot; failures are attributed, not fatal.
      const failure = await this.#activateSlot(
        store,
        plugin.id,
        plugin.manifest,
        slotId,
      );
      infos.push(
        failure === null
          ? {
              id: plugin.id,
              state: 'active',
              manifest: plugin.manifest,
              error: null,
            }
          : {
              id: plugin.id,
              state: 'failed',
              manifest: plugin.manifest,
              error: failure,
            },
      );
    }
    this.#infos = infos.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Returns an error message when activation failed, else null. */
  async #activateSlot(
    store: VaultPluginStore,
    id: string,
    manifest: PluginManifest,
    slotId: string,
  ): Promise<string | null> {
    const alreadyActive = this.#runtime
      .inspect()
      .slots.some((slot) => slot.id === slotId);
    if (!alreadyActive) {
      let code: string;
      try {
        code = await store.readCode(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#recordFailure(slotId, message);
        return message;
      }
      const definition = this.#buildPluginDefinition(manifest, code);
      try {
        await this.#runtime.registerSlot({ id: slotId, plugin: definition });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#recordFailure(slotId, message);
        return message;
      }
    }

    // Post-quiescence attribution: failed slots carry their failure reason.
    const snapshot = this.#runtime.inspect();
    const slot = snapshot.slots.find((entry) => entry.id === slotId);
    if (slot?.state === 'failed') {
      const message = slot.failure?.message ?? `activation failed`;
      this.#recordFailure(slotId, message);
      // A plugin whose fiber failed must not linger half-registered.
      await this.#removeSlot(id);
      // Crash-loop parking: once the threshold trips, persist the park so
      // the plugin cannot break future startups. The mark stays until the
      // user explicitly re-enables.
      if (this.#tracker.isCrashLoop(slotId)) {
        const fresh = await store.loadState();
        if (!fresh.disabledBySafeMode.includes(id)) {
          await store.saveState({
            ...fresh,
            enabled: fresh.enabled.filter((entry) => entry !== id),
            disabledBySafeMode: [...fresh.disabledBySafeMode, id],
          });
        }
      }
      return message;
    }
    return null;
  }

  #recordFailure(slotId: string, message: string): void {
    this.#tracker.record({
      slotId,
      atMillis: this.#clock(),
      phase: 'activation',
      message,
    });
  }

  /**
   * The slot-level plugin definition for one community plugin. Requirements
   * pin it to the vault so reconciliation disposes it automatically when the
   * vault closes; all capabilities flow through brokered facades.
   */
  #buildPluginDefinition(
    manifest: PluginManifest,
    code: string,
  ): PluginDefinition {
    const broker = new PermissionBroker(manifest, this.#tier);
    const loader = this.#loader;
    const timeoutMs = this.#timeoutMs;

    return definePlugin({
      id: manifest.id,
      requirements: { requires: [vaultToken] },
      activate: async (ctx) => {
        // Registrations made through the facades become fiber-owned effects
        // the moment they happen, so dispose → zero registrations holds even
        // when activation later throws or times out (the runtime's rollback
        // disposes every effect the fiber already acquired).
        const facades = createSdkFacades({
          broker,
          tier: this.#tier,
          services: {
            vault: ctx.try(vaultToken),
            commands: ctx.try(commandsToken),
            settings: ctx.try(settingsToken),
            uiViews: ctx.try(uiViewsToken),
            uiSettings: ctx.try(uiSettingsToken),
            editorProvider: ctx.try(markdownEditorProviderToken),
            blocks: ctx.try(blockRegistryToken),
            toolbar: ctx.try(communityToolbarToken),
            documents: ctx.try(documentRegistryToken),
            propertyCatalog: ctx.try(propertyCatalogToken),
          },
          onRegistration: (dispose) => {
            ctx.effect(() => dispose);
          },
        });

        // A broken plugin file fails this fiber — never the manager or boot.
        const activateFn = await loader(code, manifest);

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        // The swallowed catch only prevents a late unhandled rejection when
        // the timeout below wins the race; the failure itself is attributed
        // through the slot state and the crash-loop tracker.
        const work = (async () => activateFn(facades, manifest))();
        work.catch(() => undefined);
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`activation timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });
        let disposer: void | (() => void);
        try {
          disposer = await Promise.race([work, timeout]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
        if (typeof disposer === 'function') {
          ctx.effect(() => disposer!);
        }
      },
    });
  }
}

const COMMUNITY_SLOT_PREFIX = 'community:';
const SAFE_MODE_SENTINEL = '__safe-mode__';

function slotIdFor(pluginId: string): string {
  return `${COMMUNITY_SLOT_PREFIX}${pluginId}`;
}

/**
 * Capability token for the community plugin catalog. The manager is provided
 * by a host-registered binding while a vault is open, so settings UI can
 * depend on the contract rather than on host wiring details.
 */
export const communityPluginsToken = createServiceToken<CommunityPluginManager>(
  'froglight.community-plugins',
);

/**
 * Runtime binding that scopes community plugin loading to an open vault:
 * attach on vault activation, detach (unloading every community fiber) when
 * the vault is withdrawn or replaced.
 */
export function communityPluginsBinding(
  manager: CommunityPluginManager,
): PluginDefinition {
  return definePlugin({
    id: 'froglight.community-plugins.binding',
    requirements: { requires: [vaultToken] },
    activate: async (ctx) => {
      const vault = ctx.require(vaultToken);
      ctx.provide(communityPluginsToken, manager);
      // Attach must not be awaited inside activation: it registers community
      // slots, which would await a reconcile pass that includes this fiber.
      // It runs concurrently; consumers can await manager.ready. Attach
      // failures are captured on the manager, not thrown into the runtime —
      // broken plugins must never break startup.
      const attachment = manager.attach(vault);
      // Effect-owned teardown: closing/switching vaults leaves zero
      // community registrations behind.
      ctx.effect({
        dispose: () => manager.detach(attachment),
      });
    },
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
