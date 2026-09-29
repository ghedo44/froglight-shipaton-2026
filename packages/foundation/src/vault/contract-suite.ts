/**
 * Reusable `VaultService` provider contract suite.
 *
 * The same suite runs against every provider:
 *
 * 1. the deterministic in-memory provider (reference model);
 * 2. the native filesystem provider (real temporary directory);
 * 3. the OPFS provider (real browser context).
 *
 * The suite is dependency-free (no vitest, no Node, no DOM) so it can run
 * in both Node and browser harnesses. It asserts the common contract
 * strictly and only exercises provider-specific behavior (case handling,
 * Unicode normalization, persistence, failure injection) when the provider
 * declares the corresponding capability or supplies the optional hooks.
 *
 * Cases are pure functions that throw `SuiteAssertionError` on failure and
 * clean up after themselves, so a harness can map them onto its own test
 * runner (vitest `it`, a browser page, ...).
 */

import type { WorkspacePath } from '../paths.js';
import { joinPath, ROOT_PATH, workspacePath } from '../paths.js';
import { isVaultError } from '../errors.js';
import { ensureDirectory } from './helpers.js';
import type {
  VaultCapabilities,
  VaultOperationOptions,
  VaultService,
} from './contract.js';

/** Failure thrown by the suite's assertion helpers. */
export class SuiteAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuiteAssertionError';
  }
}

export function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SuiteAssertionError(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new SuiteAssertionError(
      message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message?: string): void {
  assertEqual(actual.byteLength, expected.byteLength, message ?? 'byte length mismatch');
  for (let i = 0; i < actual.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new SuiteAssertionError(
        message ?? `byte mismatch at offset ${i}: ${actual[i]} !== ${expected[i]}`,
      );
    }
  }
}

/** Run `action` and assert it rejects with a vault error of the given code. */
export async function assertVaultError(
  action: () => Promise<unknown>,
  code: string,
  message?: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assertTrue(
      isVaultError(error) && error.code === code,
      message ?? `expected vault error ${code}, got ${describeError(error)}`,
    );
    return;
  }
  throw new SuiteAssertionError(message ?? `expected vault error ${code}, but no error was thrown`);
}

function describeError(error: unknown): string {
  if (isVaultError(error)) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A single runnable suite case. */
export interface VaultContractCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface VaultContractSuiteOptions {
  readonly provider: VaultService;
  /**
   * Creates a fresh provider instance over the same backing state. Required
   * to enable the persistence/reopen case (providers that cannot reopen
   * omit it and the case is not included).
   */
  readonly reopen?: () => VaultService | Promise<VaultService>;
  /**
   * Test-only failure injection hooks. When provided, the suite asserts
   * that a failed write leaves the previous content readable and the tree
   * structurally valid.
   */
  readonly failureInjection?: {
    /** Make the next `write` (matching `path` exactly) fail. */
    failNextWrite: () => void;
    /** Clear all pending injected failures. */
    clearFailures: () => void;
  };
  /** Optional subdirectory prefix; defaults to `suite`. */
  readonly prefix?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** All byte values 0..255 — exercises every octet. */
function allBytesPattern(length = 256): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = i % 256;
  }
  return out;
}

/** Root behavior + deterministic listing. */
async function caseRootBehavior(v: VaultService, base: WorkspacePath): Promise<void> {
  const stat = await v.stat(ROOT_PATH);
  assertEqual(stat.kind, 'directory', 'root must be a directory');
  assertEqual(stat.size, 0, 'root size must be 0');
  const entries = await v.list(ROOT_PATH);
  assertEqual(entries.length, 0, 'fresh vault root must list no entries');
  await assertVaultError(() => v.remove(ROOT_PATH), 'CONFLICT', 'root removal must be CONFLICT');
  await assertVaultError(() => v.move(ROOT_PATH, base), 'CONFLICT', 'root move must be CONFLICT');
  void base;
}

