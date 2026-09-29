import { invoke } from '@tauri-apps/api/core';
import type {
  VaultEntry,
  VaultStat,
  WorkspacePath,
} from '@froglight/foundation';
import { base64ToBytesAsync, bytesToBase64, bytesToBase64Async } from './derived-cache-storage.js';

interface FolderHandle {
  readonly id: string;
  readonly name?: string | null;
  readonly uri?: string | null;
}

interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly isFile: boolean;
  readonly isDir: boolean;
  readonly size?: number | null;
  readonly lastModified?: number | null;
}

type FileStat = DirEntry;

interface MobileVaultRef {
  readonly folderId: string;
  readonly rootPath: string;
}

const VAULT_WRITE_METADATA_HEADER = 'x-froglight-vault-write';

function isAndroidHost(): boolean {
  try {
    return /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

function encodeWriteMetadata(folderId: string, path: string, expectedChecksum?: string): string {
  return bytesToBase64(
    new TextEncoder().encode(JSON.stringify({ folderId, path, expectedChecksum })),
  );
}

export interface MobileVaultDescriptor {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly lastOpenedAt: number;
}

interface StoredVault extends MobileVaultDescriptor {
  readonly recent: boolean;
}
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ID_PREFIX = 'mobile-vault:';
const REGISTRY_KEY = 'froglight.mobile-vaults.v1';
const memory = new Map<string, string>();
const fallbackStorage: StorageLike = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
};

function storage(): StorageLike {
  return globalThis.localStorage ?? fallbackStorage;
}

function encodeRef(ref: MobileVaultRef): string {
  return `${ID_PREFIX}${encodeURIComponent(ref.folderId)}|${encodeURIComponent(ref.rootPath)}`;
}

function decodeRef(id: string): MobileVaultRef | null {
  if (!id.startsWith(ID_PREFIX)) return null;
  const separator = id.indexOf('|', ID_PREFIX.length);
  if (separator < 0) return null;
  try {
    return {
      folderId: decodeURIComponent(id.slice(ID_PREFIX.length, separator)),
      rootPath: decodeURIComponent(id.slice(separator + 1)),
    };
  } catch {
    // Malformed percent-encoding is an unknown vault, never a crash:
    // callers translate a null ref into structured NOT_FOUND.
    return null;
  }
}

function join(root: string, path: string): string {
  return [root, path].filter(Boolean).join('/');
}

function readRegistry(): StoredVault[] {
  try {
    const parsed = JSON.parse(storage().getItem(REGISTRY_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as StoredVault[]) : [];
  } catch {
    return [];
  }
}

function save(record: StoredVault): void {
  const records = readRegistry().filter(
    (candidate) => candidate.id !== record.id,
  );
  storage().setItem(REGISTRY_KEY, JSON.stringify([...records, record]));
}

function descriptor(
  folder: FolderHandle,
  rootPath: string,
  recent: boolean,
): StoredVault {
  const fallbackName = rootPath.split('/').at(-1) || 'Vault';
  const name = rootPath ? fallbackName : folder.name || fallbackName;
  const base = folder.name || folder.uri || 'Files';
  return {
    id: encodeRef({ folderId: folder.id, rootPath }),
    name,
    location: rootPath ? `${base}/${rootPath}` : base,
    lastOpenedAt: Date.now(),
    recent,
  };
}

function validateFolderName(name: string): void {
  if (!name.trim() || name === '.' || name === '..' || /[\\/\0]/u.test(name)) {
    throw { code: 'INVALID_PATH', message: 'invalid vault folder name' };
  }
}

function requireRef(id: string): MobileVaultRef {
  const ref = decodeRef(id);
  if (!ref) throw { code: 'NOT_FOUND', message: 'unknown mobile vault' };
  return ref;
}

function isErrorPayload(
  value: unknown,
): value is { code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

async function call<T>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(
      `plugin:froglight-vault-storage|${command}`,
      payload,
    );
  } catch (error) {
    if (isErrorPayload(error)) throw error;
    throw {
      code: 'IO',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function pickFolder(): Promise<FolderHandle> {
  return call('pick_folder');
}
async function listFolders(): Promise<FolderHandle[]> {
  return call('list_folders');
}
async function mkdir(
  folderId: string,
  path: string,
  recursive = false,
): Promise<void> {
  return call('mkdir', { req: { folderId, path, recursive } });
}
async function readDir(folderId: string, path?: string): Promise<DirEntry[]> {
  return call('read_dir', { req: { folderId, path } });
}
async function stat(folderId: string, path: string): Promise<FileStat> {
  return call('stat', { req: { folderId, path } });
}
async function readFile(folderId: string, path: string): Promise<Uint8Array> {
  const response = await call<{ data: string }>('read_file', {
    req: { folderId, path },
  });
  return base64ToBytesAsync(response.data);
}
async function writeFile(
  folderId: string,
  path: string,
  data: Uint8Array,
  expectedChecksum?: string,
): Promise<void> {
  if (isAndroidHost()) {
    return call('write_file', {
      req: { folderId, path, expectedChecksum, data: await bytesToBase64Async(data) },
    });
  }
  try {
    await invoke(`plugin:froglight-vault-storage|write_file`, data, {
      headers: {
        [VAULT_WRITE_METADATA_HEADER]: encodeWriteMetadata(folderId, path, expectedChecksum),
      },
    });
  } catch (error) {
    if (isErrorPayload(error)) throw error;
    throw {
      code: 'IO',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
async function removeFile(folderId: string, path: string): Promise<void> {
  return call('remove_file', { req: { folderId, path } });
}
async function removeDir(
  folderId: string,
  path: string,
  recursive = false,
): Promise<void> {
  return call('remove_dir', { req: { folderId, path, recursive } });
}
async function rename(
  folderId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  return call('rename', { req: { folderId, fromPath, toPath } });
}

export function isMobileVaultId(id: string): boolean {
  return decodeRef(id) !== null;
}

export function isMobileVaultUnsupported(error: unknown): boolean {
  return isErrorPayload(error) && error.code === 'UNSUPPORTED';
}

export const mobileVaults = {
  async listRecent(): Promise<readonly MobileVaultDescriptor[]> {
    const available = new Set((await listFolders()).map((folder) => folder.id));
    return readRegistry()
      .filter((record) => {
        const ref = decodeRef(record.id);
        return record.recent && ref !== null && available.has(ref.folderId);
      })
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  },

  async pickDirectory(
    registerRecent: boolean,
  ): Promise<MobileVaultDescriptor | null> {
    let folder: FolderHandle;
    try {
      folder = await pickFolder();
    } catch (error) {
      if (isErrorPayload(error) && error.code === 'CANCELLED') return null;
      throw error;
    }
    const record = descriptor(folder, '', registerRecent);
    if (registerRecent) save(record);
    return record;
  },

  async createVault(
    parentId: string,
    name: string,
  ): Promise<MobileVaultDescriptor> {
    validateFolderName(name);
    const parent = requireRef(parentId);
    const rootPath = join(parent.rootPath, name);
    await mkdir(parent.folderId, rootPath, false);
    const folder = (await listFolders()).find(
      (candidate) => candidate.id === parent.folderId,
    );
    if (!folder)
      throw { code: 'NOT_FOUND', message: 'folder access is unavailable' };
    const record = descriptor(folder, rootPath, true);
    save(record);
    return record;
  },

  async markOpened(id: string): Promise<void> {
    const record = readRegistry().find((candidate) => candidate.id === id);
    if (record) save({ ...record, recent: true, lastOpenedAt: Date.now() });
  },

  async forget(id: string): Promise<void> {
    const record = readRegistry().find((candidate) => candidate.id === id);
    if (record) save({ ...record, recent: false });
  },

  async stat(id: string, path: WorkspacePath): Promise<VaultStat> {
    const ref = requireRef(id);
    const mobilePath = join(ref.rootPath, path);
    if (!mobilePath)
      return { path, kind: 'directory', size: 0, modifiedMillis: null };
    const info = await stat(ref.folderId, mobilePath);
    return {
      path,
      kind: info.isDir ? 'directory' : 'file',
      size: info.isDir ? 0 : (info.size ?? 0),
      modifiedMillis:
        info.lastModified == null ? null : info.lastModified * 1000,
    };
  },

  async list(id: string, path: WorkspacePath): Promise<readonly VaultEntry[]> {
    const ref = requireRef(id);
    return (
      (await readDir(ref.folderId, join(ref.rootPath, path) || undefined))
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDir ? ('directory' as const) : ('file' as const),
        }))
        // Contract requires deterministic code-unit order (not locale-aware).
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    );
  },

  async createDirectory(id: string, path: WorkspacePath): Promise<void> {
    const ref = requireRef(id);
    await mkdir(ref.folderId, join(ref.rootPath, path), false);
  },

  async read(id: string, path: WorkspacePath): Promise<Uint8Array> {
    const ref = requireRef(id);
    return readFile(ref.folderId, join(ref.rootPath, path));
  },

  async write(
    id: string,
    path: WorkspacePath,
    data: Uint8Array,
    expectedChecksum?: string,
  ): Promise<void> {
    const ref = requireRef(id);
    await writeFile(ref.folderId, join(ref.rootPath, path), data, expectedChecksum);
  },

  async remove(id: string, path: WorkspacePath): Promise<void> {
    const ref = requireRef(id);
    const mobilePath = join(ref.rootPath, path);
    // The vault root may never be removed (portable contract: CONFLICT).
    // Guard here: the native `stat` command rejects empty paths as
    // INVALID_PATH, which would diverge from every other provider.
    if (!mobilePath)
      throw { code: 'CONFLICT', message: 'cannot remove the vault root' };
    const info = await stat(ref.folderId, mobilePath);
    if (info.isDir) await removeDir(ref.folderId, mobilePath, false);
    else await removeFile(ref.folderId, mobilePath);
  },

  async move(
    id: string,
    from: WorkspacePath,
    to: WorkspacePath,
  ): Promise<void> {
    const ref = requireRef(id);
    const fromPath = join(ref.rootPath, from);
    const toPath = join(ref.rootPath, to);
    // Root moves (including onto the root) are CONFLICT, matching the
    // desktop vault boundary instead of leaking native INVALID_PATH.
    if (!fromPath || !toPath)
      throw { code: 'CONFLICT', message: 'cannot move the vault root' };
    await rename(ref.folderId, fromPath, toPath);
  },
};
