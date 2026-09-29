/**
 * Namespaced key/value settings store.
 *
 * Keys are dot-namespaced (`area.name`), so settings remain collision-free
 * across plugins without a central registry.
 */

import { FroglightError } from './errors.js';

/** Valid settings key: at least two dot-separated `[A-Za-z0-9_-]+` segments. */
const SETTINGS_KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

export type SettingsValue = string | number | boolean | null;

export function isValidSettingsKey(value: unknown): value is string {
  return typeof value === 'string' && SETTINGS_KEY_PATTERN.test(value);
}

export function assertSettingsKey(value: unknown): asserts value is string {
  if (!isValidSettingsKey(value)) {
    throw new FroglightError('INVALID_SETTINGS_KEY', `invalid settings key: ${JSON.stringify(value)}`);
  }
}

export interface SettingsService {
  /** Get a value; `undefined` when unset. */
  get(key: string): SettingsValue | undefined;
  /** Set a value; invalid keys throw `INVALID_SETTINGS_KEY`. */
  set(key: string, value: SettingsValue): void;
  /** Remove a key; no-op when absent. */
  remove(key: string): void;
  /** All key/value entries. */
  entries(): ReadonlyMap<string, SettingsValue>;
  /** Subscribe to changes; returns a disposer. */
  onChange(listener: (key: string, value: SettingsValue | undefined) => void): Disposer;
}

export interface Disposer {
  readonly dispose: () => void;
}

/** In-memory settings store. */
export class InMemorySettingsService implements SettingsService {
  readonly #values = new Map<string, SettingsValue>();
  readonly #listeners = new Set<(key: string, value: SettingsValue | undefined) => void>();

  get(key: string): SettingsValue | undefined {
    return this.#values.get(key);
  }

  set(key: string, value: SettingsValue): void {
    assertSettingsKey(key);
    this.#values.set(key, value);
    this.#emit(key, value);
  }

  remove(key: string): void {
    if (this.#values.delete(key)) {
      this.#emit(key, undefined);
    }
  }

  entries(): ReadonlyMap<string, SettingsValue> {
    return new Map(this.#values);
  }

  onChange(listener: (key: string, value: SettingsValue | undefined) => void): Disposer {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  #emit(key: string, value: SettingsValue | undefined): void {
    for (const listener of [...this.#listeners]) {
      listener(key, value);
    }
  }
}