async function caseValidNestedPaths(v: VaultService, base: WorkspacePath): Promise<void> {
  await ensureDirectory(v, joinPath(base, 'nested', 'a', 'b'));
  await v.write(joinPath(base, 'nested', 'a', 'b', 'f.bin'), utf8('x'));
  const stat = await v.stat(joinPath(base, 'nested', 'a', 'b', 'f.bin'));
  assertEqual(stat.kind, 'file', 'written file must stat as a file');
  assertEqual(stat.size, 1, 'written file size must match');
}

const INVALID_PATHS: readonly string[] = [
  '/',
  '/a',
  'a/',
  'a//b',
  '.',
  '..',
  'a/../b',
  'a/./b',
  'a/..',
  'a\\b',
  '\\',
  'a\0b',
];

async function caseInvalidPaths(v: VaultService, base: WorkspacePath): Promise<void> {
  void base;
  for (const raw of INVALID_PATHS) {
    await assertVaultError(
      () => v.stat(raw as WorkspacePath),
      'INVALID_PATH',
      `path ${JSON.stringify(raw)} must be rejected with INVALID_PATH`,
    );
  }
}

async function caseBackslashHandling(v: VaultService, base: WorkspacePath): Promise<void> {
  void base;
  await assertVaultError(
    () => v.write(workspacePath('dir\\name'), utf8('x')),
    'INVALID_PATH',
    'backslash must be rejected as a portable separator',
  );
}

async function caseUnicodePreservation(v: VaultService, base: WorkspacePath): Promise<void> {
  const name = 'MixedCase-你好-😀-e\u0301.txt';
  const path = joinPath(base, 'unicode', name);
  await ensureDirectory(v, joinPath(base, 'unicode'));
  await v.write(path, utf8('unicode'));
  const readBack = await v.read(path);
  assertEqual(text(readBack), 'unicode', 'content must round-trip');
  const stat = await v.stat(path);
  assertEqual(stat.kind, 'file');
  const listing = await v.list(joinPath(base, 'unicode'));
  assertEqual(listing.length, 1, 'exactly one entry');
  const expectedName = v.capabilities.nameNormalization === 'nfc' ? name.normalize('NFC') : name;
  assertEqual(listing[0]?.name, expectedName, 'spelling must be preserved exactly (no lowercasing)');
}

async function caseNameNormalization(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'norm');
  await ensureDirectory(v, dir);
  const nfd = 'cafe\u0301.txt';
  const nfc = 'café.txt';
  await v.write(joinPath(dir, nfd), utf8('x'));
  if (v.capabilities.nameNormalization === 'nfc') {
    // The host stores NFC-normalized names: the NFC spelling must resolve
    // and the listing must show the normalized form.
    const stat = await v.stat(joinPath(dir, nfc));
    assertEqual(stat.kind, 'file', 'NFC spelling must resolve on an NFC-normalizing host');
    const listing = await v.list(dir);
    assertEqual(listing[0]?.name, nfc, 'listing must show the normalized name');
  } else {
    // Exact-spelling hosts: the exact spelling resolves, the NFC spelling
    // is a different name.
    const stat = await v.stat(joinPath(dir, nfd));
    assertEqual(stat.kind, 'file');
    await assertVaultError(
      () => v.stat(joinPath(dir, nfc)),
      'NOT_FOUND',
      'NFC spelling must not resolve on a non-normalizing host',
    );
    const listing = await v.list(dir);
    assertEqual(listing[0]?.name, nfd, 'listing must preserve the exact spelling');
  }
}

async function caseCaseBehavior(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'case');
  await ensureDirectory(v, dir);
  await v.write(joinPath(dir, 'CaseFile.bin'), utf8('x'));
  const caps: VaultCapabilities = v.capabilities;
  if (caps.caseSensitivity === 'insensitive') {
    const stat = await v.stat(joinPath(dir, 'casefile.bin'));
    assertEqual(stat.kind, 'file', 'different-case lookup must resolve on an insensitive host');
    const listing = await v.list(dir);
    assertEqual(listing.length, 1);
    assertEqual(listing[0]?.name, 'CaseFile.bin', 'the first-written spelling is preserved');
  } else if (caps.caseSensitivity === 'sensitive') {
    await assertVaultError(
      () => v.stat(joinPath(dir, 'casefile.bin')),
      'NOT_FOUND',
      'different-case lookup must fail on a sensitive host',
    );
    // Creating a differently-cased directory next to an existing one is fine.
    await v.createDirectory(joinPath(dir, 'CaseDir'));
    await v.createDirectory(joinPath(dir, 'casedir'));
  } else {
    // 'unknown': only exact lookups are guaranteed.
    const stat = await v.stat(joinPath(dir, 'CaseFile.bin'));
    assertEqual(stat.kind, 'file');
  }
}

