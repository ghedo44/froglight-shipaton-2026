import {
  readVaultProfile,
  writeVaultProfile,
  type VaultAppearance,
} from '@froglight/foundation';
import {
  DEMO_VAULT_ID,
  DEMO_VAULT_NAME,
  installDemoVault,
  type WorkbenchController,
} from '@froglight/application';
import { OpfsVault, opfsVaultPlugin } from '@froglight/provider-opfs';
import type {
  EmptyVaultStore,
  VaultChoice,
  VaultCreateLocation,
  VaultHostAdapter,
} from '@froglight/ui';

interface StoredVault {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly handle: FileSystemDirectoryHandle;
  readonly lastOpenedAt: number;
}

const DB_NAME = 'froglight-host';
const DB_VERSION = 1;
const STORE_NAME = 'recent-vaults';

export interface WebVaultAdapterOptions {
  readonly includeDemo?: boolean;
  /**
   * Injectable staging-directory id generator (tests only). Each call
   * must return a fresh opaque id; production uses `crypto.randomUUID()`
   * via `newId()`. The seam exists so collision handling is deterministic
   * to test without sleeps or random luck.
   */
  readonly newStagingId?: () => string;
}

export function createWebVaultAdapter(
  controller: WorkbenchController,
  options: WebVaultAdapterOptions = {},
): VaultHostAdapter {
  const newStagingId = options.newStagingId ?? newId;
  const toChoice = (record: StoredVault): VaultChoice => ({
    id: record.id,
    name: record.name,
    location: record.location,
    lastOpenedAt: record.lastOpenedAt,
    async activate() {
      const allowed = await ensureReadWritePermission(record.handle);
      if (!allowed)
        throw new Error(`Permission is required to open ${record.name}`);
      if (record.id === DEMO_VAULT_ID) {
        await installDemoVault(await OpfsVault.create({ root: record.handle }));
      }
      // The host vault identity enters the runtime with the vault so the
      // sync attachment can never infer which local vault was opened
      await controller.openVault(opfsVaultPlugin, {
        root: record.handle,
        localVaultId: record.id,
      });
      // Recents are convenience state: failure to persist this timestamp must
      // never prevent access to a vault that already opened successfully.
      try {
        await putStoredVault({ ...record, lastOpenedAt: Date.now() });
      } catch {
        // Best effort only.
      }
    },
  });

  async function profileChoice(record: StoredVault): Promise<VaultChoice> {
    try {
      const vault = await OpfsVault.create({ root: record.handle });
      if (record.id === DEMO_VAULT_ID) await installDemoVault(vault);
      const profile = await readVaultProfile(vault);
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

  async function createEmptyStore(
    name: string,
    parent: FileSystemDirectoryHandle,
    parentLabel: string,
  ): Promise<EmptyVaultStore> {
    // Transaction-owned staging (fail-closed): never derive the physical
    // directory from the user-visible vault name. A display-derived name
    // with `{ create: true }` returns an EXISTING user directory when it
    // collides, and a later recursive `discard()` would delete user data.
    // Instead create an unguessable Froglight-owned staging directory.
    //
    // Flow (probe-before-create):
    //
    // ```text
    // generate random .froglight-download-<id>
    // probe candidate with create:false
    // if candidate EXISTS (even empty): collision → fresh id (bounded retry)
    // if NOT FOUND: create:true → transaction-created (deletable)
    // if absence cannot be distinguished: create:true but
    //   ownedForDeletion=false (never pretend exclusive ownership)
    // ```
    //
    // Ownership additionally requires a verifiable empty enumeration after
    // creation; an enumeration failure (unknown) fails closed to
    // non-destructive cleanup. Recursive deletion is allowed only when
    // state===staging AND ownedForDeletion===true AND the name matches the
    // staging namespace. Otherwise discard forgets recents only. Never
    // deletes display-name-derived, pre-existing, uncertain, or activated
    // vaults.
    let stagingFolderName: string | null = null;
    let directory: FileSystemDirectoryHandle | null = null;
    let ownedForDeletion = false;
    const MAX_STAGING_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt += 1) {
      const candidate = `.froglight-download-${newStagingId()}`;
      let absenceProven: boolean;
      try {
        await parent.getDirectoryHandle(candidate, { create: false });
        // Candidate exists (possibly empty): collision. Never materialize
        // into or claim ownership of a pre-existing directory.
        continue;
      } catch (error) {
        // Only an explicit not-found proves absence-before-creation; any
        // other failure leaves existence unknown and ownership unproven.
        absenceProven = isNotFoundError(error);
      }
      directory = await parent.getDirectoryHandle(candidate, { create: true });
      stagingFolderName = candidate;
      ownedForDeletion =
        absenceProven && (await stagingEmptiness(directory)) === 'empty';
      break;
    }
    if (stagingFolderName === null || directory === null) {
      throw new Error(
        'Download staging collision: refusing to reuse an existing directory',
      );
    }
    const ownedName = stagingFolderName;
    const ownedDir = directory;
    void ownedDir;
    // Raw backing store only: no workspace is opened inside it, so the
    // first materialization cannot merge against initialized metadata.
    const vault = await OpfsVault.create({ root: directory });
    const record: StoredVault = {
      id: newId(),
      // User-visible display name stays the remote vault name even though
      // the physical directory is opaque staging. Correctness over pretty
      // directory naming; no rename is attempted.
      name,
      location: `${parentLabel}/${stagingFolderName}`,
      handle: directory,
      lastOpenedAt: Date.now(),
    };
    const choice = toChoice(record);
    // Ownership-safe lifecycle: `discard()` may destroy ONLY the
    // transaction-owned staging store while still in `staging`. Once
    // `activate()` succeeds the backing store is an opened user vault and
    // discard becomes a non-destructive no-op (plus idempotent after).
    let state: 'staging' | 'activated' | 'discarded' = 'staging';
    return {
      id: record.id,
      vault,
      activate: async () => {
        if (state === 'discarded') return null;
        await choice.activate();
        state = 'activated';
        return profileChoice(record);
      },
      discard: async () => {
        // Fail-closed cleanup: recursive deletion ONLY when
        // state===staging AND ownedForDeletion===true AND the name matches
        // the Froglight staging namespace. Otherwise degrade to
        // non-destructive cleanup (forget recents only). Never deletes
        // display-name-derived, pre-existing, uncertain, or activated
        // vaults. Idempotent; never throws to hide the primary error.
        try {
          if (state !== 'staging') return;
          state = 'discarded';
          await deleteStoredVault(record.id).catch(() => undefined);
          if (!ownedForDeletion) return;
          // Defense in depth: only remove Froglight-owned staging names.
          if (!ownedName.startsWith('.froglight-download-')) return;
          try {
            await parent.removeEntry(ownedName, { recursive: true });
          } catch {
            // OPFS removal may fail (locked, unsupported) — the staging
            // directory is harmless and never bound, so swallow.
          }
        } catch {
          // Never hide the primary error.
        }
      },
    };
  }

  return {
    async openForBackup(id) {
      const record = (await listStoredVaults()).find((item) => item.id === id);
      if (record === undefined) throw new Error('Vault is no longer available');
      if (!(await ensureReadWritePermission(record.handle, 'read')))
        throw new Error(`Permission is required to back up ${record.name}`);
      return OpfsVault.create({ root: record.handle });
    },
    async createEmptyVaultStore(name: string): Promise<EmptyVaultStore | null> {
      const picker = getDirectoryPicker();
      if (picker !== null) {
        let parent: FileSystemDirectoryHandle;
        try {
          parent = await picker({ mode: 'readwrite' });
        } catch (error) {
          if (isAbort(error)) return null;
          throw error;
        }
        return createEmptyStore(name, parent, parent.name || 'Selected folder');
      }
      return createEmptyStore(
        name,
        await opfsRoot(),
        'Browser private storage (OPFS)',
      );
    },

    async listRecent() {
      const records = await listStoredVaults();
      if (
        options.includeDemo &&
        localStorage.getItem(`${DEMO_VAULT_ID}.hidden`) !== 'true' &&
        !records.some((record) => record.id === DEMO_VAULT_ID)
      ) {
        const directory = await (
          await opfsRoot()
        ).getDirectoryHandle(DEMO_VAULT_ID, { create: true });
        await installDemoVault(await OpfsVault.create({ root: directory }));
        const record: StoredVault = {
          id: DEMO_VAULT_ID,
          name: DEMO_VAULT_NAME,
          location: 'On this device · editable demo',
          handle: directory,
          lastOpenedAt: 0,
        };
        await putStoredVault(record);
        records.push(record);
      }
      return Promise.all(
        records
          .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
          .map(profileChoice),
      );
    },

    async chooseCreateLocation(): Promise<VaultCreateLocation | null> {
      const picker = getDirectoryPicker();
      let parent: FileSystemDirectoryHandle;
      let parentLabel: string;

      if (picker !== null) {
        try {
          parent = await picker({ mode: 'readwrite' });
        } catch (error) {
          if (isAbort(error)) return null;
          throw error;
        }
        parentLabel = parent.name || 'Selected folder';
      } else {
        parent = await opfsRoot();
        parentLabel = 'Browser private storage (OPFS)';
      }

      return {
        label: parentLabel,
        async create(name: string, appearance?: VaultAppearance) {
          const folderName = safeFolderName(name);
          const directory = await parent.getDirectoryHandle(folderName, {
            create: true,
          });
          const vault = await OpfsVault.create({ root: directory });
          if (appearance !== undefined) {
            if ((await readVaultProfile(vault)) !== null)
              throw new Error(
                'That folder already contains a vault. Open it to edit its details.',
              );
            await writeVaultProfile(vault, { name, ...appearance });
          }
          return profileChoice({
            id: newId(),
            name,
            location: `${parentLabel}/${folderName}`,
            handle: directory,
            lastOpenedAt: Date.now(),
          });
        },
      };
    },

    async openVault() {
      const picker = getDirectoryPicker();
      if (picker === null) return null;
      try {
        const directory = await picker({ mode: 'readwrite' });
        const records = await safeListStoredVaults();
        const existing = await findSameDirectory(directory, records);
        return profileChoice({
          id: existing?.id ?? newId(),
          name: existing?.name ?? (directory.name || 'Vault'),
          location: existing?.location ?? (directory.name || 'Selected folder'),
          handle: directory,
          lastOpenedAt: Date.now(),
        });
      } catch (error) {
        if (isAbort(error)) return null;
        throw error;
      }
    },

    forgetVault(id: string) {
      if (id === DEMO_VAULT_ID)
        localStorage.setItem(`${DEMO_VAULT_ID}.hidden`, 'true');
      return deleteStoredVault(id);
    },
  };
}

function getDirectoryPicker():
  | ((options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>)
  | null {
  const picker = (
    window as Window & {
      showDirectoryPicker?: (options?: {
        mode?: 'read' | 'readwrite';
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  return picker?.bind(window) ?? null;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as StorageManager & {
    getDirectory(): Promise<FileSystemDirectoryHandle>;
  };
  return storage.getDirectory();
}

async function ensureReadWritePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  const permissionHandle = handle as FileSystemDirectoryHandle & {
    queryPermission?: (options: {
      mode: 'read' | 'readwrite';
    }) => Promise<PermissionState>;
    requestPermission?: (options: {
      mode: 'read' | 'readwrite';
    }) => Promise<PermissionState>;
  };
  if (permissionHandle.queryPermission === undefined) return true;
  const current = await permissionHandle.queryPermission({ mode });
  if (current === 'granted') return true;
  if (permissionHandle.requestPermission === undefined) return false;
  return (await permissionHandle.requestPermission({ mode })) === 'granted';
}

async function findSameDirectory(
  directory: FileSystemDirectoryHandle,
  records: readonly StoredVault[],
): Promise<StoredVault | undefined> {
  const comparable = directory as FileSystemDirectoryHandle & {
    isSameEntry?: (other: FileSystemHandle) => Promise<boolean>;
  };
  if (comparable.isSameEntry === undefined) return undefined;
  for (const record of records) {
    try {
      if (await comparable.isSameEntry(record.handle)) return record;
    } catch {
      // A stale/unavailable handle is simply not the same recent entry.
    }
  }
  return undefined;
}

/**
 * Fail-closed staging emptiness probe. Never returns true when emptiness
 * cannot actually be verified:
 *
 * - 'empty' → proven empty (deletable when also staging-named);
 * - 'non-empty' → proven occupied (collision: retry with a new id);
 * - 'unknown' → enumeration unavailable or failed (uncertain ownership:
 *   proceed with ownedForDeletion=false, never recursive-delete).
 */
async function stagingEmptiness(
  directory: FileSystemDirectoryHandle,
): Promise<'empty' | 'non-empty' | 'unknown'> {
  try {
    const values = (
      directory as FileSystemDirectoryHandle & {
        values?: () => AsyncIterable<FileSystemHandle>;
      }
    ).values;
    if (typeof values !== 'function') return 'unknown';
    for await (const _entry of values.call(directory)) {
      return 'non-empty';
    }
    return 'empty';
  } catch {
    return 'unknown';
  }
}

function safeFolderName(name: string): string {
  const value = name
    .trim()
    // Intentional control-character strip (the exact case no-control-regex flags).
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '');
  if (!value)
    throw new Error('Vault name does not contain a valid folder name');
  return value;
}

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `vault-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * True only for an explicit not-found probe result. The File System
 * Access API throws `NotFoundError` when `getDirectoryHandle(name, {
 * create: false })` finds no entry; every other failure leaves existence
 * unknown (fail closed for ownership).
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  );
}

async function safeListStoredVaults(): Promise<StoredVault[]> {
  try {
    return await listStoredVaults();
  } catch {
    return [];
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error('Could not open recent-vault database'),
      );
  });
}

async function listStoredVaults(): Promise<StoredVault[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    const result = await requestResult<StoredVault[]>(request);
    await transactionDone(transaction);
    return result;
  } finally {
    database.close();
  }
}

async function putStoredVault(record: StoredVault): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function deleteStoredVault(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}
