/**
 * Mobile (Android/iOS) vault contract suite + native-bridge edge cases.
 *
 * `mobileVaults` speaks to the owned `froglight-vault-storage` plugin over
 * Tauri mobile IPC. Here the IPC layer is a strict in-memory fake of a
 * native content provider (folder handles, SAF-style tree ops, bookmark
 * lifecycle), and the suite drives the REAL `mobileVaults` + `TauriVault`
 * code through the shared portable contract — the same suite the desktop,
 * memory, and OPFS providers prove.
 *
 * The fake mirrors the validation the real backends must enforce (strict
 *  Paths, structured codes including IS_DIRECTORY / NOT_DIRECTORY /
 * ALREADY_EXISTS / CONFLICT from the extended `VaultStorageError` taxonomy).
 * Where the real Swift/Kotlin implementations cannot yet be executed in CI,
 * focused tests pin the exact request/response shapes they must honor.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import type {
  InvokeArgs,
  InvokeOptions as TauriInvokeOptions,
} from '@tauri-apps/api/core';
import { TauriVault, createNativeVaultAdapter } from './tauri-vault.js';
import { isMobileVaultUnsupported, mobileVaults } from './mobile-vault.js';
import { VaultError, workspacePath } from '@froglight/foundation';
import type { WorkspacePath } from '@froglight/foundation';
import { registerVaultContractSuite } from '@froglight/foundation/testing';
import { base64ToBytes, bytesToBase64 } from './derived-cache-storage.js';

const mockInvoke = vi.mocked(invoke);

const PLUGIN = 'plugin:froglight-vault-storage';
const TEST_FOLDER = 'test-folder';
const MOBILE_VAULT_ID = `mobile-vault:${encodeURIComponent(TEST_FOLDER)}|${encodeURIComponent('')}`;

type InvokePayload = unknown;
type InvokeOptions = TauriInvokeOptions | undefined;

function readHeader(options: InvokeOptions, name: string): string | undefined {
  return new Headers(options?.headers).get(name) ?? undefined;
}

interface FakeNode {
  readonly kind: 'file' | 'dir';
  bytes?: Uint8Array;
  children?: Map<string, FakeNode>;
  modifiedSec?: number;
}

interface FakeFolder {
  readonly id: string;
  readonly name: string;
  readonly uri: string;
  readonly root: FakeNode;
}

function fail(code: string, message: string): never {
  throw { code, message };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function dirNode(): FakeNode {
  return { kind: 'dir', children: new Map(), modifiedSec: nowSec() };
}

function fileNode(bytes: Uint8Array): FakeNode {
  return { kind: 'file', bytes: bytes.slice(), modifiedSec: nowSec() };
}

function decodeWritePayload(value: unknown): Uint8Array {
  if (typeof value !== 'string')
    fail('INVALID_ARGUMENT', 'data must be base64');
  const bytes = base64ToBytes(value);
  if (bytesToBase64(bytes) !== value)
    fail('INVALID_ARGUMENT', 'data must be canonical base64');
  return bytes;
}

/** Strict validation, mirroring commands.rs / path.rs. */
function splitMobilePath(input: string | undefined): string[] {
  if (input === undefined || input === '') return [];
  if (input.includes('\0') || input.includes('\\'))
    fail('INVALID_PATH', `invalid path: ${input}`);
  if (input.startsWith('/') || input.endsWith('/'))
    fail('INVALID_PATH', `invalid path: ${input}`);
  const segments = input.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      fail('INVALID_PATH', `invalid path: ${input}`);
    }
  }
  return segments;
}

class FakeNativeBackend {
  readonly folders = new Map<string, FakeFolder>();
  failNextWrite = false;

  constructor() {
    this.addFolder(TEST_FOLDER, 'Files', 'content://test/vault');
  }

  addFolder(id: string, name: string, uri: string): FakeFolder {
    const folder: FakeFolder = { id, name, uri, root: dirNode() };
    this.folders.set(id, folder);
    return folder;
  }

  removeFolder(id: string): void {
    this.folders.delete(id);
  }

  requireFolder(id: string): FakeFolder {
    const folder = this.folders.get(id);
    if (!folder) fail('FOLDER_NOT_FOUND', `folder not found: ${id}`);
    return folder as FakeFolder;
  }

