/**
 * Persistent settings service: `InMemorySettingsService` behavior with a
 * envelope bridge so Ink/Notebook/Whiteboard tool presets survive
 * full application restarts.
 *
 * This module never touches browser or host storage APIs. Persistence is
 * injected:
 * - `storage` option provides a synchronous key/value bridge (host apps or
 *   providers supply the host-backed implementation);
 * - without injection the service is memory-only (tests/headless).
 * - the workspace plugin additionally syncs through the Vault capability
 *   (see plugins/workspace.ts), which needs no browser APIs.
 *
 * Design constraints (writing-system production gate):
 * - One versioned envelope (`{ version: 1, values: {...} }`): absent/
 *   malformed/partial payloads degrade field-by-field, never corrupting or
 *   discarding unrelated preferences.
 * - Writes occur only on explicit preset/UI actions (never per stylus
 *   sample), so synchronous bridges are safe on the settings path.
 * - Unknown future keys round-trip verbatim inside `values`.
 */

import {
  InMemorySettingsService,
  assertSettingsKey,
  type SettingsService,
  type SettingsValue,
  type Disposer,
} from './settings.js';

export const PERSISTENT_SETTINGS_STORAGE_KEY = 'froglight.settings';
export const PERSISTENT_SETTINGS_VERSION = 1;

export interface PersistentSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readEnvelope(
  storage: PersistentSettingsStorage,
  key: string,
): Record<string, SettingsValue> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return {};
  }
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    if (record.version !== PERSISTENT_SETTINGS_VERSION) return {};
    const values = record.values;
    if (typeof values !== 'object' || values === null) return {};
    const out: Record<string, SettingsValue> = {};
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean' ||
        v === null
      ) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Settings service with restart persistence. Behaves exactly like
 * `InMemorySettingsService` when no storage is available (tests/headless).
 */
export class PersistentSettingsService implements SettingsService {
  readonly #inner = new InMemorySettingsService();
  readonly #storage: PersistentSettingsStorage | null;
  readonly #key: string;

  constructor(
    options: {
      readonly storage?: PersistentSettingsStorage | null;
      readonly key?: string;
    } = {},
  ) {
    // Memory-only unless a host/provider bridge is injected: this module
    // must not reference browser storage directly (architecture guardrail).
    this.#storage = options.storage ?? null;
    this.#key = options.key ?? PERSISTENT_SETTINGS_STORAGE_KEY;
    if (this.#storage !== null) {
      for (const [k, v] of Object.entries(readEnvelope(this.#storage, this.#key))) {
        try {
          assertSettingsKey(k);
          this.#inner.set(k, v);
        } catch {
          // Invalid keys from storage never break startup.
        }
      }
    }
  }

  get(key: string): SettingsValue | undefined {
    return this.#inner.get(key);
  }

  set(key: string, value: SettingsValue): void {
    this.#inner.set(key, value);
    this.#persist();
  }

  remove(key: string): void {
    this.#inner.remove(key);
    this.#persist();
  }

  entries(): ReadonlyMap<string, SettingsValue> {
    return this.#inner.entries();
  }

  onChange(listener: (key: string, value: SettingsValue | undefined) => void): Disposer {
    return this.#inner.onChange(listener);
  }

  #persist(): void {
    if (this.#storage === null) return;
    try {
      const values: Record<string, SettingsValue> = {};
      for (const [k, v] of this.#inner.entries()) values[k] = v;
      this.#storage.setItem(
        this.#key,
        JSON.stringify({ version: PERSISTENT_SETTINGS_VERSION, values }),
      );
    } catch {
      // Quota/denied storage must never break preset edits.
    }
  }
}
