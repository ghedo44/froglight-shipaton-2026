/** Persistence safety: corruption, unsupported versions, and unknown fields. */

import { describe, expect, it } from 'vitest';
import { createMemoryVaultState, MemoryVault } from './vault/memory.js';
import { parseVersionedRecord, serializeVersionedRecord } from './records.js';
import { workspacePath } from './paths.js';
import { VaultError } from './errors.js';
import { utf8Decode, utf8Encode } from './encoding.js';
import { generateDocumentId, generateResourceId } from './identity.js';
import { WorkspaceServiceImpl } from './workspace.js';
import { InMemoryDocumentRegistry } from './documents.js';
import { InMemoryMetadataService } from './metadata.js';
import { InMemoryRelationshipService } from './relationships.js';
import { VaultRevisionService } from './revisions.js';
import { InMemorySearchService } from './search/service.js';
import { notebookKind, notebookKindId } from './notebooks/index.js';
import type { NotebookModel } from './notebooks/index.js';
import { boundedFrame, emptySurface } from './surfaces/model.js';

const enc = new TextEncoder();

function bytes(text: string): Uint8Array {
  return enc.encode(text);
}

describe('persistence safety fixtures', () => {
  it('v1 workspace record opens and preserves unknown fields', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('.froglight'));
    // Current workspace record with an unknown field.
    const fixture = {
      format: 'froglight.workspace',
      version: 1,
      workspaceId: 'ws-upgrade',
      documents: [],
      futureField: { migrated: false },
    };
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      serializeVersionedRecord(
        fixture as unknown as { format: string; version: number } & Record<
          string,
          unknown
        >,
        {},
      ),
    );
    const data = await vault.read(workspacePath('.froglight/workspace.json'));
    const { record, extras } = parseVersionedRecord<{
      format: string;
      version: number;
      workspaceId: string;
    }>(
      data,
      'froglight.workspace',
      [1],
      ['format', 'version', 'workspaceId', 'documents'],
    );
    expect(record.workspaceId).toBe('ws-upgrade');
    expect(extras).toMatchObject({ futureField: { migrated: false } });
  });

  it('unsupported workspace version rejects without touching canonical files', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.createDirectory(workspacePath('notes'));
    await vault.write(workspacePath('notes/keep.md'), bytes('# keep'));
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      bytes(
        '{"format":"froglight.workspace","version":99,"workspaceId":"x","documents":[]}',
      ),
    );
    const data = await vault.read(workspacePath('.froglight/workspace.json'));
    expect(() =>
      parseVersionedRecord(
        data,
        'froglight.workspace',
        [1],
        ['format', 'version', 'workspaceId', 'documents'],
      ),
    ).toThrow(expect.objectContaining({ code: 'RECORD_VERSION_UNSUPPORTED' }));
    // Canonical content is untouched by the failed read.
    expect(
      new TextDecoder().decode(
        await vault.read(workspacePath('notes/keep.md')),
      ),
    ).toBe('# keep');
  });

  it('truncated workspace record is RECORD_CORRUPT, not silent data loss', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('.froglight'));
    // Simulate an interrupted write: valid prefix, truncated JSON.
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      bytes('{"format":"froglight.workspace","version":1,"workspaceId":'),
    );
    const data = await vault.read(workspacePath('.froglight/workspace.json'));
    expect(() =>
      parseVersionedRecord(
        data,
        'froglight.workspace',
        [1],
        ['format', 'version', 'workspaceId', 'documents'],
      ),
    ).toThrow(expect.objectContaining({ code: 'RECORD_CORRUPT' }));
  });

  it('malformed JSON record is RECORD_CORRUPT', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      bytes('not-json{{{'),
    );
    const data = await vault.read(workspacePath('.froglight/workspace.json'));
    expect(() =>
      parseVersionedRecord(
        data,
        'froglight.workspace',
        [1],
        ['format', 'version'],
      ),
    ).toThrow(expect.objectContaining({ code: 'RECORD_CORRUPT' }));
  });

  it('missing referenced canonical file surfaces NOT_FOUND without deleting the record', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      serializeVersionedRecord(
        {
          format: 'froglight.workspace',
          version: 1,
          workspaceId: 'ws-missing',
          documents: [
            {
              documentId: 'd1',
              kindId: 'test.note',
              resourcePath: 'notes/gone.md',
            },
          ],
        } as unknown as { format: string; version: number } & Record<
          string,
          unknown
        >,
        {},
      ),
    );
    // The referenced file was never written (or was deleted externally).
    await expect(
      vault.read(workspacePath('notes/gone.md')),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // The record itself still exists — recovery must not silently drop it.
    const stat = await vault.stat(workspacePath('.froglight/workspace.json'));
    expect(stat.kind).toBe('file');
  });

  it('deleting derived.froglight state preserves canonical files', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('notes'));
    await vault.write(workspacePath('notes/a.md'), bytes('# a'));
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      bytes('{"format":"froglight.workspace","version":1}'),
    );
    // Simulate "delete derived state and rebuild": remove the whole record dir.
    await vault.remove(workspacePath('.froglight/workspace.json'));
    await vault.remove(workspacePath('.froglight'));
    await expect(
      vault.stat(workspacePath('.froglight/workspace.json')),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Canonical files survive derived-state deletion.
    expect(
      new TextDecoder().decode(await vault.read(workspacePath('notes/a.md'))),
    ).toBe('# a');
  });

  it('non-empty.froglight directory cannot be removed silently (CONFLICT)', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.write(workspacePath('.froglight/workspace.json'), bytes('{}'));
    await expect(
      vault.remove(workspacePath('.froglight')),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('vault-level failures use structured codes, never raw host errors', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    const invalid = vault.stat(
      'a/../b' as unknown as Parameters<typeof vault.stat>[0],
    );
    await expect(invalid).rejects.toBeInstanceOf(VaultError);
    await expect(invalid).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
});

describe('workspace round trip', () => {
  function currentNotebookBytes(): Uint8Array {
    return utf8Encode(JSON.stringify({
      formatVersion: 1,
      meta: { title: 'Current notes' },
      pageOrder: ['p1'],
      pages: {
        p1: {
          id: 'p1',
          label: 'Lecture',
          base: { kind: 'template', template: 'froglight.lined' },
          surface: emptySurface(boundedFrame(612, 792)),
        },
      },
    }));
  }

  async function openWorkspace(vault: MemoryVault) {
    const registry = new InMemoryDocumentRegistry();
    registry.register(notebookKind);
    return WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: new VaultRevisionService({
        vault,
        resolveResource: () => undefined,
      }),
      search: new InMemorySearchService(),
      workspaceId: 'ws-current',
    });
  }

  it('workspace record with unknown fields survives flushes', async () => {
    const vault = new MemoryVault(createMemoryVaultState());
    await vault.createDirectory(workspacePath('notes'));
    await vault.write(
      workspacePath('notes/existing.notebook'),
      currentNotebookBytes(),
    );
    const documentId = generateDocumentId();
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      serializeVersionedRecord(
        {
          format: 'froglight.workspace',
          version: 1,
          workspaceId: 'ws-current-record',
          trash: [],
          documents: [
            {
              documentId,
              kindId: 'froglight.notebook',
              resourceId: generateResourceId(),
              primaryResource: 'notes/existing.notebook',
              createdMillis: 1,
            },
          ],
        } as unknown as { format: string; version: number } & Record<
          string,
          unknown
        >,
        {},
      ),
    );
    // A field the current version does not know must round-trip, not vanish.
    const before = JSON.parse(
      utf8Decode(await vault.read(workspacePath('.froglight/workspace.json'))),
    ) as Record<string, unknown>;
    const withFuture = { ...before, futureField: { preserved: true } };
    await vault.write(
      workspacePath('.froglight/workspace.json'),
      utf8Encode(JSON.stringify(withFuture)),
    );

    const ws = await openWorkspace(vault);
    expect(ws.workspaceId).toBe('ws-current-record');
    const ref = ws.findByResourcePath(workspacePath('notes/existing.notebook'));
    expect(ref?.documentId).toBe(documentId);
    const session = await ws.openDocument<NotebookModel>(documentId);
    expect(session.model.meta).toMatchObject({ title: 'Current notes' });

    // Trigger a flush (new document) — unknown fields must survive the write.
    await ws.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notes/new.notebook'),
      initialModel: { formatVersion: 1, meta: {}, pageOrder: [], pages: {} },
    });
    const after = JSON.parse(
      utf8Decode(await vault.read(workspacePath('.froglight/workspace.json'))),
    ) as Record<string, unknown>;
    expect(after).toMatchObject({ futureField: { preserved: true } });
    expect(
      ws.findByResourcePath(workspacePath('notes/existing.notebook'))?.documentId,
    ).toBe(documentId);
  });
});
