import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  isValidWorkspacePath,
  joinPath,
  parentPath,
  pathDepth,
  parsePath,
  ROOT_PATH,
  workspacePath,
  type WorkspacePath,
} from '../paths.js';
import { stableStringify } from '../records.js';
import type { VaultService } from './contract.js';

const FORMAT = 'froglight.vault-backup';
const VERSION = 1;
const MAX_ENTRIES = 100_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 700 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;

interface BackupFileRecord {
  readonly path: string;
  readonly bytes: string;
}

interface BackupRecord {
  readonly format: typeof FORMAT;
  readonly version: typeof VERSION;
  readonly directories: readonly string[];
  readonly files: readonly BackupFileRecord[];
}

export interface VaultBackupExport {
  readonly bundle: Uint8Array;
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface VaultBackupExportProgress {
  readonly phase: 'scanning' | 'reading' | 'encoding';
  readonly completedFiles: number;
  readonly totalFiles: number | null;
  readonly currentPath?: WorkspacePath;
}

export type VaultBackupRestorePhase = 'create-directory' | 'write-file';

export interface VaultBackupRestoreComplete {
  readonly status: 'complete';
  readonly createdDirectories: readonly WorkspacePath[];
  readonly writtenFiles: readonly WorkspacePath[];
  readonly totalBytes: number;
}

export interface VaultBackupRestorePartial {
  readonly status: 'partial';
  readonly phase: VaultBackupRestorePhase;
  readonly createdDirectories: readonly WorkspacePath[];
  readonly writtenFiles: readonly WorkspacePath[];
  readonly failedPath: WorkspacePath;
  readonly error: unknown;
}

export type VaultBackupRestoreResult =
  | VaultBackupRestoreComplete
  | VaultBackupRestorePartial;

/**
 * Capture every file and empty directory in a vault as opaque bytes.
 * No document codec is consulted, so hidden metadata and unavailable plugin
 * content receive the same treatment as ordinary documents.
 */
export async function exportVaultBackup(input: {
  readonly vault: VaultService;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: VaultBackupExportProgress) => void;
}): Promise<VaultBackupExport> {
  const directories: string[] = [];
  const filePaths: WorkspacePath[] = [];
  const files: BackupFileRecord[] = [];
  let entryCount = 0;
  let totalBytes = 0;

  const visit = async (directory: WorkspacePath): Promise<void> => {
    throwIfAborted(input.signal);
    input.onProgress?.({
      phase: 'scanning',
      completedFiles: 0,
      totalFiles: null,
      currentPath: directory,
    });
    const entries = await input.vault.list(directory, { signal: input.signal });
    for (const entry of entries) {
      throwIfAborted(input.signal);
      entryCount += 1;
      if (entryCount > MAX_ENTRIES)
        throw new Error(`Vault backup exceeds ${MAX_ENTRIES} entries`);
      const path = joinPath(directory, entry.name);
      assertBoundedPath(path);
      if (entry.kind === 'directory') {
        directories.push(path);
        await visit(path);
        continue;
      }
      filePaths.push(path);
    }
  };

  await visit(ROOT_PATH);
  input.onProgress?.({
    phase: 'reading',
    completedFiles: 0,
    totalFiles: filePaths.length,
  });
  for (const path of filePaths) {
    throwIfAborted(input.signal);
    const bytes = await input.vault.read(path, { signal: input.signal });
    if (bytes.byteLength > MAX_FILE_BYTES)
      throw new Error(`Vault backup file exceeds 64 MiB: ${path}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new Error('Vault backup exceeds 512 MiB of decoded file data');
    files.push({ path, bytes: encodeBase64(bytes) });
    input.onProgress?.({
      phase: 'reading',
      completedFiles: files.length,
      totalFiles: filePaths.length,
      currentPath: path,
    });
  }
  input.onProgress?.({
    phase: 'encoding',
    completedFiles: files.length,
    totalFiles: filePaths.length,
  });
  const bundle = utf8Encode(
    stableStringify({
      format: FORMAT,
      version: VERSION,
      directories,
      files,
    } satisfies BackupRecord),
  );
  if (bundle.byteLength > MAX_BUNDLE_BYTES)
    throw new Error('Vault backup exceeds the 700 MiB encoded size limit');
  return {
    bundle,
    directoryCount: directories.length,
    fileCount: files.length,
    totalBytes,
  };
}

/**
 * Restore a fully validated backup into an explicitly confirmed empty vault.
 * Validation and the empty-root check finish before the first write. Once a
 * write begins, failures return the exact durable progress and leave it intact.
 */
export async function restoreVaultBackup(input: {
  readonly bundle: Uint8Array;
  readonly destination: VaultService;
  readonly requireEmptyDestination: true;
  readonly signal?: AbortSignal;
}): Promise<VaultBackupRestoreResult> {
  if (input.requireEmptyDestination !== true)
    throw new Error('Vault restore requires explicit empty-destination mode');
  const decoded = preflight(input.bundle, input.destination);
  throwIfAborted(input.signal);
  const existing = await input.destination.list(ROOT_PATH, {
    signal: input.signal,
  });
  if (existing.length !== 0)
    throw new Error('Vault restore destination must be empty');

  const createdDirectories: WorkspacePath[] = [];
  const writtenFiles: WorkspacePath[] = [];
  for (const path of decoded.directories) {
    try {
      throwIfAborted(input.signal);
      await input.destination.createDirectory(path, { signal: input.signal });
      createdDirectories.push(path);
    } catch (error) {
      return {
        status: 'partial',
        phase: 'create-directory',
        createdDirectories,
        writtenFiles,
        failedPath: path,
        error,
      };
    }
  }
  for (const file of decoded.files) {
    try {
      throwIfAborted(input.signal);
      await input.destination.write(file.path, decodeBase64(file.bytes), {
        signal: input.signal,
      });
      writtenFiles.push(file.path);
    } catch (error) {
      return {
        status: 'partial',
        phase: 'write-file',
        createdDirectories,
        writtenFiles,
        failedPath: file.path,
        error,
      };
    }
  }
  return {
    status: 'complete',
    createdDirectories,
    writtenFiles,
    totalBytes: decoded.totalBytes,
  };
}

function preflight(
  bundle: Uint8Array,
  destination: VaultService,
): {
  readonly directories: readonly WorkspacePath[];
  readonly files: readonly { path: WorkspacePath; bytes: string }[];
  readonly totalBytes: number;
} {
  if (bundle.byteLength > MAX_BUNDLE_BYTES)
    throw new Error('Vault backup exceeds the 700 MiB encoded size limit');
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bundle));
  } catch {
    throw new Error('Vault backup is not valid JSON');
  }
  if (!object(value) || value.format !== FORMAT || value.version !== VERSION)
    throw new Error('Unsupported vault backup format/version');
  if (!Array.isArray(value.directories) || !Array.isArray(value.files))
    throw new Error('Invalid vault backup manifest');
  if (value.directories.length + value.files.length > MAX_ENTRIES)
    throw new Error(`Vault backup exceeds ${MAX_ENTRIES} entries`);

  const directories = value.directories.map((path) => validatedPath(path));
  const files = value.files.map((file) => {
    if (!object(file) || typeof file.bytes !== 'string')
      throw new Error('Invalid vault backup file entry');
    return { path: validatedPath(file.path), bytes: file.bytes };
  });
  const keys = new Map<string, WorkspacePath>();
  for (const path of [...directories, ...files.map((file) => file.path)]) {
    const key = destinationPathKey(path, destination);
    const previous = keys.get(key);
    if (previous)
      throw new Error(`Vault backup paths collide: ${previous} and ${path}`);
    keys.set(key, path);
  }
  const directoryKeys = new Set(
    directories.map((path) => destinationPathKey(path, destination)),
  );
  for (const path of directories)
    assertParentDirectory(path, directoryKeys, destination);
  for (const file of files)
    assertParentDirectory(file.path, directoryKeys, destination);

  let totalBytes = 0;
  for (const file of files) {
    const bytes = decodeBase64(file.bytes);
    if (bytes.byteLength > MAX_FILE_BYTES)
      throw new Error(`Vault backup file exceeds 64 MiB: ${file.path}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new Error('Vault backup exceeds 512 MiB of decoded file data');
  }
  directories.sort((a, b) => pathDepth(a) - pathDepth(b) || compare(a, b));
  files.sort((a, b) => compare(a.path, b.path));
  return { directories, files, totalBytes };
}

function assertParentDirectory(
  path: WorkspacePath,
  directories: ReadonlySet<string>,
  destination: VaultService,
): void {
  const parent = parentPath(path);
  if (
    parent !== ROOT_PATH &&
    !directories.has(destinationPathKey(parent, destination))
  )
    throw new Error(`Vault backup is missing parent directory: ${parent}`);
}

function validatedPath(value: unknown): WorkspacePath {
  if (typeof value !== 'string' || !isValidWorkspacePath(value) || value === '')
    throw new Error('Vault backup contains an invalid path');
  const path = workspacePath(value);
  assertBoundedPath(path);
  return path;
}

function assertBoundedPath(path: WorkspacePath): void {
  if (
    path.length > MAX_PATH_LENGTH ||
    parsePath(path).some((segment) => segment.length > MAX_SEGMENT_LENGTH)
  )
    throw new Error(`Vault backup path exceeds supported limits: ${path}`);
}

function destinationPathKey(path: WorkspacePath, vault: VaultService): string {
  let key = path as string;
  if (vault.capabilities.nameNormalization === 'nfc')
    key = key.normalize('NFC');
  if (vault.capabilities.caseSensitivity === 'insensitive')
    key = key.toLocaleLowerCase('en-US');
  return key;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Vault backup operation aborted');
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64.charAt(a >> 2);
    output += BASE64.charAt(((a & 3) << 4) | ((b ?? 0) >> 4));
    output +=
      b === undefined ? '=' : BASE64.charAt(((b & 15) << 2) | ((c ?? 0) >> 6));
    output += c === undefined ? '=' : BASE64.charAt(c & 63);
  }
  return output;
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid base64 in vault backup');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64.indexOf(value.charAt(index));
    const b = BASE64.indexOf(value.charAt(index + 1));
    const c =
      value[index + 2] === '=' ? 0 : BASE64.indexOf(value.charAt(index + 2));
    const d =
      value[index + 3] === '=' ? 0 : BASE64.indexOf(value.charAt(index + 3));
    output[offset++] = (a << 2) | (b >> 4);
    if (offset < output.length) output[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < output.length) output[offset++] = ((c & 3) << 6) | d;
  }
  return output;
}
