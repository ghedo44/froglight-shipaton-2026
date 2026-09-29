/**
 * Vault-backed storage for community plugins.
 *
 * Plugins live inside the vault — the same place user notes live — so the
 * model is identical on every host (OPFS, native folder, memory):
 *
 *   .froglight/plugins/<plugin-id>/manifest.json
 *   .froglight/plugins/<plugin-id>/main.js
 *   .froglight/plugins.json                  (enablement/safe-mode record)
 *
 * `.froglight/` is derived workspace state: deleting it never loses user
 * content, and every file here is re-readable plain text. The enablement
 * record follows the versioned-record rules (format tag, version, unknown
 * field preservation, corrupt => defaults).
 */

import {
  ensureDirectory,
  isVaultError,
  parseVersionedRecord,
  serializeVersionedRecord,
  type VaultEntry,
  type VaultService,
  type WorkspacePath,
} from '@froglight/foundation';
import { validateManifest, type PluginManifest } from './manifest.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const PLUGINS_DIR = '.froglight/plugins';
export const PLUGINS_RECORD_PATH = '.froglight/plugins.json' as WorkspacePath;

const PLUGINS_FORMAT = 'froglight.plugins';
const PLUGINS_VERSION = 1;
const PLUGINS_KNOWN_KEYS = ['format', 'version', 'enabled', 'disabledBySafeMode'] as const;
const MANIFEST_FILE = 'manifest.json';
const CODE_FILE = 'main.js';

/** A plugin directory observed under `.froglight/plugins`. */
export interface InstalledPlugin {
  /** Directory name; equals `manifest.id` for valid installs. */
  readonly id: string;
  /** Validated manifest; `null` when missing/invalid (`error` explains). */
  readonly manifest: PluginManifest | null;
  readonly error: string | null;
  readonly hasCode: boolean;
}

export interface PluginStateRecord {
  readonly version: 1;
  /** Plugin ids the user enabled. Absence means disabled. */
  readonly enabled: readonly string[];
  /**
   * Ids disabled by safe mode after repeated failures. They stay off across
   * restarts until the user explicitly re-enables them.
   */
  readonly disabledBySafeMode: readonly string[];
}

function isValidPluginDirName(id: string): boolean {
  // Reverse-DNS ids are already constrained by manifest validation; this adds
  // an explicit path-safety guard so a hostile directory name can never escape
  // or confuse the plugins area.
  if (id.length === 0 || id === '.' || id === '..') return false;
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false;
  if (id.includes('..')) return false;
  if (id.endsWith('.')) return false;
  return true;
}

function pluginDir(id: string): WorkspacePath {
  if (!isValidPluginDirName(id)) {
    throw new Error(`invalid plugin id ${JSON.stringify(id)}`);
  }
  return `${PLUGINS_DIR}/${id}` as WorkspacePath;
}