  /** Resolve to parent + leaf name; root resolves to { node: root, name: null }. */
  private resolve(
    folder: FakeFolder,
    mobilePath: string | undefined,
  ): { parent: FakeNode | null; name: string | null; node: FakeNode | null } {
    const segments = splitMobilePath(mobilePath);
    let node: FakeNode = folder.root;
    for (const segment of segments.slice(0, -1)) {
      const child = node.children?.get(segment);
      if (!child || child.kind !== 'dir')
        fail('NOT_FOUND', `not found: ${mobilePath}`);
      node = child as FakeNode;
    }
    if (segments.length === 0)
      return { parent: null, name: null, node: folder.root };
    const name = segments[segments.length - 1] as string;
    const leaf = (node.children as Map<string, FakeNode>).get(name) ?? null;
    return { parent: node, name, node: leaf };
  }

  async dispatch(
    command: string,
    payload: InvokePayload,
    options?: InvokeOptions,
  ): Promise<unknown> {
    let requestPayload = payload;
    if (command === `${PLUGIN}|write_file` && payload instanceof Uint8Array) {
      const encodedMetadata =
        readHeader(options, 'x-froglight-vault-write') ?? '';
      const metadata = JSON.parse(
        new TextDecoder().decode(base64ToBytes(encodedMetadata)),
      ) as { folderId: string; path: string };
      requestPayload = {
        req: { ...metadata, data: bytesToBase64(payload) },
      };
    }
    const payloadRecord =
      typeof requestPayload === 'object' && requestPayload !== null
        ? (requestPayload as Record<string, unknown>)
        : {};
    const req = (payloadRecord['req'] ?? payloadRecord) as Record<
      string,
      unknown
    >;
    switch (command) {
      case `${PLUGIN}|pick_folder`:
        return { id: TEST_FOLDER, name: 'Files', uri: 'content://test/vault' };
      case `${PLUGIN}|list_folders`:
        return [...this.folders.values()].map((f) => ({
          id: f.id,
          name: f.name,
          uri: f.uri,
        }));
      case `${PLUGIN}|mkdir`: {
        const folder = this.requireFolder(req['folderId'] as string);
        const { parent, name, node } = this.resolve(
          folder,
          req['path'] as string,
        );
        if (node) fail('ALREADY_EXISTS', `already exists: ${req['path']}`);
        if (!parent || !name) fail('INVALID_PATH', 'path must not be empty');
        if (req['recursive'] === true) {
          // Recursive creation (currently unused by the TS adapter).
          let node_: FakeNode = folder.root;
          for (const segment of splitMobilePath(req['path'] as string)) {
            let child = node_.children?.get(segment);
            if (!child) {
              child = dirNode();
              (node_.children as Map<string, FakeNode>).set(segment, child);
            } else if (child.kind !== 'dir') {
              fail('ALREADY_EXISTS', `already exists: ${segment}`);
            }
            node_ = child as FakeNode;
          }
          return undefined;
        }
        (parent?.children as Map<string, FakeNode>).set(
          name as string,
          dirNode(),
        );
        return undefined;
      }
      case `${PLUGIN}|read_dir`: {
        const folder = this.requireFolder(req['folderId'] as string);
        const { node } = this.resolve(
          folder,
          req['path'] as string | undefined,
        );
        if (!node) fail('NOT_FOUND', `not found: ${req['path']}`);
        if ((node as FakeNode).kind !== 'dir')
          fail('NOT_DIRECTORY', `not a directory: ${req['path']}`);
        const dir = node as FakeNode;
        // Deliberately reverse-sorted: the TS adapter must impose code-unit order.
        return [...(dir.children as Map<string, FakeNode>).entries()]
          .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
          .map(([name, child]) => ({
            name,
            path: name,
            isFile: child.kind === 'file',
            isDir: child.kind === 'dir',
            size:
              child.kind === 'file'
                ? (child.bytes as Uint8Array).byteLength
                : 0,
            mimeType: null,
            lastModified: child.modifiedSec ?? null,
          }));
      }
      case `${PLUGIN}|stat`: {
        const folder = this.requireFolder(req['folderId'] as string);
        const mobilePath = req['path'] as string;
        if (mobilePath === '') fail('INVALID_PATH', 'path must not be empty');
        const { node } = this.resolve(folder, mobilePath);
        if (!node) fail('NOT_FOUND', `not found: ${mobilePath}`);
        const target = node as FakeNode;
        const name = mobilePath.split('/').at(-1) as string;
        return {
          name,
          path: mobilePath,
          isFile: target.kind === 'file',
          isDir: target.kind === 'dir',
          size:
            target.kind === 'file'
              ? (target.bytes as Uint8Array).byteLength
              : 0,
          mimeType: null,
          lastModified: target.modifiedSec ?? null,
        };
      }
      case `${PLUGIN}|read_file`: {
        const folder = this.requireFolder(req['folderId'] as string);
        const { node } = this.resolve(folder, req['path'] as string);
        if (!node) fail('NOT_FOUND', `not found: ${req['path']}`);
        if ((node as FakeNode).kind !== 'file')
          fail('IS_DIRECTORY', `is a directory: ${req['path']}`);
        return {
          data: bytesToBase64((node as FakeNode).bytes as Uint8Array),
        };
      }
      case `${PLUGIN}|write_file`: {
        if (this.failNextWrite) {
          this.failNextWrite = false;
          fail('IO', 'injected native write failure');
        }
        const folder = this.requireFolder(req['folderId'] as string);
        const { parent, name, node } = this.resolve(
          folder,
          req['path'] as string,
        );
        if (!parent || !name) fail('INVALID_PATH', 'path must not be empty');
        if (node && node.kind === 'dir')
          fail('IS_DIRECTORY', `is a directory: ${req['path']}`);
        (parent?.children as Map<string, FakeNode>).set(
          name as string,
          fileNode(decodeWritePayload(req['data'])),
        );
        return undefined;
      }
      case `${PLUGIN}|remove_file`: {
        const folder = this.requireFolder(req['folderId'] as string);
        const { parent, name, node } = this.resolve(
          folder,
          req['path'] as string,
        );
        if (!node) fail('NOT_FOUND', `not found: ${req['path']}`);
        if ((node as FakeNode).kind !== 'file')
          fail('INVALID_ARGUMENT', 'not a file');
        (parent?.children as Map<string, FakeNode>).delete(name as string);
        return undefined;
      }
      case `${PLUGIN}|remove_dir`: {
        const folder = this.requireFolder(req['folderId'] as string);
        const mobilePath = req['path'] as string;
        if (mobilePath === '') fail('CONFLICT', 'cannot remove the vault root');
        const { parent, name, node } = this.resolve(folder, mobilePath);
        if (!node) fail('NOT_FOUND', `not found: ${mobilePath}`);
        if (
          (node as FakeNode).kind !== 'file' &&
          (node as FakeNode).kind !== 'dir'
        ) {
          fail('NOT_FOUND', `not found: ${mobilePath}`);
        }
        if ((node as FakeNode).kind !== 'dir')
          fail('INVALID_ARGUMENT', 'not a directory');
        const dir = node as FakeNode;
        if (
          (dir.children as Map<string, FakeNode>).size > 0 &&
          req['recursive'] !== true
        ) {
          // Contract parity: a non-empty directory is CONFLICT, never silent
          // recursion. (See the iOS divergence note in the edge-case suite.)
          fail('CONFLICT', `directory not empty: ${mobilePath}`);
        }
        (parent?.children as Map<string, FakeNode>).delete(name as string);
        return undefined;
      }
      case `${PLUGIN}|rename`: {
        const folder = this.requireFolder(req['folderId'] as string);
        const from = req['fromPath'] as string;
        const to = req['toPath'] as string;
        if (from === '' || to === '')
          fail('CONFLICT', 'cannot move the vault root');
        const src = this.resolve(folder, from);
        if (!src.node) fail('NOT_FOUND', `not found: ${from}`);
        if (to === from || to.startsWith(`${from}/`))
          fail('CONFLICT', 'invalid move target');
        const dst = this.resolve(folder, to);
        if (!dst.parent || !dst.name)
          fail('INVALID_PATH', 'invalid move target');
        if (dst.node) fail('CONFLICT', `target exists: ${to}`);
        (src.parent?.children as Map<string, FakeNode>).delete(
          src.name as string,
        );
        (dst.parent.children as Map<string, FakeNode>).set(
          dst.name,
          src.node as FakeNode,
        );
        return undefined;
      }
      default:
        throw new Error(`unexpected native command: ${command}`);
    }
  }
}