async function caseDirectoryCreation(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'dirs', 'deep');
  await ensureDirectory(v, dir);
  await assertVaultError(
    () => v.createDirectory(dir),
    'ALREADY_EXISTS',
    'creating an existing directory must be ALREADY_EXISTS',
  );
  await assertVaultError(
    () => v.createDirectory(joinPath(base, 'missing-parent', 'x')),
    'NOT_FOUND',
    'creating a directory with a missing parent must be NOT_FOUND',
  );
  await v.write(joinPath(base, 'afile.bin'), utf8('x'));
  await assertVaultError(
    () => v.createDirectory(joinPath(base, 'afile.bin')),
    'ALREADY_EXISTS',
    'creating a directory over a file must be ALREADY_EXISTS',
  );
}

async function caseListing(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'listing');
  await ensureDirectory(v, dir);
  const names = ['zeta.txt', 'Alpha.bin', '.hidden', '01-first'];
  for (const name of names) {
    await v.write(joinPath(dir, name), utf8(name));
  }
  await v.createDirectory(joinPath(dir, 'sub'));
  const entries = await v.list(dir);
  assertEqual(entries.length, names.length + 1, 'all entries listed');
  const expected = [...names, 'sub'].sort();
  assertEqual(
    entries.map((e) => e.name).join('|'),
    expected.join('|'),
    'listing order must be deterministic code-unit order',
  );
  assertEqual(entries.find((e) => e.name === 'sub')?.kind, 'directory');
  assertEqual(entries.find((e) => e.name === '01-first')?.kind, 'file');
  const hasDotEntries = entries.some((e) => e.name === '.' || e.name === '..');
  assertEqual(hasDotEntries, false, 'listing must never include . or ..');
}

async function caseBinaryRoundTrip(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'binary');
  await ensureDirectory(v, dir);
  const data = allBytesPattern(4096);
  await v.write(joinPath(dir, 'all.bin'), data);
  const readBack = await v.read(joinPath(dir, 'all.bin'));
  assertBytesEqual(readBack, data, 'every byte value must round-trip');
}

/** Only runs when the provider supplies the optional lazy `readFile` hook. */
async function caseLazyFileRead(v: VaultService, base: WorkspacePath): Promise<void> {
  if (v.readFile === undefined) return;
  const dir = joinPath(base, 'lazy');
  await ensureDirectory(v, dir);
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  await v.write(joinPath(dir, 'lazy.bin'), data);
  const file = await v.readFile(joinPath(dir, 'lazy.bin'));
  assertEqual(file.size, data.byteLength, 'File size must match the written bytes');
  const roundTrip = new Uint8Array(await file.arrayBuffer());
  assertBytesEqual(roundTrip, data, 'File content must round-trip');
  await v.remove(joinPath(dir, 'lazy.bin'));
}

async function caseEmptyFile(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'empty');
  await ensureDirectory(v, dir);
  await v.write(joinPath(dir, 'zero.bin'), new Uint8Array(0));
  const stat = await v.stat(joinPath(dir, 'zero.bin'));
  assertEqual(stat.size, 0, 'empty file must have size 0');
  const readBack = await v.read(joinPath(dir, 'zero.bin'));
  assertEqual(readBack.byteLength, 0, 'empty file must read as zero bytes');
}

async function caseReplacement(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'replace');
  await ensureDirectory(v, dir);
  const path = joinPath(dir, 'f.bin');
  await v.write(path, utf8('first version'));
  await v.write(path, utf8('second version, longer'));
  const readBack = await v.read(path);
  assertEqual(text(readBack), 'second version, longer', 'write must replace content atomically');
  const stat = await v.stat(path);
  assertEqual(stat.size, readBack.byteLength, 'size must follow the replacement');
}

