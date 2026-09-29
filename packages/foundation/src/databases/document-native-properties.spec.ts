import { describe, expect, it } from 'vitest';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { utf8Decode } from '../encoding.js';
import { utf8Encode } from '../encoding.js';
import { documentKindId } from '../identity.js';
import { structuredDocumentProperties } from '../resource-properties/model.js';
import { markdownKind } from '../markdown/kind.js';
import { blockPageKind } from '../blocks/kind.js';
import { emptyBlockPage } from '../blocks/model.js';
import { notebookKind } from '../notebooks/kind.js';
import { emptyNotebook } from '../notebooks/model.js';
import { inkPageKind } from '../surfaces/kind.js';
import { whiteboardKind } from '../whiteboard/kind.js';
import { boundedFrame, emptySurface, infiniteFrame } from '../surfaces/model.js';
import { latexKind } from '../latex/kind.js';
import { pdfKind } from '../pdf/kind.js';
import { PropertyCatalog } from '../resource-properties/catalog.js';
import { WorkspaceResourceProperties, resourcePropertyPath } from '../resource-properties/provider.js';
import { databaseKind } from './kind.js';
import { createDatabase } from './model.js';

describe('document-native property authority', () => {
  it('loads a database definition added after the property service starts before editing a native field', async () => {
    const { vault } = createMemoryVault();
    const registry = new InMemoryDocumentRegistry();
    const nativeKind = {
      id: documentKindId('plugin.lazy-native-properties'),
      documentProperties: structuredDocumentProperties,
      decode: (bytes: Uint8Array) => ({ model: JSON.parse(utf8Decode(bytes)) as { meta: Record<string, unknown> }, metadata: {}, relationships: [] }),
      encode: (model: { meta: Record<string, unknown> }) => utf8Encode(JSON.stringify(model)),
    };
    registry.register(nativeKind);
    registry.register(databaseKind);
    const metadata = new InMemoryMetadataService();
    const relationships = new InMemoryRelationshipService();
    const workspace = await WorkspaceServiceImpl.create({ vault, registry, metadata, relationships, revisions: null });
    const note = await workspace.createDocument({
      kindId: nativeKind.id,
      path: workspacePath('Late.custom'),
      initialModel: { meta: { properties: { 'late-field': 'original' } } },
    });
    const properties = new WorkspaceResourceProperties({ workspace, vault, metadata, relationships, revisions: null, catalog: new PropertyCatalog(), registry });
    await properties.rebuild();
    const database = createDatabase('Late');
    const field = { id: 'late-field', name: 'Late field', storageKey: 'late-field', type: 'text' };
    database.properties.push(field);
    await workspace.createDocument({ kindId: databaseKind.id, path: workspacePath('Late.base'), initialModel: database });
    expect((await properties.read(note))[field.id]).toBe('original');
    expect((await properties.write(note, field, 'edited')).committed).toBe(true);
    expect((await properties.read(note))[field.id]).toBe('edited');
    await properties.dispose();
  });

  it('routes plugin kinds through their live capability and preserves values across withdrawal', async () => {
    const { vault } = createMemoryVault();
    const registry = new InMemoryDocumentRegistry();
    const pluginKind = {
      id: documentKindId('plugin.native-properties'),
      documentProperties: structuredDocumentProperties,
      decode: (bytes: Uint8Array) => ({ model: JSON.parse(utf8Decode(bytes)) as { meta: Record<string, unknown> }, metadata: {}, relationships: [] }),
      encode: (model: { meta: Record<string, unknown> }) => utf8Encode(JSON.stringify(model)),
    };
    const fallbackKind = { ...pluginKind, id: documentKindId('plugin.sidecar-properties'), documentProperties: undefined };
    const registration = registry.register(pluginKind);
    registry.register(fallbackKind);
    registry.register(databaseKind);
    const metadata = new InMemoryMetadataService();
    const relationships = new InMemoryRelationshipService();
    const workspace = await WorkspaceServiceImpl.create({ vault, registry, metadata, relationships, revisions: null });
    const database = createDatabase('Custom');
    const field = { id: 'plugin-field', name: 'Field', storageKey: 'field', type: 'text' };
    database.properties.push(field);
    const native = await workspace.createDocument({ kindId: pluginKind.id, path: workspacePath('Native.custom'), initialModel: { meta: { other: 'preserved' } } });
    const fallback = await workspace.createDocument({ kindId: fallbackKind.id, path: workspacePath('Fallback.custom'), initialModel: { meta: {} } });
    await workspace.createDocument({ kindId: databaseKind.id, path: workspacePath('Custom.base'), initialModel: database });
    const properties = new WorkspaceResourceProperties({ workspace, vault, metadata, relationships, revisions: null, catalog: new PropertyCatalog(), registry });
    workspace.registerProjection({ project: (ref) => properties.project(ref) });
    await properties.rebuild();
    await properties.write(native, field, 'native');
    await properties.write(fallback, field, 'sidecar');
    expect((await workspace.readDocument<{ meta: Record<string, unknown> }>(native.documentId)).model.meta).toMatchObject({ other: 'preserved', properties: { 'plugin-field': 'native' } });
    await expect(vault.read(resourcePropertyPath(native.location.resourceId))).rejects.toThrow();
    expect(utf8Decode(await vault.read(resourcePropertyPath(fallback.location.resourceId)))).toContain('sidecar');
    registration.dispose();
    await expect(properties.read(native)).rejects.toThrow('provider unavailable');
    await properties.project(native);
    expect(properties.rows().find((row) => row.resourceId === native.location.resourceId)?.diagnostics?.$properties).toContain('provider unavailable');
    expect(utf8Decode(await vault.read(workspacePath('Native.custom')))).toContain('native');
    const restored = registry.register(pluginKind);
    await properties.project(native);
    expect((await properties.read(native))['plugin-field']).toBe('native');
    restored.dispose();
    await properties.dispose();
  });
  it('refuses ambiguous YAML without changing source and distinguishes null from absent', () => {
    const capability = markdownKind.documentProperties!;
    const ambiguous = { raw: '---\nstatus: todo\nstatus: done\n---\n# Body\n' };
    expect(() => capability.write(ambiguous, 'status', 'doing')).toThrow('Duplicate');
    expect(ambiguous.raw).toContain('status: todo\nstatus: done');
    const nested = { raw: '---\ncourse:\n  status: todo\n---\n# Body\n' };
    expect(() => capability.write(nested, 'status', 'doing')).toThrow();
    expect(nested.raw).toContain('  status: todo');
    const model = { raw: '# Body\n' };
    expect(capability.read(model, 'status')).toEqual({ present: false });
    capability.write(model, 'status', null);
    expect(capability.read(model, 'status')).toEqual({ present: true, value: null });
    capability.unset(model, 'status');
    expect(capability.read(model, 'status')).toEqual({ present: false });
    capability.write(model, 'status', 'A "quoted" value');
    expect(capability.read(model, 'status')).toEqual({ present: true, value: 'A "quoted" value' });
    capability.write(model, 'status', '123');
    expect(capability.read(model, 'status')).toEqual({ present: true, value: '123' });
    const unsupportedSurface = emptySurface(infiniteFrame());
    unsupportedSurface.unknownFields = { meta: 'opaque' };
    expect(() => whiteboardKind.documentProperties!.write(unsupportedSurface, 'status', 'doing')).toThrow('unsupported');
    expect(unsupportedSurface.unknownFields.meta).toBe('opaque');
  });
  it('round-trips Markdown frontmatter and structured metadata through one service', async () => {
    const { vault } = createMemoryVault();
    const registry = new InMemoryDocumentRegistry();
    registry.register(markdownKind);
    registry.register(blockPageKind);
    registry.register(notebookKind);
    registry.register(inkPageKind);
    registry.register(whiteboardKind);
    registry.register(latexKind);
    registry.register(pdfKind);
    registry.register(databaseKind);
    const metadata = new InMemoryMetadataService();
    const relationships = new InMemoryRelationshipService();
    const workspace = await WorkspaceServiceImpl.create({ vault, registry, metadata, relationships, revisions: null });
    const database = createDatabase('Papers');
    const status = { id: 'stable-status', name: 'Status', storageKey: 'status', type: 'select',
      options: [{ id: 'todo', name: 'Todo' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }] };
    const review = { id: 'stable-review', name: 'Review', storageKey: 'review', type: 'date' };
    const course = { id: 'stable-course', name: 'Course', storageKey: 'course', type: 'text' };
    database.properties.push(status);
    database.properties.push(review);
    database.properties.push(course);
    const note = await workspace.createDocument({ kindId: markdownKind.id, path: workspacePath('Paper.md'),
      initialModel: { raw: '---\r\ncourse: Flight Dynamics\r\nstatus: todo\r\nreview: 2026-09-28\r\n---\r\n\r\n# Stability derivatives\r\n' } });
    const block = await workspace.createDocument({ kindId: blockPageKind.id, path: workspacePath('Block.blockpage'), initialModel: emptyBlockPage() });
    const notebook = await workspace.createDocument({ kindId: notebookKind.id, path: workspacePath('Notes.notebook'), initialModel: emptyNotebook() });
    const ink = await workspace.createDocument({ kindId: inkPageKind.id, path: workspacePath('Sketch.ink'), initialModel: emptySurface(boundedFrame(800, 600)) });
    const board = await workspace.createDocument({ kindId: whiteboardKind.id, path: workspacePath('Board.whiteboard'), initialModel: emptySurface(infiniteFrame()) });
    const latex = await workspace.createDocument({ kindId: latexKind.id, path: workspacePath('Paper.tex'), initialModel: { raw: '\\documentclass{article}\n' } });
    const pdf = await workspace.createDocument({ kindId: pdfKind.id, path: workspacePath('Paper.pdf'), initialModel: { bytes: new Uint8Array([37, 80, 68, 70]) } });
    await workspace.createDocument({ kindId: databaseKind.id, path: workspacePath('Papers.base'), initialModel: database });
    const properties = new WorkspaceResourceProperties({ workspace, vault, metadata, relationships, revisions: null, catalog: new PropertyCatalog(), registry });
    workspace.registerProjection({ project: (ref) => properties.project(ref) });
    await properties.rebuild();
    expect((await properties.read(note))[status.id]).toBe('todo');
    expect((await properties.read(note))[review.id]).toBe('2026-09-28');
    expect((await properties.read(note))[course.id]).toBe('Flight Dynamics');
    const open = await workspace.openDocument<{ raw: string }>(note.documentId);
    open.model.raw += 'Body edit\r\n';
    open.markDirty();
    expect((await properties.write(note, status, 'doing')).committed).toBe(true);
    expect(open.model.raw).toContain('status: doing\r\n');
    expect(open.model.raw).toContain('Body edit\r\n');
    expect(utf8Decode(await vault.read(workspacePath('Paper.md')))).toContain('status: doing\r\n');
    expect(utf8Decode(await vault.read(workspacePath('Paper.md')))).toContain('course: Flight Dynamics\r\n');
    expect(utf8Decode(await vault.read(workspacePath('Paper.md')))).toContain('review: 2026-09-28\r\n');
    await properties.write(note, review, '2026-10-01');
    await properties.write(note, course, 'Advanced Flight Dynamics');
    expect(utf8Decode(await vault.read(workspacePath('Paper.md')))).toContain('review: 2026-10-01\r\n');
    expect(utf8Decode(await vault.read(workspacePath('Paper.md')))).toContain('course: "Advanced Flight Dynamics"\r\n');
    const range = { start: '2026-10-01', end: '2026-10-04' };
    await properties.write(note, review, range);
    expect((await properties.read(note))[review.id]).toEqual(range);
    expect(utf8Decode(await vault.read(workspacePath('Paper.md')))).toContain('review: {"start":"2026-10-01","end":"2026-10-04"}\r\n');
    await expect(vault.read(resourcePropertyPath(note.location.resourceId))).rejects.toThrow();
    open.model.raw = open.model.raw.replace('status: doing', 'status: done');
    open.markDirty();
    await open.save();
    expect(properties.rows().find((row) => row.resourceId === note.location.resourceId)?.values[status.id]).toBe('done');
    await open.close();
    for (const ref of [block, notebook, ink, board]) {
      const active = await workspace.openDocument<any>(ref.documentId);
      expect((await properties.write(ref, status, 'doing')).committed).toBe(true);
      expect(active.model.meta?.properties?.[status.id] ?? active.model.unknownFields?.meta?.properties?.[status.id]).toBe('doing');
      if (active.model.meta) active.model.meta.title = 'Edited after property';
      else active.model.unknownFields.meta.title = 'Edited after property';
      active.markDirty();
      await active.save();
      await active.close();
      const model = (await workspace.readDocument(ref.documentId)).model as any;
      const values = ref === ink || ref === board ? model.unknownFields.meta.properties : model.meta.properties;
      expect(values[status.id]).toBe('doing');
      expect(await properties.read(ref)).toMatchObject({ [status.id]: 'doing' });
      await expect(vault.read(resourcePropertyPath(ref.location.resourceId))).rejects.toThrow();
    }
    for (const [ref, path] of [[latex, workspacePath('Paper.tex')], [pdf, workspacePath('Paper.pdf')]] as const) {
      const before = await vault.read(path);
      expect((await properties.write(ref, status, 'doing')).committed).toBe(true);
      expect(await vault.read(path)).toEqual(before);
      expect(utf8Decode(await vault.read(resourcePropertyPath(ref.location.resourceId)))).toContain('stable-status');
    }
    const collision = createDatabase('Other');
    collision.properties.push({ id: 'different-status', name: 'Status', storageKey: 'status', type: 'text' });
    await workspace.createDocument({ kindId: databaseKind.id, path: workspacePath('Other.base'), initialModel: collision });
    const before = await vault.read(workspacePath('Paper.md'));
    await expect(properties.write(note, status, 'todo')).rejects.toThrow('Conflicting document property storage bindings');
    expect(await vault.read(workspacePath('Paper.md'))).toEqual(before);
  });
});
