/**
 * Per-vault dock layout persistence.
 *
 * The dock layout (pane tree, tab strips, active tabs, per-tab modes,
 * focus) is derived workspace state: it lives in a versioned record under
 * the vault's `.froglight/` area, preserves unknown fields, and rebuilds
 * from nothing if deleted. Writes are coalesced and skipped entirely when
 * the serialized record did not change.
 */

import {
  ensureDirectory,
  isVaultError,
  parseVersionedRecord,
  serializeVersionedRecord,
  stableStringify,
  vaultToken,
  type VaultService,
  type WorkspacePath,
} from '@froglight/foundation';
import { createServiceToken, definePlugin } from '@froglight/runtime';
import type { DockLayoutRecord } from './workbench-controller.js';

const DOCK_FORMAT = 'froglight.dock';
const DOCK_VERSION = 1;
const DOCK_KNOWN_KEYS = ['format', 'version', 'root', 'panes', 'focusedPane'] as const;
const FLUSH_DELAY_MS = 400;

export const DOCK_RECORD_PATH = '.froglight/dock.json' as WorkspacePath;

export interface DockLayoutStore {
  /** Load the persisted layout; `null` when absent, corrupt, or unsupported. */
  load(): Promise<DockLayoutRecord | null>;
  /** Persist the layout (coalesced; skipped when unchanged). */
  save(record: DockLayoutRecord): void;
  /** Persist pending changes now. */
  flush(): Promise<void>;
  /** Drop pending changes without writing. */
  cancel(): void;
  /** Flush best-effort and stop accepting writes. */
  dispose(): Promise<void>;
}

export class DockLayoutStoreImpl implements DockLayoutStore {
  readonly #vault: VaultService;
  #record: DockLayoutRecord | null = null;
  readonly #extras: Record<string, unknown>;
  #lastWritten: string | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #flushPromise: Promise<void> = Promise.resolve();
  #disposed = false;

  private constructor(vault: VaultService, record: DockLayoutRecord | null, extras: Record<string, unknown>) {
    this.#vault = vault;
    this.#record = record;
    this.#extras = extras;
    this.#lastWritten = record === null ? null : stableStringify(record);
  }

  /** Load the store from the vault; a missing/corrupt record means empty. */
  static async open(vault: VaultService): Promise<DockLayoutStoreImpl> {
    let data: Uint8Array;
    try {
      data = await vault.read(DOCK_RECORD_PATH);
    } catch (error) {
      if (isVaultError(error) && error.code === 'NOT_FOUND') {
        return new DockLayoutStoreImpl(vault, null, {});
      }
      throw error;
    }
    try {
      const { record, extras } = parseVersionedRecord<DockLayoutRecord>(
        data,
        DOCK_FORMAT,
        [DOCK_VERSION],
        DOCK_KNOWN_KEYS,
      );
      if (!isShapedRecord(record)) {
        return new DockLayoutStoreImpl(vault, null, { ...extras });
      }
      return new DockLayoutStoreImpl(vault, record, { ...extras });
    } catch {
      // A corrupt layout must never block startup; start with defaults.
      return new DockLayoutStoreImpl(vault, null, {});
    }
  }

  async load(): Promise<DockLayoutRecord | null> {
    return this.#record;
  }

  save(record: DockLayoutRecord): void {
    this.#assertActive();
    this.#record = record;
    this.#scheduleFlush();
  }

  flush(): Promise<void> {
    this.#assertActive();
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#flushPromise = this.#flushPromise.then(() => this.#write());
    return this.#flushPromise;
  }

  cancel(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  /** Dispose: flush pending changes best-effort, then stop accepting writes. */
  async dispose(): Promise<void> {
    this.cancel();
    try {
      await this.flush();
    } catch {
      // Best-effort on shutdown; state was already applied in memory.
    }
    this.#disposed = true;
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.flush().catch(() => undefined);
    }, FLUSH_DELAY_MS);
  }

  async #write(): Promise<void> {
    if (this.#disposed || this.#record === null) return;
    const serialized = stableStringify(this.#record);
    if (serialized === this.#lastWritten) return;
    await ensureDirectory(this.#vault, '.froglight' as WorkspacePath);
    const record = this.#record as DockLayoutRecord & Record<string, unknown>;
    const bytes = serializeVersionedRecord(record, this.#extras);
    await this.#vault.write(DOCK_RECORD_PATH, bytes);
    this.#lastWritten = serialized;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('dock layout store is disposed');
  }
}

function isShapedRecord(record: DockLayoutRecord): boolean {
  return Array.isArray(record.panes);
}

export const dockLayoutToken = createServiceToken<DockLayoutStore>('froglight.dock-layout');

/** Runtime binding: per-vault dock layout store, disposed with the vault. */
export const dockLayoutPlugin = definePlugin({
  id: 'froglight.dock-layout',
  requirements: { requires: [vaultToken] },
  activate: async (ctx) => {
    const vault = ctx.require(vaultToken);
    const store = await DockLayoutStoreImpl.open(vault);
    ctx.provide(dockLayoutToken, store);
    ctx.effect(() => () => void store.dispose());
  },
});
