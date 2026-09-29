/**
 * Tests for persistent document revisions over a vault.
 *
 * Revisions live under `.froglight/revisions/<documentId>/` as a versioned
 * index plus raw content blobs. The content blob is written
 * before the index entry, checksums guard corruption, and unknown index
 * fields survive round trips.
 */

import { describe, expect, it } from 'vitest';
import { VaultRevisionService, checksumOf, checksumOfAsync } from './revisions.js';
import { createMemoryVault, createMemoryVaultState } from './vault/memory.js';
import { ensureDirectory } from './vault/helpers.js';
import { documentId, resourceId, type DocumentId, type ResourceId } from './identity.js';
import { workspacePath } from './paths.js';
import { utf8Encode } from './encoding.js';
import { FroglightError, isFroglightError, isVaultError } from './errors.js';
import { requireValue } from './testing/require-value.js';

const DOC = documentId('doc-1');
const RES = resourceId('res-1');
const PATH = workspacePath('notes/a.md');

async function expectRejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

function makeService(options: { clock?: () => number } = {}) {
  const { vault } = createMemoryVault();
  const service = new VaultRevisionService({
    vault,
    resolveResource: (id: ResourceId) => (id === RES ? PATH : undefined),
    clock: options.clock,
  });
  return { vault, service };
}

