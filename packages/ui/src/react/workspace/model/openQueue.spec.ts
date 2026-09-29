import { describe, expect, it } from 'vitest';
import {
  appendPendingOpen,
  createPendingMailbox,
  hasPendingOpen,
  pruneClosedPanes,
  takePendingOpens,
} from './openQueue.js';

describe('pending open mailbox', () => {
  it('stores one pending intent per pane', () => {
    const mailbox = createPendingMailbox();
    expect(hasPendingOpen(mailbox, 'main')).toBe(false);
    appendPendingOpen(mailbox, {
      pane: 'main',
      documentId: 'doc-1',
    });
    expect(hasPendingOpen(mailbox, 'main')).toBe(true);
  });

  it('keeps rapid opens into the same pane in FIFO order', () => {
    const mailbox = createPendingMailbox();
    appendPendingOpen(mailbox, {
      pane: 'main',
      documentId: 'doc-1',
    });
    appendPendingOpen(mailbox, {
      pane: 'main',
      documentId: 'doc-2',
    });
    expect(takePendingOpens(mailbox, 'main').map((open) => open.documentId)).toEqual([
      'doc-1',
      'doc-2',
    ]);
    expect(hasPendingOpen(mailbox, 'main')).toBe(false);
  });

  it('keeps panes independent of each other', () => {
    const mailbox = createPendingMailbox();
    appendPendingOpen(mailbox, {
      pane: 'main',
      documentId: 'doc-1',
    });
    appendPendingOpen(mailbox, {
      pane: 'second',
      documentId: 'doc-2',
    });
    expect(
      takePendingOpens(mailbox, 'main').map((open) => open.documentId),
    ).toEqual(['doc-1']);
    expect(
      takePendingOpens(mailbox, 'second').map((open) => open.documentId),
    ).toEqual(['doc-2']);
  });

  it('returns an empty list when nothing is pending', () => {
    const mailbox = createPendingMailbox();
    expect(takePendingOpens(mailbox, 'main')).toEqual([]);
  });

  it('carries the preserve-focus intent with pane, document, and address', () => {
    const mailbox = createPendingMailbox();
    appendPendingOpen(mailbox, {
      pane: 'second',
      documentId: 'doc-9',
      address: 'sec-1',
      preserveFocus: true,
    });
    appendPendingOpen(mailbox, {
      pane: 'second',
      documentId: 'doc-10',
    });
    const taken = takePendingOpens(mailbox, 'second');
    expect(taken).toEqual([
      {
        pane: 'second',
        documentId: 'doc-9',
        address: 'sec-1',
        preserveFocus: true,
      },
      { pane: 'second', documentId: 'doc-10' },
    ]);
    expect(hasPendingOpen(mailbox, 'second')).toBe(false);
  });

  it('prunes intents for panes that no longer exist', () => {    const mailbox = createPendingMailbox();
    appendPendingOpen(mailbox, {
      pane: 'main',
      documentId: 'doc-1',
    });
    appendPendingOpen(mailbox, {
      pane: 'gone',
      documentId: 'doc-2',
    });
    const dropped = pruneClosedPanes(mailbox, ['main']);
    expect(dropped.map((open) => open.documentId)).toEqual(['doc-2']);
    expect(hasPendingOpen(mailbox, 'main')).toBe(true);
    expect(hasPendingOpen(mailbox, 'gone')).toBe(false);
  });
});
