import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../encoding.js';
import { ROOT_PATH, workspacePath } from '../paths.js';
import { VaultError } from '../errors.js';
import { MemoryVault } from './memory.js';
import { exportVaultBackup, restoreVaultBackup } from './backup.js';
import type { VaultBackupExportProgress } from './backup.js';

describe('full vault backup and restore', () => {
  it('reports scanning, file reads, and encoding without changing the archive', async () => {
    const source = new MemoryVault();
    await source.createDirectory(workspacePath('notes'));
    await source.write(workspacePath('notes/a.md'), utf8Encode('a'));
    await source.write(workspacePath('notes/b.md'), utf8Encode('b'));
    const progress: VaultBackupExportProgress[] = [];
    const withProgress = await exportVaultBackup({
      vault: source,
      onProgress: (event) => progress.push(event),
    });
    const withoutProgress = await exportVaultBackup({ vault: source });
    expect(withProgress.bundle).toEqual(withoutProgress.bundle);
    expect(progress.some((event) => event.phase === 'scanning')).toBe(true);
    expect(
      progress
        .filter((event) => event.phase === 'reading')
        .map((event) => event.completedFiles),
    ).toEqual([0, 1, 2]);
    expect(progress.at(-1)).toMatchObject({
      phase: 'encoding',
      completedFiles: 2,
      totalFiles: 2,
    });
  });

  it('round-trips canonical files, hidden metadata, opaque bytes, and empty directories', async () => {
    const source = new MemoryVault();
    await source.createDirectory(workspacePath('Notes'));
    await source.createDirectory(workspacePath('Empty'));
    await source.createDirectory(workspacePath('.froglight'));
    await source.createDirectory(workspacePath('.froglight/plugin-data'));
    await source.write(
      workspacePath('Notes/hello.md'),
      utf8Encode('# Hello\n'),
    );
    await source.write(
      workspacePath('.froglight/plugin-data/unknown.bin'),
      new Uint8Array([0, 255, 17, 128, 0, 9]),
    );

    const exported = await exportVaultBackup({ vault: source });
    expect(exported).toMatchObject({
      directoryCount: 4,
      fileCount: 2,
      totalBytes: 14,
    });

    const destination = new MemoryVault();
    const restored = await restoreVaultBackup({
      bundle: exported.bundle,
      destination,
      requireEmptyDestination: true,
    });
    expect(restored.status).toBe('complete');
    expect(await destination.list(workspacePath('Empty'))).toEqual([]);
    expect(
      utf8Decode(await destination.read(workspacePath('Notes/hello.md'))),
    ).toBe('# Hello\n');
    expect(
      await destination.read(
        workspacePath('.froglight/plugin-data/unknown.bin'),
      ),
    ).toEqual(new Uint8Array([0, 255, 17, 128, 0, 9]));
  });

  it('rejects a non-empty destination before creating anything', async () => {
    const source = new MemoryVault();
    await source.write(workspacePath('source.md'), utf8Encode('source'));
    const { bundle } = await exportVaultBackup({ vault: source });
    const destination = new MemoryVault();
    await destination.write(workspacePath('keep.md'), utf8Encode('keep'));

    await expect(
      restoreVaultBackup({
        bundle,
        destination,
        requireEmptyDestination: true,
      }),
    ).rejects.toThrow('destination must be empty');
    expect(utf8Decode(await destination.read(workspacePath('keep.md')))).toBe(
      'keep',
    );
    await expect(
      destination.stat(workspacePath('source.md')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('validates every file before writing to an empty destination', async () => {
    const corrupt = utf8Encode(
      JSON.stringify({
        format: 'froglight.vault-backup',
        version: 1,
        directories: ['safe'],
        files: [
          { path: 'safe/first.bin', bytes: 'AQID' },
          { path: 'safe/broken.bin', bytes: 'not base64' },
        ],
      }),
    );
    const destination = new MemoryVault();
    await expect(
      restoreVaultBackup({
        bundle: corrupt,
        destination,
        requireEmptyDestination: true,
      }),
    ).rejects.toThrow('Invalid base64');
    expect(await destination.list(ROOT_PATH)).toEqual([]);
  });

  it('reports exact durable progress after an injected write failure', async () => {
    const source = new MemoryVault();
    await source.createDirectory(workspacePath('docs'));
    await source.write(workspacePath('docs/a.bin'), new Uint8Array([1]));
    await source.write(workspacePath('docs/b.bin'), new Uint8Array([2]));
    const { bundle } = await exportVaultBackup({ vault: source });
    const destination = new MemoryVault(undefined, {
      fail: (operation, path) =>
        operation === 'write' && path === workspacePath('docs/b.bin')
          ? new VaultError('IO', 'injected restore failure', { path })
          : null,
    });

    const result = await restoreVaultBackup({
      bundle,
      destination,
      requireEmptyDestination: true,
    });
    expect(result).toMatchObject({
      status: 'partial',
      phase: 'write-file',
      createdDirectories: [workspacePath('docs')],
      writtenFiles: [workspacePath('docs/a.bin')],
      failedPath: workspacePath('docs/b.bin'),
    });
    expect(await destination.read(workspacePath('docs/a.bin'))).toEqual(
      new Uint8Array([1]),
    );
    await expect(
      destination.stat(workspacePath('docs/b.bin')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects destination-sensitive path collisions during preflight', async () => {
    const bundle = utf8Encode(
      JSON.stringify({
        format: 'froglight.vault-backup',
        version: 1,
        directories: [],
        files: [
          { path: 'Readme.md', bytes: '' },
          { path: 'README.md', bytes: '' },
        ],
      }),
    );
    const destination = new MemoryVault(undefined, {
      caseSensitivity: 'insensitive',
    });
    await expect(
      restoreVaultBackup({
        bundle,
        destination,
        requireEmptyDestination: true,
      }),
    ).rejects.toThrow('paths collide');
    expect(await destination.list(ROOT_PATH)).toEqual([]);
  });
});