async function caseDeletion(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'delete');
  await ensureDirectory(v, dir);
  const file = joinPath(dir, 'f.bin');
  await v.write(file, utf8('x'));
  await v.remove(file);
  await assertVaultError(() => v.stat(file), 'NOT_FOUND', 'removed file must be gone');
  const sub = joinPath(dir, 'sub');
  await v.createDirectory(sub);
  await v.remove(sub);
  await assertVaultError(() => v.stat(sub), 'NOT_FOUND', 'removed empty dir must be gone');
  await v.write(joinPath(dir, 'keep.txt'), utf8('x'));
  await v.createDirectory(joinPath(dir, 'busy'));
  await v.write(joinPath(dir, 'busy', 'inner.txt'), utf8('x'));
  await assertVaultError(
    () => v.remove(joinPath(dir, 'busy')),
    'CONFLICT',
    'removing a non-empty directory must be CONFLICT',
  );
  await assertVaultError(() => v.remove(joinPath(dir, 'missing.bin')), 'NOT_FOUND');
  await assertVaultError(() => v.remove(joinPath(base, 'missing-deep', 'x')), 'NOT_FOUND');
}

async function caseNotFound(v: VaultService, base: WorkspacePath): Promise<void> {
  void base;
  const missing = workspacePath('definitely-missing.bin');
  await assertVaultError(() => v.stat(missing), 'NOT_FOUND');
  await assertVaultError(() => v.read(missing), 'NOT_FOUND');
  await assertVaultError(() => v.list(missing), 'NOT_FOUND');
  await assertVaultError(() => v.remove(missing), 'NOT_FOUND');
}

async function caseKindErrors(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'kinds');
  await ensureDirectory(v, dir);
  const file = joinPath(dir, 'f.bin');
  await v.write(file, utf8('x'));
  await assertVaultError(() => v.list(file), 'NOT_DIRECTORY', 'listing a file must be NOT_DIRECTORY');
  await assertVaultError(() => v.read(dir), 'IS_DIRECTORY', 'reading a dir must be IS_DIRECTORY');
  await assertVaultError(
    () => v.write(dir, utf8('x')),
    'IS_DIRECTORY',
    'writing over a dir must be IS_DIRECTORY',
  );
  await assertVaultError(
    () => v.read(joinPath(dir, 'missing', 'deep.bin')),
    'NOT_FOUND',
    'reading through a missing parent must be NOT_FOUND',
  );
}

async function caseMove(v: VaultService, base: WorkspacePath): Promise<void> {
  const dir = joinPath(base, 'move');
  await ensureDirectory(v, dir);
  const file = joinPath(dir, 'f.bin');
  await v.write(file, utf8('movable'));
  await v.move(file, joinPath(dir, 'g.bin'));
  await assertVaultError(() => v.read(file), 'NOT_FOUND', 'source must be gone after move');
  assertEqual(text(await v.read(joinPath(dir, 'g.bin'))), 'movable');
  // Directory subtree move.
  await ensureDirectory(v, joinPath(dir, 'subtree', 'deep'));
  await v.write(joinPath(dir, 'subtree', 'deep', 'inner.txt'), utf8('inner'));
  await v.move(joinPath(dir, 'subtree'), joinPath(dir, 'moved'));
  assertEqual(text(await v.read(joinPath(dir, 'moved', 'deep', 'inner.txt'))), 'inner');
  // Target exists → CONFLICT.
  await assertVaultError(
    () => v.move(joinPath(dir, 'g.bin'), joinPath(dir, 'moved')),
    'CONFLICT',
    'moving onto an existing target must be CONFLICT',
  );
  // Missing source → NOT_FOUND.
  await assertVaultError(
    () => v.move(joinPath(dir, 'missing.bin'), joinPath(dir, 'x.bin')),
    'NOT_FOUND',
  );
  // Moving into own subtree → CONFLICT.
  await assertVaultError(
    () => v.move(joinPath(dir, 'moved'), joinPath(dir, 'moved', 'deep')),
    'CONFLICT',
    'moving a path into its own subtree must be CONFLICT',
  );
}