const backend = new FakeNativeBackend();

function desktopInvoke(): Promise<never> {
  throw new Error('desktop IPC must not be called for mobile vault ids');
}

beforeEach(() => {
  mockInvoke.mockImplementation(
    (command: string, payload?: InvokeArgs, options?: InvokeOptions) =>
      backend.dispatch(command, payload as InvokePayload, options),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('mobileVaults contract suite (fake native content provider)', () => {
  const provider = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
  registerVaultContractSuite('mobileVaults (fake SAF/File Provider)', {
    provider,
    prefix: 'mobile',
    reopen: () => new TauriVault(MOBILE_VAULT_ID, desktopInvoke),
    failureInjection: {
      failNextWrite: () => {
        backend.failNextWrite = true;
      },
      clearFailures: () => {
        backend.failNextWrite = false;
      },
    },
  });
});

describe('mobile vault native-bridge edge cases', () => {
  it('permission denial propagates as structured PERMISSION_DENIED', async () => {
    mockInvoke.mockRejectedValueOnce({
      code: 'PERMISSION_DENIED',
      message: 'no access',
    });
    await expect(
      mobileVaults.stat(MOBILE_VAULT_ID, workspacePath('a.txt')),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    mockInvoke.mockRejectedValueOnce({
      code: 'PERMISSION_DENIED',
      message: 'no access',
    });
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    const error = await vault.read(workspacePath('a.txt')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('stale bookmarks surface as PERMISSION_DENIED, never raw payloads', async () => {
    mockInvoke.mockRejectedValueOnce({
      code: 'STALE_BOOKMARK',
      message: 'bookmark stale',
    });
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    await expect(vault.stat(workspacePath('a.txt'))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('malformed vault ids are structured NOT_FOUND, never a URIError crash', async () => {
    for (const badId of [
      'plain-garbage',
      'mobile-vault:no-separator',
      'mobile-vault:%|x',
      'mobile-vault:%ZZ|root',
      'mobile-vault:test-folder|a%2',
    ]) {
      await expect(
        mobileVaults.stat(badId, workspacePath('a.txt')),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    const vault = new TauriVault('mobile-vault:%|x', desktopInvoke);
    await expect(vault.list(workspacePath(''))).rejects.toBeInstanceOf(
      VaultError,
    );
  });

  it('invalid folder names are rejected before touching native storage', async () => {
    const calls = mockInvoke.mock.calls.length;
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
      await expect(
        mobileVaults.createVault(MOBILE_VAULT_ID, bad),
      ).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    }
    // No native call was issued for any invalid name.
    expect(mockInvoke.mock.calls.length).toBe(calls);
  });

  it('a folder deleted behind its bookmark disappears from recents', async () => {
    backend.addFolder('temp-folder', 'Temp', 'content://test/temp');
    mockInvoke.mockImplementationOnce(async () => ({
      id: 'temp-folder',
      name: 'Temp',
      uri: 'content://test/temp',
    }));
    const picked = await mobileVaults.pickDirectory(true);
    expect(picked).not.toBeNull();
    expect((await mobileVaults.listRecent()).map((r) => r.id)).toContain(
      picked?.id,
    );

    // The OS revokes/deletes the folder out from under the bookmark.
    backend.removeFolder('temp-folder');
    expect((await mobileVaults.listRecent()).map((r) => r.id)).not.toContain(
      picked?.id,
    );
    if (picked) await mobileVaults.forget(picked.id);
  });

  it('access to a revoked folder reports FOLDER_NOT_FOUND through the adapter', async () => {
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    mockInvoke.mockRejectedValueOnce({
      code: 'FOLDER_NOT_FOUND',
      message: 'gone',
    });
    await expect(vault.stat(workspacePath('a.txt'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('interrupted mobile writes preserve previous content', async () => {
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    const path = workspacePath('mobile/interrupted.txt');
    await backend.dispatch(`${PLUGIN}|mkdir`, {
      req: { folderId: TEST_FOLDER, path: 'mobile' },
    });
    await vault.write(path, new TextEncoder().encode('before'));
    backend.failNextWrite = true;
    await expect(
      vault.write(path, new TextEncoder().encode('after')),
    ).rejects.toMatchObject({
      code: 'IO',
    });
    expect(new TextDecoder().decode(await vault.read(path))).toBe('before');
  });

  it('round-trips all byte values through the compact write request and preserves native errors', async () => {
    const seen: Array<{
      command: string;
      payload: unknown;
      options?: InvokeOptions;
    }> = [];
    mockInvoke.mockImplementation(
      async (
        command: string,
        payload?: InvokeArgs,
        options?: InvokeOptions,
      ) => {
        seen.push({ command, payload, options });
        return backend.dispatch(command, payload as InvokePayload, options);
      },
    );
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    const path = workspacePath('compact-write/all-bytes.bin');
    await vault.createDirectory(workspacePath('compact-write'));
    const bytes = Uint8Array.from({ length: 256 }, (_, value) => value);

    await vault.write(path, bytes);

    const request = seen.find((entry) => entry.command.endsWith('|write_file'));
    expect(request?.payload).toEqual(bytes);
    expect(readHeader(request?.options, 'x-froglight-vault-write')).toBe(
      bytesToBase64(
        new TextEncoder().encode(
          JSON.stringify({
            folderId: TEST_FOLDER,
            path: 'compact-write/all-bytes.bin',
          }),
        ),
      ),
    );
    expect(await vault.read(path)).toEqual(bytes);

    backend.failNextWrite = true;
    await expect(vault.write(path, bytes)).rejects.toMatchObject({
      code: 'IO',
    });
    expect(await vault.read(path)).toEqual(bytes);
  });

  it('rejects malformed base64 payloads without creating a file', async () => {
    await backend.dispatch(`${PLUGIN}|mkdir`, {
      req: { folderId: TEST_FOLDER, path: 'malformed-write' },
    });
    await expect(
      backend.dispatch(`${PLUGIN}|write_file`, {
        req: {
          folderId: TEST_FOLDER,
          path: 'malformed-write/malformed.bin',
          data: '%%%=',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      backend.dispatch(`${PLUGIN}|stat`, {
        req: { folderId: TEST_FOLDER, path: 'malformed-write/malformed.bin' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('uses compact base64 JSON on Android where raw request bodies are unavailable', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Android' });
    const seen: Array<{ command: string; payload: unknown }> = [];
    mockInvoke.mockImplementation(
      async (command: string, payload?: InvokeArgs) => {
        seen.push({ command, payload });
        return backend.dispatch(command, payload as InvokePayload);
      },
    );
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    const path = workspacePath('android-compact.bin');
    const bytes = Uint8Array.from({ length: 256 }, (_, value) => value);

    await vault.write(path, bytes);

    const request = seen.find((entry) => entry.command.endsWith('|write_file'))
      ?.payload as { req: { data: unknown } };
    expect(request.req.data).toBe(bytesToBase64(bytes));
    expect(await vault.read(path)).toEqual(bytes);
  });

  it('yields to input during large mobile save and read transport', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Android' });
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    const path = workspacePath('large-transport.bin');
    const bytes = new Uint8Array(1024 * 1024 + 5).fill(173);
    let input = false;
    const saveInput = setTimeout(() => { input = true; }, 0);
    try {
      await vault.write(path, bytes);
      expect(input).toBe(true);
    } finally {
      clearTimeout(saveInput);
    }
    input = false;
    const readInput = setTimeout(() => { input = true; }, 0);
    try {
      const restored = await vault.read(path);
      expect(input).toBe(true);
      expect(restored).toEqual(bytes);
    } finally {
      clearTimeout(readInput);
    }
  });

  it('non-empty directory removal is CONFLICT (iOS parity requirement)', async () => {
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    await vault.createDirectory(workspacePath('mobile/busy'));
    await vault.write(workspacePath('mobile/busy/f.txt'), new Uint8Array([1]));
    // The iOS implementation previously returned INVALID_ARGUMENT here,
    // diverging from the portable contract. The required code is CONFLICT.
    await expect(
      vault.remove(workspacePath('mobile/busy')),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await vault.remove(workspacePath('mobile/busy/f.txt'));
    await vault.remove(workspacePath('mobile/busy'));
  });

  it('emits the exact native request shapes Swift/Kotlin must honor', async () => {
    const seen: Array<{
      command: string;
      payload: unknown;
      options?: InvokeOptions;
    }> = [];
    mockInvoke.mockImplementation(
      async (
        command: string,
        payload?: InvokeArgs,
        options?: InvokeOptions,
      ) => {
        seen.push({ command, payload, options });
        return backend.dispatch(command, payload as InvokePayload, options);
      },
    );
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    await vault.createDirectory(workspacePath('mobile/shapes'));
    await vault.write(
      workspacePath('mobile/shapes/f.bin'),
      new Uint8Array([7, 8]),
    );
    await vault.read(workspacePath('mobile/shapes/f.bin'));
    await vault.move(
      workspacePath('mobile/shapes/f.bin'),
      workspacePath('mobile/shapes/g.bin'),
    );
    await vault.remove(workspacePath('mobile/shapes/g.bin'));
    await vault.remove(workspacePath('mobile/shapes'));

    const find = (suffix: string) =>
      seen.find((s) => s.command === `${PLUGIN}|${suffix}`)?.payload as {
        req: Record<string, unknown>;
      };
    expect(find('mkdir').req).toMatchObject({
      folderId: TEST_FOLDER,
      path: 'mobile/shapes',
      recursive: false,
    });
    const writeCall = seen.find((s) => s.command === `${PLUGIN}|write_file`);
    expect(writeCall?.payload).toEqual(new Uint8Array([7, 8]));
    expect(readHeader(writeCall?.options, 'x-froglight-vault-write')).toBe(
      bytesToBase64(
        new TextEncoder().encode(
          JSON.stringify({
            folderId: TEST_FOLDER,
            path: 'mobile/shapes/f.bin',
          }),
        ),
      ),
    );
    expect(find('read_file').req).toMatchObject({
      folderId: TEST_FOLDER,
      path: 'mobile/shapes/f.bin',
    });
    expect(find('rename').req).toMatchObject({
      folderId: TEST_FOLDER,
      fromPath: 'mobile/shapes/f.bin',
      toPath: 'mobile/shapes/g.bin',
    });
    expect(find('remove_dir').req).toMatchObject({
      folderId: TEST_FOLDER,
      path: 'mobile/shapes',
      recursive: false,
    });
  });

  it('adapter openVault resolves null on picker cancel without touching storage', async () => {
    mockInvoke.mockRejectedValueOnce({
      code: 'CANCELLED',
      message: 'user cancelled',
    });
    const bridge = {
      listRecent: async () => [],
      pickDirectory: (registerRecent: boolean) =>
        mobileVaults.pickDirectory(registerRecent),
      createVault: (...args: [string, string]) =>
        mobileVaults.createVault(...args),
      markOpened: (...args: [string]) => mobileVaults.markOpened(...args),
      forget: (...args: [string]) => mobileVaults.forget(...args),
    };
    const controller = {
      openVault: (..._args: unknown[]) => Promise.resolve(undefined),
      listDocuments: () => [],
    };
    const adapter = createNativeVaultAdapter(controller, bridge);
    await expect(adapter.openVault()).resolves.toBeNull();
    expect(
      isMobileVaultUnsupported({ code: 'UNSUPPORTED', message: 'x' }),
    ).toBe(true);
  });

  it('aborted mobile operations reject with ABORTED before IPC', async () => {
    const vault = new TauriVault(MOBILE_VAULT_ID, desktopInvoke);
    const controller = new AbortController();
    controller.abort();
    const calls = mockInvoke.mock.calls.length;
    expect(() =>
      vault.list('' as WorkspacePath, { signal: controller.signal }),
    ).toThrow(expect.objectContaining({ code: 'ABORTED' }));
    expect(mockInvoke.mock.calls.length).toBe(calls);
  });
});