describe('VaultRevisionService', () => {
  it('records a revision with a stable id, checksum, and metadata', async () => {
    const { service } = makeService();
    const data = utf8Encode('hello world');
    const record = await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data });
    expect(record.revisionId).toMatch(/^rev-\d+-\d+$/);
    expect(record.documentId).toBe(DOC);
    expect(record.sourceResourceId).toBe(RES);
    expect(record.byteLength).toBe(data.byteLength);
    expect(record.checksum).toBe(checksumOf(data));
    expect(record.checksum).toMatch(/^[0-9a-f]{8}$/);
  });

  it('readRevision returns the original bytes', async () => {
    const { service } = makeService();
    const data = utf8Encode('hello world');
    const { revisionId } = await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data });
    const restored = await service.readRevision(revisionId);
    expect(restored).toEqual(data);
  });

  it('listRevisions returns newest first (clock-controlled)', async () => {
    let now = 1000;
    const { service } = makeService({ clock: () => now });
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('v1') });
    now = 2000;
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('v2') });
    now = 3000;
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('v3') });
    const list = await service.listRevisions(DOC);
    expect(list.map((r) => r.createdAtMillis)).toEqual([3000, 2000, 1000]);
  });

  it('listRevisions is empty for a document with no revisions', async () => {
    const { service } = makeService();
    expect(await service.listRevisions(DOC)).toEqual([]);
  });

  it('readRevision throws NOT_FOUND for an unknown revision id', async () => {
    const { service } = makeService();
    await expectRejectsCode(service.readRevision('rev-0-0'), 'NOT_FOUND');
  });

  it('readRevision throws RECORD_CORRUPT when the blob is tampered with', async () => {
    const { vault, service } = makeService();
    const { revisionId } = await service.recordRevision({
      documentId: DOC,
      sourceResourceId: RES,
      data: utf8Encode('original'),
    });
    // Tamper with the stored blob directly.
    await vault.write(workspacePath(`.froglight/revisions/${DOC}/${revisionId}.bin`), utf8Encode('TAMPERED'));
    await expectRejectsCode(service.readRevision(revisionId), 'RECORD_CORRUPT');
  });

  it('restoreRevision writes content back onto the source resource', async () => {
    const { vault, service } = makeService();
    await ensureDirectory(vault, workspacePath('notes'));
    await vault.write(PATH, utf8Encode('older'));
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('newer') });
    const list = await service.listRevisions(DOC);
    await service.restoreRevision(requireValue(list[0], 'first revision').revisionId);
    expect(await vault.read(PATH)).toEqual(utf8Encode('newer'));
  });

  it('restoreRevision throws UNKNOWN_RESOURCE when the source is gone', async () => {
    const { service } = makeService();
    await service.recordRevision({ documentId: DOC, sourceResourceId: resourceId('res-gone'), data: utf8Encode('x') });
    const list = await service.listRevisions(DOC);
    await expectRejectsCode(
      service.restoreRevision(requireValue(list[0], 'first revision').revisionId),
      'UNKNOWN_RESOURCE',
    );
  });

  it('removeDocumentRevisions removes all revision data', async () => {
    const { vault, service } = makeService();
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('v1') });
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('v2') });
    await service.removeDocumentRevisions(DOC);
    expect(await service.listRevisions(DOC)).toEqual([]);
    try {
      await vault.stat(workspacePath(`.froglight/revisions/${DOC}`));
      expect.unreachable();
    } catch (error) {
      expect(isVaultError(error)).toBe(true);
    }
  });

  it('removeDocumentRevisions is a no-op for an unknown document', async () => {
    const { service } = makeService();
    await service.removeDocumentRevisions(documentId('doc-missing'));
    expect(await service.listRevisions(DOC)).toEqual([]);
  });

  it('recordRevision throws INVALID_ID for empty or NUL document ids', async () => {
    const { service } = makeService();
    // Cast to bypass branding so the service's own validation is exercised.
    await expectRejectsCode(
      service.recordRevision({ documentId: '' as DocumentId, sourceResourceId: RES, data: utf8Encode('x') }),
      'INVALID_ID',
    );
    await expectRejectsCode(
      service.recordRevision({ documentId: 'a\0b' as DocumentId, sourceResourceId: RES, data: utf8Encode('x') }),
      'INVALID_ID',
    );
  });

  it('records are byte-stable and JSON-round-trippable', async () => {
    const { service } = makeService();
    const record = await service.recordRevision({
      documentId: DOC,
      sourceResourceId: RES,
      data: utf8Encode('x'),
    });
    const roundTripped: unknown = JSON.parse(JSON.stringify(record));
    expect(roundTripped).toEqual(record);
  });

  it('survives reopen: a new vault over the same state lists the same revisions', async () => {
    const state = createMemoryVaultState();
    const { vault } = createMemoryVault({ state });
    const service = new VaultRevisionService({
      vault,
      resolveResource: () => PATH,
    });
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('persisted') });

    // Simulate a restart: fresh vault + fresh service over the same bytes.
    const { vault: vault2 } = createMemoryVault({ state });
    const service2 = new VaultRevisionService({
      vault: vault2,
      resolveResource: () => PATH,
    });
    const list = await service2.listRevisions(DOC);
    expect(list).toHaveLength(1);
    const record = requireValue(list[0], 'first revision');
    expect(record.documentId).toBe(DOC);
    expect(await service2.readRevision(record.revisionId)).toEqual(utf8Encode('persisted'));
  });

  it('preserves unknown index fields across index rewrites', async () => {
    const { vault, service } = makeService();
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('v1') });
    // Inject an unknown field into the index, as a future Froglight version might.
    const indexPath = workspacePath(`.froglight/revisions/${DOC}/index.json`);
    const raw = await vault.read(indexPath);
    const text = new TextDecoder().decode(raw).replace('}', ',"futureFlag":true}');
    await vault.write(indexPath, utf8Encode(text));
    // A further revision must preserve the unknown field.
    await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('v2') });
    const rewritten = new TextDecoder().decode(await vault.read(indexPath));
    expect(rewritten).toContain('"futureFlag":true');
    expect(await service.listRevisions(DOC)).toHaveLength(2);
  });

  it('thrown errors are FroglightErrors with a stable code', async () => {
    const { service } = makeService();
    try {
      await service.readRevision('rev-0-0');
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('NOT_FOUND');
    }
  });
});

it('cooperative checksums match canonical FNV bytes across chunk boundaries', async () => {
  for (const length of [0, 17, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024 + 19]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
    // Nonzero-offset views must hash only their own bytes.
    const view = bytes.subarray(Math.min(3, length));
    expect(await checksumOfAsync(view)).toBe(checksumOf(view));
  }
});

it('prepares revision directories once and retains only the newest 100 indexed blobs', async () => {
  const { vault, service } = makeService();
  const mkdir = vault.createDirectory.bind(vault);
  let preparations = 0;
  vault.createDirectory = async path => { preparations++; return mkdir(path); };
  const first = await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode('first') });
  const prepared = preparations;
  for (let i = 0; i < 101; i++) await service.recordRevision({ documentId: DOC, sourceResourceId: RES, data: utf8Encode(String(i)) });
  expect(preparations).toBe(prepared);
  expect(await service.listRevisions(DOC)).toHaveLength(100);
  await expect(service.readRevision(first.revisionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
