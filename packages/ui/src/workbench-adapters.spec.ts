import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchDocumentPort } from './workbench-adapters.js';

describe('workbench adapters', () => {
  it('forwards document-only calls with an undefined host', async () => {
    const source = {
      createAndOpen: vi.fn(async () => ({ documentId: 'doc-1' })),
      openDocument: vi.fn(async () => undefined),
      openLink: vi.fn(async () => ({ created: false, documentId: 'doc-1' })),
      deleteDocument: vi.fn(async () => undefined),
      pruneMissingDocuments: vi.fn(async () => undefined),
      saveActive: vi.fn(async () => null),
      savePane: vi.fn(async () => null),
      goBack: vi.fn(async () => false),
      goForward: vi.fn(async () => false),
      onDidChange: vi.fn(() => ({ dispose: () => undefined })),
    };
    const documents = createWorkbenchDocumentPort(source);
    const opts = { kindId: 'notebook', pane: 'second' };
    await documents.createAndOpen('notes/a.notebook', opts);
    expect(source.createAndOpen).toHaveBeenCalledWith(
      'notes/a.notebook',
      undefined,
      opts,
    );
    const openOpts = { pane: 'second' };
    await documents.openDocument('doc-1', openOpts);
    expect(source.openDocument).toHaveBeenCalledWith(
      'doc-1',
      undefined,
      openOpts,
    );
    await documents.savePane('second');
    expect(source.savePane).toHaveBeenCalledWith('second');
  });
});
