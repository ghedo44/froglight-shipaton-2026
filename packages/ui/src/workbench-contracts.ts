/**
 * Shared behavioral contract suite for the workbench ports (#44).
 *
 * The same assertions execute against the real `WorkbenchController`
 * (through its structural port conformance, in `@froglight/application`
 * specs) and the canonical UI fakes (`workbench-fakes.ts`, in
 * `@froglight/ui` specs). The suite defines behavioral equivalence, not
 * private implementation shape: seeding, hosts, and reader registration
 * differ per side behind the fixture interface.
 *
 * Fixture conventions (both sides implement identically):
 * - `seedDocument('note.md', text)` creates a document of the reader-backed
 *   kind; `seedDocument('paper.tex', text)` creates one of a kind with no
 *   registered reader. Extensions are the portable kind keys.
 * - `hostObject()` returns a fresh opaque host identity per call.
 * - Opens go through `host.openDocument(id, hostObject(), { pane })`, the
 *   same host-bearing path the shell mailbox uses.
 */

import { describe, expect, it } from 'vitest';
import type {
  WorkbenchDockPort,
  WorkbenchDocumentPort,
  WorkbenchEditorToolsPort,
  WorkbenchHostPort,
  WorkbenchReadingPort,
  WorkbenchStatePort,
} from './workbench-ports.js';

export interface WorkbenchContractFixture {
  readonly state: WorkbenchStatePort;
  readonly dock: WorkbenchDockPort;
  readonly documents: WorkbenchDocumentPort;
  readonly reading: WorkbenchReadingPort;
  readonly tools: WorkbenchEditorToolsPort;
  readonly host: WorkbenchHostPort;
  seedDocument(path: string, text?: string): Promise<string>;
  hostObject(): unknown;
  /** Remove canonical bytes bypassing the controller (folder-delete path). */
  deleteDocumentExternally(documentId: string): Promise<void>;
}

