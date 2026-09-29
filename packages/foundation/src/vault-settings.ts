/**
 * Sole vault-backed owner of workspace settings.
 *
 * The service keeps one live map for every settings consumer and serializes
 * writes to `.froglight/settings.json`. Unknown envelope fields and values
 * that this version cannot expose through the primitive SettingsService
 * contract survive rewrites verbatim.
 */

import { ErrorCodes, FroglightError, isVaultError } from './errors.js';
import { utf8Decode } from './encoding.js';
import {
  assertSettingsKey,
  type Disposer,
  type SettingsService,
  type SettingsValue,
} from './settings.js';
import { ensureDirectory } from './vault/helpers.js';
import { serializeVersionedRecord } from './records.js';
import type { WorkspacePath } from './paths.js';
import type { VaultService } from './vault/contract.js';

export const SETTINGS_RECORD_PATH = '.froglight/settings.json' as WorkspacePath;
export const SETTINGS_RECORD_FORMAT = 'froglight.settings';
export const SETTINGS_RECORD_VERSION = 1;

interface DecodedSettingsRecord {
  readonly values: Record<string, SettingsValue>;
  readonly preservedValues: Record<string, unknown>;
  readonly extras: Record<string, unknown>;
}

function decodeSettingsRecord(bytes: Uint8Array): DecodedSettingsRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch {
    return { values: {}, preservedValues: {}, extras: {} };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { values: {}, preservedValues: {}, extras: {} };
  }
  const record = parsed as Record<string, unknown>;
  // The former Foundation writer omitted `format`. Accept that one exact
  // pre-release shape so already-saved presets are migrated without loss.
  if (record.format !== undefined && record.format !== SETTINGS_RECORD_FORMAT) {
    throw new FroglightError(
      ErrorCodes.RECORD_FORMAT_MISMATCH,
      `expected format ${JSON.stringify(SETTINGS_RECORD_FORMAT)}, got ${JSON.stringify(record.format)}`,
    );
  }
  if (record.version !== SETTINGS_RECORD_VERSION) {
    throw new FroglightError(
      ErrorCodes.RECORD_VERSION_UNSUPPORTED,
      `unsupported settings record version ${JSON.stringify(record.version)}`,
    );
  }
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!['format', 'version', 'values'].includes(key)) extras[key] = value;
  }
  const storedValues = record.values;
  if (
    typeof storedValues !== 'object' ||
    storedValues === null ||
    Array.isArray(storedValues)
  ) {
    return { values: {}, preservedValues: {}, extras };
  }
  const preservedValues = {
    ...(storedValues as Record<string, unknown>),
  };
  const values: Record<string, SettingsValue> = {};
  for (const [key, value] of Object.entries(preservedValues)) {
    try {
      assertSettingsKey(key);
    } catch {
      continue;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      values[key] = value;
    }
  }
  return { values, preservedValues, extras };
}

export class VaultSettingsService implements SettingsService {
  readonly #vault: VaultService;
  readonly #values = new Map<string, SettingsValue>();
  readonly #preservedValues: Record<string, unknown>;
  readonly #extras: Record<string, unknown>;
  readonly #listeners = new Set<
    (key: string, value: SettingsValue | undefined) => void
  >();
  #revision = 0;
  #persistedRevision = 0;
  #flushPromise: Promise<void> | null = null;
  #disposed = false;

  private constructor(vault: VaultService, decoded: DecodedSettingsRecord) {
    this.#vault = vault;
    this.#preservedValues = decoded.preservedValues;
    this.#extras = decoded.extras;
    for (const [key, value] of Object.entries(decoded.values)) {
      this.#values.set(key, value);
    }
  }

  static async open(vault: VaultService): Promise<VaultSettingsService> {
    try {
      const bytes = await vault.read(SETTINGS_RECORD_PATH);
      return new VaultSettingsService(vault, decodeSettingsRecord(bytes));
    } catch (error) {
      if (isVaultError(error) && error.code === 'NOT_FOUND') {
        return new VaultSettingsService(vault, {
          values: {},
          preservedValues: {},
          extras: {},
        });
      }
      throw error;
    }
  }

  get(key: string): SettingsValue | undefined {
    return this.#values.get(key);
  }

  set(key: string, value: SettingsValue): void {
    this.#assertActive();
    assertSettingsKey(key);
    if (this.#values.get(key) === value) return;
    this.#values.set(key, value);
    this.#preservedValues[key] = value;
    this.#emit(key, value);
    this.#markDirty();
  }

  remove(key: string): void {
    this.#assertActive();
    const exposed = this.#values.delete(key);
    const preserved = Object.hasOwn(this.#preservedValues, key);
    if (!exposed && !preserved) return;
    delete this.#preservedValues[key];
    if (exposed) this.#emit(key, undefined);
    this.#markDirty();
  }

  entries(): ReadonlyMap<string, SettingsValue> {
    return new Map(this.#values);
  }

  onChange(
    listener: (key: string, value: SettingsValue | undefined) => void,
  ): Disposer {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  /** Resolve after every change observed before or during this flush is saved. */
  flush(): Promise<void> {
    this.#assertActive();
    if (this.#flushPromise !== null) return this.#flushPromise;
    if (this.#persistedRevision === this.#revision) return Promise.resolve();
    const pending = this.#drainWrites();
    this.#flushPromise = pending;
    void pending.then(
      () => {
        if (this.#flushPromise !== pending) return;
        this.#flushPromise = null;
        if (this.#persistedRevision < this.#revision) {
          void this.flush().catch(() => undefined);
        }
      },
      () => {
        if (this.#flushPromise === pending) this.#flushPromise = null;
      },
    );
    return pending;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.flush();
    this.#disposed = true;
    this.#listeners.clear();
  }

  #markDirty(): void {
    this.#revision += 1;
    void this.flush().catch(() => undefined);
  }

  async #drainWrites(): Promise<void> {
    await ensureDirectory(this.#vault, '.froglight' as WorkspacePath);
    while (this.#persistedRevision < this.#revision) {
      const targetRevision = this.#revision;
      const record = {
        format: SETTINGS_RECORD_FORMAT,
        version: SETTINGS_RECORD_VERSION,
        values: { ...this.#preservedValues },
      };
      await this.#vault.write(
        SETTINGS_RECORD_PATH,
        serializeVersionedRecord(record, this.#extras),
      );
      this.#persistedRevision = targetRevision;
    }
  }

  #emit(key: string, value: SettingsValue | undefined): void {
    for (const listener of [...this.#listeners]) listener(key, value);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new FroglightError(
        ErrorCodes.SERVICE_DISPOSED,
        'workspace settings service is disposed',
      );
    }
  }
}
