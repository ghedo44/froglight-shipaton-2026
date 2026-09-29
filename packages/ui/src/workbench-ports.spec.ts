import { describe, expect, it } from 'vitest';
import type {
  DocumentKindId,
  DocumentReaderProvider,
} from '@froglight/foundation';
import { createFakeWorkbenchPorts } from './workbench-fakes.js';
import {
  defineWorkbenchPortContracts,
  type WorkbenchContractFixture,
} from './workbench-contracts.js';

const MARKDOWN_READER: DocumentReaderProvider = {
  id: 'fake-markdown-reader',
  kindIds: ['fake.markdown' as DocumentKindId],
  createReader: () => ({
    // The contract fakes never mount readers; identity is what matters.
    update() {
      /* stub reader: no live session to update */
    },
    revealAddress() {
      /* stub reader: nothing to reveal into */
    },
    destroy() {
      /* stub reader: nothing to tear down */
    },
  }),
};

async function makeFixture(): Promise<WorkbenchContractFixture> {
  const ports = createFakeWorkbenchPorts({
    readers: [{ kindId: 'fake.markdown', provider: MARKDOWN_READER }],
  });
  let seedCounter = 0;
  return {
    state: ports.statePort,
    dock: ports.dockPort,
    documents: ports.documentPort,
    reading: ports.readingPort,
    tools: ports.toolsPort,
    host: ports.hostPort,
    seedDocument: async (path: string, text = '') => {
      seedCounter += 1;
      const documentId = `doc-seed-${seedCounter}`;
      ports.state.documents.set(documentId, {
        documentId,
        kindId: path.endsWith('.tex') ? 'fake.latex' : 'fake.markdown',
        path,
        title: path.split('/').pop() ?? path,
        text,
      });
      return documentId;
    },
    hostObject: () => ({}),
    deleteDocumentExternally: async (documentId: string) => {
      ports.state.documents.delete(documentId);
    },
  };
}

defineWorkbenchPortContracts(makeFixture);

describe('fake reading presentation matrix', () => {
  it('follows provider replacement live', async () => {
    const ports = createFakeWorkbenchPorts({
      readers: [{ kindId: 'fake.markdown', provider: MARKDOWN_READER }],
    });
    ports.state.documents.set('doc-1', {
      documentId: 'doc-1',
      kindId: 'fake.markdown',
      path: 'note.md',
      title: 'note.md',
      text: '# Note',
    });
    await ports.hostPort.openDocument('doc-1', {}, { pane: 'main' });
    const first = ports.readingPort.readingPresentation('main');
    expect(first.kind).toBe('separate-reader');
    const replacement: DocumentReaderProvider = {
      ...MARKDOWN_READER,
      id: 'replacement-reader',
    };
    ports.state.readers.set('fake.markdown', replacement);
    const second = ports.readingPort.readingPresentation('main');
    expect(second).toEqual({
      kind: 'separate-reader',
      provider: replacement,
      kindId: 'fake.markdown',
    });
  });
});