async function readOptional(vault: VaultService, path: WorkspacePath): Promise<Uint8Array | null> {
  try {
    return await vault.read(path);
  } catch (error) {
    if (isVaultError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** Read-side/write-side for plugin files and enablement state in a vault. */
export class VaultPluginStore {
  readonly #vault: VaultService;

  constructor(vault: VaultService) {
    this.#vault = vault;
  }

  /** Every installed plugin folder, valid or not; never throws for one bad entry. */
  async listInstalled(): Promise<InstalledPlugin[]> {
    let entries: readonly VaultEntry[];
    try {
      entries = await this.#vault.list(PLUGINS_DIR as WorkspacePath);
    } catch (error) {
      if (isVaultError(error) && error.code === 'NOT_FOUND') return [];
      throw error;
    }
    const installed: InstalledPlugin[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'directory' || !isValidPluginDirName(entry.name)) continue;
      installed.push(await this.#inspect(entry.name));
    }
    installed.sort((a, b) => a.id.localeCompare(b.id));
    return installed;
  }

  async #inspect(id: string): Promise<InstalledPlugin> {
    const dir = pluginDir(id);
    const manifestBytes = await readOptional(this.#vault, `${dir}/${MANIFEST_FILE}` as WorkspacePath);
    const codeBytes = await readOptional(this.#vault, `${dir}/${CODE_FILE}` as WorkspacePath);
    if (manifestBytes === null) {
      return { id, manifest: null, error: `missing ${MANIFEST_FILE}`, hasCode: codeBytes !== null };
    }
    try {
      const manifest = validateManifest(JSON.parse(textDecoder.decode(manifestBytes)));
      return { id, manifest, error: null, hasCode: codeBytes !== null };
    } catch (error) {
      return {
        id,
        manifest: null,
        error: error instanceof Error ? error.message : String(error),
        hasCode: codeBytes !== null,
      };
    }
  }

  /** Validated manifest for an installed plugin; `null` when absent. */
  async readManifest(id: string): Promise<PluginManifest | null> {
    const bytes = await readOptional(this.#vault, `${pluginDir(id)}/${MANIFEST_FILE}` as WorkspacePath);
    if (bytes === null) return null;
    return validateManifest(JSON.parse(textDecoder.decode(bytes)));
  }

  /** Plugin code source; throws when the plugin has no `main.js`. */
  async readCode(id: string): Promise<string> {
    const bytes = await readOptional(this.#vault, `${pluginDir(id)}/${CODE_FILE}` as WorkspacePath);
    if (bytes === null) {
      throw new Error(`plugin ${id} has no ${CODE_FILE}`);
    }
    return textDecoder.decode(bytes);
  }

  /**
   * Install (or replace) a plugin from parsed manifest JSON + code text.
   * The manifest is validated before anything is written.
   */
  async install(input: { manifestJson: unknown; code: string }): Promise<PluginManifest> {
    const manifest = validateManifest(input.manifestJson);
    const dir = pluginDir(manifest.id);
    await ensureDirectory(this.#vault, dir);
    await this.#vault.write(`${dir}/${CODE_FILE}` as WorkspacePath, textEncoder.encode(input.code));
    // The manifest lands last: its presence marks a complete install.
    await this.#vault.write(
      `${dir}/${MANIFEST_FILE}` as WorkspacePath,
      textEncoder.encode(JSON.stringify(manifest, null, 2)),
    );
    return manifest;
  }

  /** Remove a plugin's directory entirely. Missing directories are fine. */
  async remove(id: string): Promise<void> {
    const dir = pluginDir(id);
    await this.#vault.remove(`${dir}/${CODE_FILE}` as WorkspacePath);
    await this.#vault.remove(`${dir}/${MANIFEST_FILE}` as WorkspacePath);
    await this.#vault.remove(dir);
  }

  /** Load enablement state; missing or corrupt records become defaults. */
  async loadState(): Promise<PluginStateRecord> {
    const bytes = await readOptional(this.#vault, PLUGINS_RECORD_PATH);
    if (bytes === null) return { version: 1, enabled: [], disabledBySafeMode: [] };
    try {
      const { record } = parseVersionedRecord<{
        format: string;
        version: number;
        enabled?: unknown;
        disabledBySafeMode?: unknown;
      }>(bytes, PLUGINS_FORMAT, [PLUGINS_VERSION], PLUGINS_KNOWN_KEYS);
      return {
        version: 1,
        enabled: stringList(record.enabled),
        disabledBySafeMode: stringList(record.disabledBySafeMode),
      };
    } catch {
      return { version: 1, enabled: [], disabledBySafeMode: [] };
    }
  }

  /** Persist enablement state (preserving unknown fields round-tripped on load). */
  async saveState(state: PluginStateRecord): Promise<void> {
    await ensureDirectory(this.#vault, '.froglight' as WorkspacePath);
    const current = await readOptional(this.#vault, PLUGINS_RECORD_PATH);
    let extras: Record<string, unknown> = {};
    if (current !== null) {
      try {
        extras = parseVersionedRecord(current, PLUGINS_FORMAT, [PLUGINS_VERSION], PLUGINS_KNOWN_KEYS).extras;
      } catch {
        extras = {};
      }
    }
    const record = {
      format: PLUGINS_FORMAT,
      version: PLUGINS_VERSION,
      enabled: [...state.enabled],
      disabledBySafeMode: [...state.disabledBySafeMode],
    };
    await this.#vault.write(PLUGINS_RECORD_PATH, serializeVersionedRecord(record, extras));
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