export function defineWorkbenchPortContracts(
  makeFixture: () => Promise<WorkbenchContractFixture>,
): void {
  describe('workbench port contracts', () => {
    describe('state', () => {
      it('starts with a single empty main leaf', async () => {
        const fixture = await makeFixture();
        expect(fixture.dock.leafIds()).toEqual(['main']);
        expect(fixture.state.focusedPane).toBe('main');
        expect(fixture.state.paneStates()).toHaveLength(1);
        expect(fixture.state.state.activeDocumentId).toBeNull();
      });

      it('lists seeded documents', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        expect(
          fixture.state.listDocuments().map((document) => document.documentId),
        ).toContain(id);
      });

      it('focusPane switches focus and notifies subscribers', async () => {
        const fixture = await makeFixture();
        const second = fixture.dock.splitPane('main', 'right');
        let notifications = 0;
        const subscription = fixture.state.onDidChange(() => {
          notifications += 1;
        });
        try {
          fixture.state.focusPane(second);
          expect(fixture.state.focusedPane).toBe(second);
          expect(notifications).toBeGreaterThan(0);
        } finally {
          subscription.dispose();
        }
      });
    });

    describe('dock', () => {
      it('splitPane creates a focused leaf the state agrees with', async () => {
        const fixture = await makeFixture();
        const created = fixture.dock.splitPane('main', 'right');
        expect(created).not.toBe('main');
        expect(fixture.dock.leafIds()).toContain(created);
        expect(fixture.dock.dockState().focusedPane).toBe(created);
        expect(fixture.state.focusedPane).toBe(created);
      });

      it('opens activate tabs without duplicating them', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        const host = fixture.hostObject();
        await fixture.host.openDocument(id, host, { pane: 'main' });
        await fixture.host.openDocument(id, host, { pane: 'main' });
        const tabs = fixture.state
          .paneStates()
          .find((pane) => pane.pane === 'main')!.tabs;
        expect(tabs.filter((tab) => tab.documentId === id)).toHaveLength(1);
        expect(
          fixture.state.paneStates().find((pane) => pane.pane === 'main')!
            .activeTab,
        ).toBe(id);
      });

      it('activateTab switches and closeTab falls back to a neighbor', async () => {
        const fixture = await makeFixture();
        const host = fixture.hostObject();
        const first = await fixture.seedDocument('one.md', '# One');
        const second = await fixture.seedDocument('two.md', '# Two');
        await fixture.host.openDocument(first, host, { pane: 'main' });
        await fixture.host.openDocument(second, host, { pane: 'main' });
        await fixture.dock.activateTab('main', first);
        expect(
          fixture.state.paneStates().find((pane) => pane.pane === 'main')!
            .activeTab,
        ).toBe(first);
        await fixture.dock.closeTab('main', first);
        expect(
          fixture.state.paneStates().find((pane) => pane.pane === 'main')!
            .activeTab,
        ).toBe(second);
      });

      it('closing the last tab of a pane closes the pane', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        const second = fixture.dock.splitPane('main', 'right');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: second,
        });
        await fixture.dock.closeTab(second, id);
        expect(fixture.dock.leafIds()).not.toContain(second);
      });

      it('moveTab carries the tab across panes and focuses the target', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        const host = fixture.hostObject();
        await fixture.host.openDocument(id, host, { pane: 'main' });
        const second = fixture.dock.splitPane('main', 'right');
        await fixture.dock.moveTab('main', id, { kind: 'pane', pane: second });
        const target = fixture.state
          .paneStates()
          .find((pane) => pane.pane === second)!;
        expect(target.tabs.map((tab) => tab.documentId)).toContain(id);
        expect(target.activeTab).toBe(id);
        expect(fixture.state.focusedPane).toBe(second);
      });

      it('openView dedupes one tab per view id per pane', async () => {
        const fixture = await makeFixture();
        const first = await fixture.dock.openView('graph', { pane: 'main' });
        const second = await fixture.dock.openView('graph', { pane: 'main' });
        expect(second).toBe(first);
        expect(
          fixture.state
            .paneStates()
            .find((pane) => pane.pane === 'main')!
            .tabs.filter((tab) => tab.viewId === 'graph'),
        ).toHaveLength(1);
      });

      it('closeOtherPanes collapses to the kept pane', async () => {
        const fixture = await makeFixture();
        fixture.dock.splitPane('main', 'right');
        await fixture.dock.closeOtherPanes('main');
        expect(fixture.dock.leafIds()).toEqual(['main']);
      });

      it('toggleMaximize toggles the maximized pane', async () => {
        const fixture = await makeFixture();
        fixture.dock.toggleMaximize('main');
        expect(fixture.dock.dockState().maximizedPane).toBe('main');
        fixture.dock.toggleMaximize('main');
        expect(fixture.dock.dockState().maximizedPane).toBeNull();
      });
    });

    describe('documents', () => {
      it('rejects unknown documents', async () => {
        const fixture = await makeFixture();
        await expect(
          fixture.host.openDocument('missing', fixture.hostObject(), {
            pane: 'main',
          }),
        ).rejects.toThrow();
      });

      it('opens through the stored host after a hosted open', async () => {
        const fixture = await makeFixture();
        const first = await fixture.seedDocument('one.md', '# One');
        const second = await fixture.seedDocument('two.md', '# Two');
        await fixture.host.openDocument(first, fixture.hostObject(), {
          pane: 'main',
        });
        await fixture.documents.openDocument(second, { pane: 'main' });
        expect(
          fixture.state.paneStates().find((pane) => pane.pane === 'main')!
            .documentId,
        ).toBe(second);
      });

      it('createAndOpen creates and opens a document', async () => {
        const fixture = await makeFixture();
        const created = (await fixture.documents.createAndOpen(
          'fresh.md',
        )) as { documentId: string };
        expect(typeof created.documentId).toBe('string');
        expect(
          fixture.state.listDocuments().map((document) => document.documentId),
        ).toContain(created.documentId);
      });

      it('openLink opens existing documents and creates missing notes', async () => {
        const fixture = await makeFixture();
        await fixture.seedDocument('Welcome.md', '# Welcome');
        const existing = await fixture.documents.openLink('Welcome');
        expect(existing.created).toBe(false);
        const created = await fixture.documents.openLink('Brand new note');
        expect(created.created).toBe(true);
        expect(
          fixture.state.listDocuments().map((document) => document.documentId),
        ).toContain(created.documentId);
      });

      it('deleteDocument removes the document and its tabs', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('doomed.md', '# Doomed');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: 'main',
        });
        await fixture.documents.deleteDocument(id);
        expect(
          fixture.state.listDocuments().map((document) => document.documentId),
        ).not.toContain(id);
        expect(
          fixture.state
            .paneStates()
            .flatMap((pane) => pane.tabs)
            .map((tab) => tab.documentId),
        ).not.toContain(id);
      });

      it('prunes dangling tabs after an external delete', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('doomed.md', '# Doomed');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: 'main',
        });
        await fixture.deleteDocumentExternally(id);
        await fixture.documents.pruneMissingDocuments();
        expect(
          fixture.state
            .paneStates()
            .flatMap((pane) => pane.tabs)
            .map((tab) => tab.documentId),
        ).not.toContain(id);
      });

      it('saveActive reports null when empty and commits when open', async () => {
        const fixture = await makeFixture();
        expect(await fixture.documents.saveActive()).toBeNull();
        const id = await fixture.seedDocument('note.md', '# Note');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: 'main',
        });
        const result = await fixture.documents.saveActive();
        expect(result?.committed).toBe(true);
      });

      it('goBack and goForward walk per-pane history', async () => {
        const fixture = await makeFixture();
        const host = fixture.hostObject();
        const first = await fixture.seedDocument('one.md', '# One');
        const second = await fixture.seedDocument('two.md', '# Two');
        await fixture.host.openDocument(first, host, { pane: 'main' });
        await fixture.host.openDocument(second, host, { pane: 'main' });
        expect(await fixture.documents.goBack()).toBe(true);
        expect(
          fixture.state.paneStates().find((pane) => pane.pane === 'main')!
            .documentId,
        ).toBe(first);
        expect(await fixture.documents.goForward()).toBe(true);
        expect(
          fixture.state.paneStates().find((pane) => pane.pane === 'main')!
            .documentId,
        ).toBe(second);
        expect(await fixture.documents.goForward()).toBe(false);
      });
    });

    describe('host', () => {
      it('tracks editor attachment by reference identity', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        const host = fixture.hostObject();
        expect(fixture.host.isPaneAttached('main', host)).toBe(false);
        await fixture.host.openDocument(id, host, { pane: 'main' });
        expect(fixture.host.isPaneActive('main')).toBe(true);
        expect(fixture.host.isPaneAttached('main', host)).toBe(true);
        expect(
          fixture.host.isPaneAttached('main', fixture.hostObject()),
        ).toBe(false);
      });

      it('reattachPane swaps attachment to the replacement host', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        const first = fixture.hostObject();
        const replacement = fixture.hostObject();
        await fixture.host.openDocument(id, first, { pane: 'main' });
        await fixture.host.reattachPane('main', replacement);
        expect(fixture.host.isPaneAttached('main', replacement)).toBe(true);
        expect(fixture.host.isPaneAttached('main', first)).toBe(false);
      });

      it('tracks reader host attachment', async () => {
        const fixture = await makeFixture();
        const reader = fixture.hostObject();
        expect(fixture.host.isReaderAttached('main', reader)).toBe(false);
        fixture.host.setReaderHost('main', reader);
        expect(fixture.host.isReaderAttached('main', reader)).toBe(true);
      });
    });

    describe('reading', () => {
      it('reports a separate reader when the kind has one', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: 'main',
        });
        const presentation = fixture.reading.readingPresentation('main');
        expect(presentation.kind).toBe('separate-reader');
        if (presentation.kind === 'separate-reader') {
          // The reported provider serves the pane's kind (live registry
          // read, not a cached answer).
          expect(
            presentation.provider.kindIds.map(String),
          ).toContain(String(presentation.kindId));
        }
      });

      it('falls back to the editor surface when no reader is registered', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('paper.tex', 'lat-ex');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: 'main',
        });
        const presentation = fixture.reading.readingPresentation('main');
        expect(presentation.kind).toBe('editor-readonly');
      });

      it('projects Markdown text and null for other families', async () => {
        const fixture = await makeFixture();
        const host = fixture.hostObject();
        const markdown = await fixture.seedDocument('note.md', '# Note body');
        const latex = await fixture.seedDocument('paper.tex', 'lat-ex');
        await fixture.host.openDocument(markdown, host, { pane: 'main' });
        expect(fixture.reading.getPaneText('main')).toContain('Note body');
        await fixture.host.openDocument(latex, host, { pane: 'main' });
        expect(fixture.reading.getPaneText('main')).toBeNull();
      });

      it('reads and writes per-tab modes', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: 'main',
        });
        expect(fixture.reading.tabMode('main')).toBe('edit');
        const tabId = fixture.state
          .paneStates()
          .find((pane) => pane.pane === 'main')!.activeTab!;
        fixture.reading.setTabMode('main', tabId, 'reading');
        expect(fixture.reading.tabMode('main')).toBe('reading');
      });

      it('reveals addresses through the reading presentation', async () => {
        const fixture = await makeFixture();
        const id = await fixture.seedDocument('note.md', '# Note');
        await fixture.host.openDocument(id, fixture.hostObject(), {
          pane: 'main',
        });
        fixture.host.setReaderHost('main', fixture.hostObject());
        const tabId = fixture.state
          .paneStates()
          .find((pane) => pane.pane === 'main')!.activeTab!;
        fixture.reading.setTabMode('main', tabId, 'reading');
        expect(fixture.reading.revealAddress('main', 'note')).toBe(true);
      });
    });

    describe('tools', () => {
      it('reports no tools without a live session', async () => {
        const fixture = await makeFixture();
        expect(fixture.tools.execEditorCommand('undo', 'main')).toBe(false);
        expect(fixture.tools.canExecEditorCommand('undo', 'main')).toBe(false);
        expect(fixture.tools.editorToolSnapshot('main')).toBeNull();
        expect(await fixture.tools.executeEditorTool('main', 'bold')).toBe(
          false,
        );
      });
    });

    describe('ordering', () => {
      it('rapid A→B opens end with B active and both tabs present', async () => {
        const fixture = await makeFixture();
        const host = fixture.hostObject();
        const first = await fixture.seedDocument('one.md', '# One');
        const second = await fixture.seedDocument('two.md', '# Two');
        const openFirst = fixture.host.openDocument(first, host, {
          pane: 'main',
        });
        const openSecond = fixture.host.openDocument(second, host, {
          pane: 'main',
        });
        await Promise.all([openFirst, openSecond]);
        const main = fixture.state
          .paneStates()
          .find((pane) => pane.pane === 'main')!;
        expect(main.documentId).toBe(second);
        expect(main.tabs.map((tab) => tab.documentId)).toEqual([
          first,
          second,
        ]);
      });
    });
  });
}
