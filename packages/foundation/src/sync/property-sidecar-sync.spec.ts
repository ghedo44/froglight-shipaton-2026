import { describe, expect, it } from 'vitest';
import { workspacePath } from '../paths.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import { createMemoryVault } from '../vault/memory.js';
import type { SyncBase } from './contract.js';
import { reconcileVault, type ReconcileResult } from './engine.js';
import { isDefaultExcludedSyncPath } from './exclude.js';
import { MemorySyncRemote } from './remote-memory.js';

const VAULT_ID = 'property-sidecar-vault';
const PROPERTY_PATH = '.froglight/properties/member-1.json';

interface Device {
  readonly vault: VaultService;
  base: SyncBase | null;
}

function propertyRecord(
  values: Record<string, unknown>,
  relations: readonly string[] = [],
): string {
  return JSON.stringify({
    format: 'froglight.properties',
    version: 1,
    owner: 'member-1',
    values,
    relations,
  });
}

async function write(vault: VaultService, path: string, text: string) {
  const parent = path.split('/').slice(0, -1).join('/');
  if (parent) await ensureDirectory(vault, workspacePath(parent));
  await vault.write(workspacePath(path), new TextEncoder().encode(text));
}

async function makeDevice(files: Record<string, string> = {}): Promise<Device> {
  const { vault } = createMemoryVault();
  for (const [path, text] of Object.entries(files))
    await write(vault, path, text);
  return { vault, base: null };
}

async function sync(
  device: Device,
  remote: MemorySyncRemote,
  deviceId: string,
): Promise<ReconcileResult> {
  const result = await reconcileVault({
    vault: device.vault,
    remote,
    vaultId: VAULT_ID,
    name: 'Properties',
    base: device.base,
    deviceId,
    exclude: isDefaultExcludedSyncPath,
  });
  device.base = result.base;
  return result;
}

async function readJson(vault: VaultService, path = PROPERTY_PATH) {
  return JSON.parse(
    new TextDecoder().decode(await vault.read(workspacePath(path))),
  ) as Record<string, unknown>;
}

async function paths(vault: VaultService, dir = ''): Promise<string[]> {
  const result: string[] = [];
  for (const child of await vault.list(workspacePath(dir))) {
    const path = dir ? `${dir}/${child.name}` : child.name;
    if (child.kind === 'directory') result.push(...(await paths(vault, path)));
    else result.push(path);
  }
  return result.sort();
}

describe('property sidecars across two replicas', () => {
  it('semantically merges acknowledged edits to different fields', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({
      [PROPERTY_PATH]: propertyRecord({ status: 'todo', priority: 1 }),
    });
    const b = await makeDevice();
    await sync(a, remote, 'device-a');
    await sync(b, remote, 'device-b');

    await write(
      a.vault,
      PROPERTY_PATH,
      propertyRecord({ status: 'doing', priority: 1 }),
    );
    await write(
      b.vault,
      PROPERTY_PATH,
      propertyRecord({ status: 'todo', priority: 2 }),
    );
    await sync(a, remote, 'device-a');
    const merged = await sync(b, remote, 'device-b');

    expect(merged.conflicts).toEqual([]);
    expect((await readJson(b.vault))['values']).toEqual({
      priority: 2,
      status: 'doing',
    });
    expect(
      (await paths(b.vault)).filter((path) => path.includes('.conflict-')),
    ).toEqual([]);

    await sync(a, remote, 'device-a');
    expect((await readJson(a.vault))['values']).toEqual({
      priority: 2,
      status: 'doing',
    });
  });

  it('keeps both acknowledged same-field edits recoverable and convergent', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({
      [PROPERTY_PATH]: propertyRecord({ status: 'todo' }),
    });
    const b = await makeDevice();
    await sync(a, remote, 'device-a');
    await sync(b, remote, 'device-b');

    await write(a.vault, PROPERTY_PATH, propertyRecord({ status: 'doing' }));
    await write(b.vault, PROPERTY_PATH, propertyRecord({ status: 'done' }));
    await sync(a, remote, 'device-a');
    const conflict = await sync(b, remote, 'device-b');

    expect(conflict.conflicts).toHaveLength(1);
    const conflictPath = conflict.conflicts[0]?.conflictPath;
    expect(conflictPath).toContain('.conflict-');
    if (conflictPath === null || conflictPath === undefined)
      throw new Error('expected conflict copy');
    expect((await readJson(b.vault))['values']).toEqual({ status: 'done' });
    expect((await readJson(b.vault, conflictPath))['values']).toEqual({
      status: 'doing',
    });

    await sync(a, remote, 'device-a');
    expect((await readJson(a.vault))['values']).toEqual({ status: 'done' });
    expect((await readJson(a.vault, conflictPath))['values']).toEqual({
      status: 'doing',
    });
  });

  it('keeps a relation value when another replica renames its schema and deletes the target', async () => {
    const remote = new MemorySyncRemote();
    const definition = (name: string) =>
      JSON.stringify({
        format: 'froglight.database',
        version: 1,
        title: 'Projects',
        properties: [{ id: 'related', name, type: 'relation' }],
        membership: { mode: 'explicit', resourceIds: ['member-1'] },
        views: [],
        templates: [],
      });
    const a = await makeDevice({
      'Projects.base': definition('Related'),
      'Notes/member.md': '# Member',
      'Notes/target.md': '# Target',
      [PROPERTY_PATH]: propertyRecord({ related: [] }, ['related']),
    });
    const b = await makeDevice();
    await sync(a, remote, 'device-a');
    await sync(b, remote, 'device-b');

    await write(a.vault, 'Projects.base', definition('Related items'));
    await a.vault.remove(workspacePath('Notes/target.md'));
    await write(
      b.vault,
      PROPERTY_PATH,
      propertyRecord({ related: ['target'] }, ['related']),
    );
    await sync(a, remote, 'device-a');
    const merged = await sync(b, remote, 'device-b');

    expect(merged.conflicts).toEqual([]);
    expect(
      JSON.parse(
        new TextDecoder().decode(
          await b.vault.read(workspacePath('Projects.base')),
        ),
      ).properties[0].name,
    ).toBe('Related items');
    expect((await readJson(b.vault))['values']).toEqual({
      related: ['target'],
    });
    expect(await paths(b.vault)).not.toContain('Notes/target.md');
  });

  it('leaves derived indexes out of the remote inventory', async () => {
    const remote = new MemorySyncRemote();
    const device = await makeDevice({
      'Notes/kept.md': 'kept',
      '.froglight/indexes/database.sqlite': 'derived',
    });
    await sync(device, remote, 'device-a');
    const head = await remote.readHead(VAULT_ID);
    expect(head).not.toBeNull();
    if (head === null) throw new Error('expected remote head');
    const manifest = await remote.loadManifest(
      VAULT_ID,
      head.manifestHash,
      head.manifestObject,
    );
    expect(manifest.entries.map((entry) => entry.path)).toContain(
      'Notes/kept.md',
    );
    expect(
      manifest.entries.some(
        (entry) =>
          entry.path === '.froglight/indexes' ||
          entry.path.startsWith('.froglight/indexes/'),
      ),
    ).toBe(false);
    expect(await paths(device.vault)).toContain(
      '.froglight/indexes/database.sqlite',
    );
  });
});