async function caseAtomicityDeclared(v: VaultService, base: WorkspacePath): Promise<void> {
  if (!v.capabilities.atomicReplace) {
    return;
  }
  const dir = joinPath(base, 'atomic');
  await ensureDirectory(v, dir);
  const path = joinPath(dir, 'big.bin');
  const big = allBytesPattern(64 * 1024);
  await v.write(path, big);
  const readBack = await v.read(path);
  assertBytesEqual(readBack, big, 'completed write must be fully readable (atomicReplace)');
}

async function caseFailedWriteKeepsPrevious(
  v: VaultService,
  base: WorkspacePath,
  failureInjection: NonNullable<VaultContractSuiteOptions['failureInjection']>,
): Promise<void> {
  const dir = joinPath(base, 'failwrite');
  await ensureDirectory(v, dir);
  const path = joinPath(dir, 'f.bin');
  await v.write(path, utf8('original'));
  failureInjection.failNextWrite();
  try {
    await assertVaultError(
      () => v.write(path, utf8('replacement that will fail')),
      'IO',
      'injected failure must surface as a structured IO error',
    );
  } finally {
    failureInjection.clearFailures();
  }
  // The failed write must not corrupt anything: previous content readable,
  // tree structurally intact.
  assertEqual(text(await v.read(path)), 'original', 'previous content must remain readable');
  const entries = await v.list(dir);
  assertEqual(entries.length, 1, 'no stray entries after a failed write');
  assertEqual(entries[0]?.name, 'f.bin');
  // After clearing the failure the same write succeeds.
  await v.write(path, utf8('replacement'));
  assertEqual(text(await v.read(path)), 'replacement');
}

async function caseReopen(
  v: VaultService,
  base: WorkspacePath,
  reopen: () => VaultService | Promise<VaultService>,
): Promise<void> {
  const dir = joinPath(base, 'reopen');
  await ensureDirectory(v, dir);
  const path = joinPath(dir, 'persist.bin');
  await v.write(path, utf8('persisted across instances'));
  await v.createDirectory(joinPath(dir, 'sub'));
  const fresh = await reopen();
  assertEqual(
    text(await fresh.read(path)),
    'persisted across instances',
    'a fresh instance over the same backing state must see prior data',
  );
  const stat = await fresh.stat(path);
  assertEqual(stat.kind, 'file');
  const listing = await fresh.list(dir);
  assertEqual(listing.length, 2, 'reopened listing must match');
  const kinds = listing.map((e) => e.kind).sort();
  assertEqual(kinds.join('|'), 'directory|file');
}

async function caseAbortSignal(v: VaultService, base: WorkspacePath): Promise<void> {
  void base;
  const controller = new AbortController();
  controller.abort();
  const options: VaultOperationOptions = { signal: controller.signal };
  await assertVaultError(
    () => v.stat(ROOT_PATH, options),
    'ABORTED',
    'an aborted signal must reject with ABORTED',
  );
}

/** Build the full contract suite for one provider. */
export function createVaultContractSuite(
  options: VaultContractSuiteOptions,
): readonly VaultContractCase[] {
  const { provider: v, failureInjection, reopen } = options;
  const prefix: WorkspacePath = (options.prefix ?? 'suite') as WorkspacePath;
  const cases: VaultContractCase[] = [
    {
      name: 'root behavior',
      run: async () => {
        await runCase(v, joinPath(prefix, 'root'), caseRootBehavior);
      },
    },
    {
      name: 'valid nested paths',
      run: async () => {
        await runCase(v, joinPath(prefix, 'nested'), caseValidNestedPaths);
      },
    },
    {
      name: 'invalid path rejection',
      run: async () => {
        await runCase(v, joinPath(prefix, 'invalid'), caseInvalidPaths);
      },
    },
    {
      name: 'backslash handling',
      run: async () => {
        await runCase(v, joinPath(prefix, 'backslash'), caseBackslashHandling);
      },
    },
    {
      name: 'Unicode preservation',
      run: async () => {
        await runCase(v, joinPath(prefix, 'unicode'), caseUnicodePreservation);
      },
    },
    {
      name: 'name normalization per declared semantics',
      run: async () => {
        await runCase(v, joinPath(prefix, 'norm'), caseNameNormalization);
      },
    },
    {
      name: 'case behavior per declared semantics',
      run: async () => {
        await runCase(v, joinPath(prefix, 'case'), caseCaseBehavior);
      },
    },
    {
      name: 'directory creation',
      run: async () => {
        await runCase(v, joinPath(prefix, 'dirs'), caseDirectoryCreation);
      },
    },
    {
      name: 'deterministic listing',
      run: async () => {
        await runCase(v, joinPath(prefix, 'listing'), caseListing);
      },
    },
    {
      name: 'binary round-trip',
      run: async () => {
        await runCase(v, joinPath(prefix, 'binary'), caseBinaryRoundTrip);
      },
    },
    {
      name: 'empty file',
      run: async () => {
        await runCase(v, joinPath(prefix, 'empty'), caseEmptyFile);
      },
    },
    {
      name: 'replacement',
      run: async () => {
        await runCase(v, joinPath(prefix, 'replace'), caseReplacement);
      },
    },
    {
      name: 'deletion',
      run: async () => {
        await runCase(v, joinPath(prefix, 'delete'), caseDeletion);
      },
    },
    {
      name: 'not-found',
      run: async () => {
        await runCase(v, joinPath(prefix, 'notfound'), caseNotFound);
      },
    },
    {
      name: 'directory/file kind errors',
      run: async () => {
        await runCase(v, joinPath(prefix, 'kinds'), caseKindErrors);
      },
    },
    {
      name: 'move',
      run: async () => {
        await runCase(v, joinPath(prefix, 'move'), caseMove);
      },
    },
    {
      name: 'atomicity declaration is truthful',
      run: async () => {
        await runCase(v, joinPath(prefix, 'atomic'), caseAtomicityDeclared);
      },
    },
    {
      name: 'abort signal',
      run: async () => {
        await runCase(v, joinPath(prefix, 'abort'), caseAbortSignal);
      },
    },
  ];

  if (failureInjection) {
    cases.push({
      name: 'failed write leaves previous content readable and the tree valid',
      run: async () => {
        await runCase(v, joinPath(prefix, 'failwrite'), (vault, base) =>
          caseFailedWriteKeepsPrevious(vault, base, failureInjection),
        );
      },
    });
  }

  if (v.readFile !== undefined) {
    cases.push({
      name: 'lazy file read returns full contents as a File',
      run: async () => {
        await runCase(v, joinPath(prefix, 'lazyread'), caseLazyFileRead);
      },
    });
  }

  if (reopen) {
    cases.push({
      name: 'persistence: fresh instance over the same backing state sees prior data',
      run: async () => {
        await runCase(v, joinPath(prefix, 'reopen'), (vault, base) => caseReopen(vault, base, reopen));
      },
    });
  }

  cases.push({
    name: 'suite leaves the vault root structurally clean',
    run: async () => {
      // Remove the shared prefix directory itself (each case already removed
      // its own subtree; recursion covers any leftovers).
      await removeTree(v, prefix);
      const entries = await v.list(ROOT_PATH);
      assertEqual(
        entries.length,
        0,
        'every suite case must clean up after itself (root must be empty)',
      );
    },
  });

  return cases;
}

async function runCase(
  v: VaultService,
  base: WorkspacePath,
  body: (vault: VaultService, base: WorkspacePath) => Promise<void>,
): Promise<void> {
  try {
    await body(v, base);
  } finally {
    await removeTree(v, base);
  }
}

/**
 * Best-effort recursive removal, portable across providers (no
 * `removeRecursive` exists on the contract).
 */
async function removeTree(v: VaultService, path: WorkspacePath): Promise<void> {
  let stat;
  try {
    stat = await v.stat(path);
  } catch {
    return; // already gone
  }
  if (stat.kind === 'directory') {
    for (const entry of await v.list(path)) {
      await removeTree(v, joinPath(path, entry.name));
    }
  }
  try {
    await v.remove(path);
  } catch (error) {
    const code = isVaultError(error) ? error.code : null;
    if (code !== 'NOT_FOUND') {
      throw error;
    }
  }
}

