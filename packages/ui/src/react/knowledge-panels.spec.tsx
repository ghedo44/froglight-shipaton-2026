// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  documentRegistryToken,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  relationshipsToken,
  workspacePlugin,
  workspaceToken,
  workspacePath,
  type DocumentId,
  type DocumentKindId,
  type MarkdownModel,
  type Relationship,
  type RelationshipService,
  type ResourceId,
  type WorkspaceService,
} from '@froglight/foundation';
import {
  rightSidebarRegistryPlugin,
  rightSidebarRegistryToken,
  type RightSidebarContext,
  type RightSidebarPanelDef,
  type RightSidebarRegistry,
} from '../right-sidebar-registry.js';
import { installDefaultUi } from '../workbench.js';
import {
  BacklinksPanel,
  DocumentLivePanel,
  RelatedPanel,
  ReferencesPanel,
  createKnowledgePanelCounters,
  createKnowledgeRowCache,
  deriveKnowledgePanels,
  knowledgePanelsPlugin,
  readKnowledgePanels,
  resolveKnowledgePeer,
  type KnowledgePanelServices,
  type KnowledgeRowCache,
} from '../right-sidebar-panels.js';
import panelStyles from './RightSidebarPanels.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(unmount);

function knowledgeContext(
  overrides: Partial<RightSidebarContext> = {},
): RightSidebarContext {
  return {
    pane: 'main',
    documentId: 'doc-a',
    kindId: String(markdownKindId),
    title: 'a.md',
    path: 'a.md',
    mode: 'edit',
    availableModes: ['edit', 'reading'],
    dirty: false,
    text: '# A\n\nSee [B](b.md).\n',
    openDocument: () => undefined,
    revealAddress: () => undefined,
    setMode: () => undefined,
    exportPdf: () => undefined,
    ...overrides,
  };
}

function edge(
  overrides: Partial<Relationship> & {
    readonly id: string;
    readonly type: string;
  },
): Relationship {
  return {
    source: { resourceId: 'res-a' as ResourceId },
    target: {
      documentId: 'doc-b' as DocumentId,
      kindId: 'froglight.markdown' as DocumentKindId,
      location: { resourceId: 'res-b' as ResourceId },
    },
    metadata: {},
    ...overrides,
  } as Relationship;
}

interface StubServices extends KnowledgePanelServices {
  emitCommit(documentId: string): void;
  setEdges(edges: readonly Relationship[]): void;
}

function stubServices(input: {
  readonly docs?: ReadonlyArray<{ documentId: string; resourceId: string }>;
  readonly edges?: readonly Relationship[];
}): StubServices {
  let edges: readonly Relationship[] = input.edges ?? [];
  const docs = (
    input.docs ?? [
      { documentId: 'doc-a', resourceId: 'res-a' },
      { documentId: 'doc-b', resourceId: 'res-b' },
    ]
  ).map((doc) => ({
    documentId: doc.documentId as DocumentId,
    kindId: 'froglight.markdown' as DocumentKindId,
    location: { resourceId: doc.resourceId as ResourceId },
  }));
  const listeners = new Set<(documentId: unknown) => void>();
  const workspace = {
    listDocuments: () => [...docs],
    resolveResourcePath: (id: ResourceId) =>
      workspacePath(String(id).replace('res-', '') + '.md'),
    onDidCommit: (listener: (documentId: unknown) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const relationships = {
    list: () => [...edges],
    bySource: (resourceId: unknown) =>
      edges.filter(
        (entry) => String(entry.source.resourceId) === String(resourceId),
      ),
    byTarget: (documentId: unknown) =>
      edges.filter(
        (entry) => String(entry.target.documentId) === String(documentId),
      ),
  };
  return {
    workspace: workspace as unknown as StubServices['workspace'],
    relationships: relationships as unknown as StubServices['relationships'],
    emitCommit(documentId: string) {
      act(() => {
        for (const listener of [...listeners]) listener(documentId);
      });
    },
    setEdges(next: readonly Relationship[]) {
      edges = next;
    },
  };
}

describe('knowledge panels — peer resolution (stable identity first)', () => {
  const documents = [
    { documentId: 'doc-a', resourceId: 'res-a' },
    { documentId: 'doc-b', resourceId: 'res-b' },
  ];

  it('resolves by stable documentId before anything else', () => {
    expect(
      resolveKnowledgePeer({
        target: { documentId: 'doc-b', resourceId: 'res-b' },
        documents,
      }),
    ).toBe('doc-b');
  });

  it('falls back to stable resourceId (identity rule), never path/title', () => {
    expect(
      resolveKnowledgePeer({
        target: { documentId: 'renamed-synthetic', resourceId: 'res-b' },
        documents,
      }),
    ).toBe('doc-b');
  });

  it('resolves legacy href targets through the injected href seam', () => {
    expect(
      resolveKnowledgePeer({
        target: { documentId: 'b.md', resourceId: 'b.md', href: 'b.md' },
        documents: [{ documentId: 'doc-b', resourceId: 'b.md' }],
        resolveHref: (href) => (href === 'b.md' ? 'doc-b' : null),
      }),
    ).toBe('doc-b');
  });

  it('keeps dangling targets as null instead of inventing identity', () => {
    expect(
      resolveKnowledgePeer({
        target: { documentId: 'ghost.md', resourceId: 'ghost.md' },
        documents,
        resolveHref: () => null,
      }),
    ).toBeNull();
  });

  it('treats external hrefs as non-document peers', () => {
    expect(
      resolveKnowledgePeer({
        target: {
          documentId: 'https://example.com',
          resourceId: 'https://example.com',
          href: 'https://example.com',
        },
        documents,
        resolveHref: () => null,
      }),
    ).toBeNull();
  });
});

describe('knowledge panels — pure derivation', () => {
  const documents = [
    { documentId: 'doc-a', resourceId: 'res-a' },
    { documentId: 'doc-b', resourceId: 'res-b' },
    { documentId: 'doc-c', resourceId: 'res-c' },
  ];
  const peersFor = (target: {
    documentId: string;
    resourceId: string;
    href?: string;
  }): string | null => resolveKnowledgePeer({ target, documents });

  it('maps outgoing edges to rows with the exact source address', () => {
    const data = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [
        edge({
          id: 'rel-1',
          type: 'blockpage.link',
          source: {
            resourceId: 'res-a' as ResourceId,
            address: 'block-7',
          },
          metadata: { blockId: 'block-7' },
        }),
      ],
      resolveDocument: peersFor,
    });
    expect(data.outgoing).toHaveLength(1);
    expect(data.outgoing[0]).toMatchObject({
      id: 'rel-1',
      edgeType: 'blockpage.link',
      direction: 'outgoing',
      peerDocumentId: 'doc-b',
      reveal: 'block-7',
    });
    expect(data.incoming).toHaveLength(0);
    expect(data.outgoingCount).toBe(1);
    expect(data.incomingCount).toBe(0);
  });

  it('prefers alias then href for display labels, never as canonical identity', () => {
    const data = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md', alias: 'Bee' },
        }),
        edge({
          id: 'rel-2',
          type: 'markdown.link',
          metadata: { href: 'c-note', kind: 'wiki-link' },
          target: {
            documentId: 'doc-c' as DocumentId,
            kindId: 'froglight.markdown' as DocumentKindId,
            location: { resourceId: 'res-c' as ResourceId },
          },
        }),
      ],
      resolveDocument: peersFor,
    });
    expect(data.outgoing.map((row) => row.label)).toEqual(['Bee', 'c-note']);
    expect(data.outgoing.map((row) => row.peerDocumentId)).toEqual([
      'doc-b',
      'doc-c',
    ]);
  });

  it('marks markdown rows without an in-document address as non-revealable', () => {
    const data = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
      ],
      resolveDocument: peersFor,
    });
    expect(data.outgoing[0]?.reveal).toBeNull();
  });

  it('collects incoming edges by resolved peer, excluding self from related', () => {
    const data = deriveKnowledgePanels({
      documentId: 'doc-b',
      resourceId: 'res-b',
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          source: { resourceId: 'res-a' as ResourceId },
          metadata: { href: 'b.md' },
        }),
        edge({
          id: 'rel-self',
          type: 'blockpage.link',
          source: {
            resourceId: 'res-b' as ResourceId,
            address: 'block-1',
          },
          target: {
            documentId: 'doc-b' as DocumentId,
            kindId: 'froglight.blockpage' as DocumentKindId,
            location: { resourceId: 'res-b' as ResourceId },
          },
          metadata: { blockId: 'block-1' },
        }),
      ],
      resolveDocument: peersFor,
    });
    // Self edge counts as both outgoing and incoming; related excludes self.
    expect(data.outgoing.map((row) => row.id)).toEqual(['rel-self']);
    expect(data.incoming.map((row) => row.id)).toEqual(['rel-1', 'rel-self']);
    expect(data.incoming[0]).toMatchObject({
      direction: 'incoming',
      peerDocumentId: 'doc-a',
      reveal: null,
    });
    expect(data.incoming[1]).toMatchObject({
      peerDocumentId: 'doc-b',
      reveal: 'block-1',
    });
    expect(data.related.map((entry) => entry.documentId)).toEqual(['doc-a']);
    expect(data.related[0]).toMatchObject({
      outgoing: 0,
      incoming: 1,
      edgeTypes: ['markdown.link'],
    });
  });

  it('aggregates related documents deterministically with per-direction counts', () => {
    const data = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
        edge({
          id: 'rel-2',
          type: 'markdown.link',
          source: { resourceId: 'res-c' as ResourceId },
          target: {
            documentId: 'doc-a' as DocumentId,
            kindId: 'froglight.markdown' as DocumentKindId,
            location: { resourceId: 'res-a' as ResourceId },
          },
          metadata: { href: 'a.md' },
        }),
        edge({
          id: 'rel-3',
          type: 'blockpage.link',
          source: { resourceId: 'res-c' as ResourceId },
          target: {
            documentId: 'doc-a' as DocumentId,
            kindId: 'froglight.markdown' as DocumentKindId,
            location: { resourceId: 'res-a' as ResourceId },
          },
          metadata: { blockId: 'x' },
        }),
      ],
      resolveDocument: peersFor,
    });
    expect(data.related).toMatchObject([
      { documentId: 'doc-b', outgoing: 1, incoming: 0 },
      { documentId: 'doc-c', outgoing: 0, incoming: 2 },
    ]);
    expect(data.related[1]?.edgeTypes).toEqual([
      'blockpage.link',
      'markdown.link',
    ]);
  });

  it('drops dangling and external targets from related but keeps outgoing rows', () => {
    const data = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [
        edge({
          id: 'rel-ghost',
          type: 'markdown.link',
          target: {
            documentId: 'ghost.md' as DocumentId,
            kindId: 'froglight.markdown' as DocumentKindId,
            location: { resourceId: 'ghost.md' as ResourceId },
          },
          metadata: { href: 'ghost.md' },
        }),
        edge({
          id: 'rel-ext',
          type: 'markdown.link.external',
          target: {
            documentId: 'https://example.com' as DocumentId,
            kindId: 'froglight.markdown' as DocumentKindId,
            location: {
              resourceId: 'https://example.com' as ResourceId,
            },
          },
          metadata: { href: 'https://example.com' },
        }),
      ],
      resolveDocument: (target) => peersFor({ ...target, href: undefined }),
    });
    expect(data.outgoing).toHaveLength(2);
    expect(data.related).toHaveLength(0);
  });

  it('counts derivations and reuses unchanged rows by stable id', () => {
    const counters = createKnowledgePanelCounters();
    const cache: KnowledgeRowCache = createKnowledgeRowCache();
    const first = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
      ],
      resolveDocument: peersFor,
      counters,
      cache,
    });
    const second = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
      ],
      resolveDocument: peersFor,
      counters,
      cache,
    });
    expect(counters.derivations).toBe(2);
    expect(counters.rowsReused).toBeGreaterThan(0);
    expect(second.outgoing[0]).toBe(first.outgoing[0]);
  });
});

describe('knowledge panels — service read', () => {
  it('resolves the focused resourceId by stable documentId', () => {
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
      ],
    });
    const data = readKnowledgePanels(services, 'doc-a');
    expect(data.documentId).toBe('doc-a');
    expect(data.outgoing.map((row) => row.id)).toEqual(['rel-1']);
  });

  it('reads incoming for unknown documents but leaves outgoing empty', () => {
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          source: { resourceId: 'res-a' as ResourceId },
          target: {
            documentId: 'doc-ghost' as DocumentId,
            kindId: 'froglight.markdown' as DocumentKindId,
            location: { resourceId: 'res-ghost' as ResourceId },
          },
          metadata: { href: 'ghost.md' },
        }),
      ],
    });
    const data = readKnowledgePanels(services, 'doc-ghost');
    expect(data.outgoing).toEqual([]);
    expect(data.incoming.map((row) => row.id)).toEqual(['rel-1']);
  });

  it('returns empty panels when the graph holds no edges', () => {
    const data = readKnowledgePanels(stubServices({}), 'doc-a');
    expect(data.outgoing).toEqual([]);
    expect(data.incoming).toEqual([]);
    expect(data.related).toEqual([]);
  });
});

describe('knowledge panels — components', () => {
  it('renders outgoing rows and reveals the exact source address on activate', async () => {
    const revealed: string[] = [];
    const opened: unknown[] = [];
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'blockpage.link',
          source: {
            resourceId: 'res-a' as ResourceId,
            address: 'block-7',
          },
          metadata: { blockId: 'block-7' },
        }),
        edge({
          id: 'rel-2',
          type: 'markdown.link',
          metadata: { href: 'b.md', alias: 'Bee' },
        }),
      ],
    });
    const mounted = mount(
      createElement(ReferencesPanel, {
        context: knowledgeContext({
          openDocument: (id, address) => opened.push([id, address]),
          revealAddress: (address) => revealed.push(address),
        }),
        services,
      }),
    );
    expect(
      mounted.querySelector(`.${panelStyles['right-sidebar-heading']}`)
        ?.textContent,
    ).toBe('References');
    const primary = mounted.querySelector<HTMLButtonElement>(
      `button.${panelStyles['connection-primary']}`,
    )!;
    expect(mounted.textContent).toContain('b.md');
    await act(async () => {
      primary.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(opened).toEqual([['doc-b', undefined]]);
    const showSource = [...mounted.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show in this note',
    )!;
    await act(async () => showSource.click());
    expect(revealed).toEqual(['block-7']);
  });

  it('delegates unknown addresses verbatim instead of validating them', async () => {
    const revealed: string[] = [];
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'blockpage.link',
          source: {
            resourceId: 'res-a' as ResourceId,
            address: 'block-gone',
          },
          metadata: { blockId: 'block-gone' },
        }),
      ],
    });
    const mounted = mount(
      createElement(ReferencesPanel, {
        context: knowledgeContext({
          openDocument: () => undefined,
          revealAddress: (address) => revealed.push(address),
        }),
        services,
      }),
    );
    const button = [...mounted.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Show in this note',
    )!;
    await act(async () => {
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(revealed).toEqual(['block-gone']);
  });

  it('shows the references empty state when nothing is linked', () => {
    const mounted = mount(
      createElement(ReferencesPanel, {
        context: knowledgeContext(),
        services: stubServices({}),
      }),
    );
    expect(
      mounted.querySelector(`.${panelStyles['right-sidebar-empty']} strong`)
        ?.textContent,
    ).toBe('No references');
    expect(
      mounted.querySelector(`.${panelStyles['right-sidebar-empty']} span`)
        ?.textContent,
    ).toBe('This document doesn’t link to anything yet.');
    expect(mounted.querySelector(`.${panelStyles['outline-tree']}`)).toBeNull();
  });

  it('renders backlinks with source identity and backlink empty state', () => {
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          source: { resourceId: 'res-a' as ResourceId },
          target: {
            documentId: 'doc-b' as DocumentId,
            kindId: 'froglight.markdown' as DocumentKindId,
            location: { resourceId: 'res-b' as ResourceId },
          },
          metadata: { href: 'b.md' },
        }),
      ],
    });
    const backlinked = mount(
      createElement(BacklinksPanel, {
        context: knowledgeContext({ documentId: 'doc-b' }),
        services,
      }),
    );
    expect(
      backlinked.querySelector(`.${panelStyles['right-sidebar-heading']}`)
        ?.textContent,
    ).toBe('Backlinks');
    expect(backlinked.textContent).toContain('a.md');
    unmount();
    const empty = mount(
      createElement(BacklinksPanel, {
        context: knowledgeContext(),
        services: stubServices({}),
      }),
    );
    expect(
      empty.querySelector(`.${panelStyles['right-sidebar-empty']} strong`)
        ?.textContent,
    ).toBe('No backlinks');
    expect(
      empty.querySelector(`.${panelStyles['right-sidebar-empty']} span`)
        ?.textContent,
    ).toBe('Nothing links to this document yet.');
  });

  it('renders related documents with per-direction counts and empty state', () => {
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
      ],
    });
    const mounted = mount(
      createElement(RelatedPanel, {
        context: knowledgeContext(),
        services,
      }),
    );
    expect(
      mounted.querySelector(`.${panelStyles['right-sidebar-heading']}`)
        ?.textContent,
    ).toBe('Related');
    expect(mounted.textContent).toContain('b.md');
    unmount();
    const empty = mount(
      createElement(RelatedPanel, {
        context: knowledgeContext(),
        services: stubServices({}),
      }),
    );
    expect(
      empty.querySelector(`.${panelStyles['right-sidebar-empty']} strong`)
        ?.textContent,
    ).toBe('No related documents');
  });

  it('renders live document facts with an edge-type breakdown', () => {
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
        edge({
          id: 'rel-2',
          type: 'markdown.embed',
          metadata: { href: 'b.md' },
        }),
      ],
    });
    const mounted = mount(
      createElement(DocumentLivePanel, {
        context: knowledgeContext(),
        services,
      }),
    );
    expect(
      mounted.querySelector(`.${panelStyles['right-sidebar-heading']}`)
        ?.textContent,
    ).toBe('Link summary');
    expect(mounted.textContent).toContain('Outgoing');
    expect(mounted.textContent).toContain('Incoming');
    expect(mounted.textContent).toContain('Link');
    expect(mounted.textContent).toContain('Embed');
    unmount();
    const empty = mount(
      createElement(DocumentLivePanel, {
        context: knowledgeContext(),
        services: stubServices({}),
      }),
    );
    expect(
      empty.querySelector(`.${panelStyles['right-sidebar-empty']} strong`)
        ?.textContent,
    ).toBe('No links yet');
  });

  it('shows the unavailable empty state without workspace services', () => {
    for (const Panel of [
      ReferencesPanel,
      BacklinksPanel,
      RelatedPanel,
      DocumentLivePanel,
    ]) {
      const mounted = mount(
        createElement(Panel, { context: knowledgeContext(), services: null }),
      );
      expect(
        mounted.querySelector(`.${panelStyles['right-sidebar-empty']} strong`)
          ?.textContent,
      ).toBe('Knowledge unavailable');
      unmount();
    }
  });

  it('updates live on commit without remounting and reuses unchanged rows', () => {
    const counters = createKnowledgePanelCounters();
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'markdown.link',
          metadata: { href: 'b.md' },
        }),
      ],
    });
    const mounted = mount(
      createElement(ReferencesPanel, {
        context: knowledgeContext(),
        services,
        counters,
      }),
    );
    expect(counters.derivations).toBe(1);
    const before = mounted.querySelector(
      `.${panelStyles['connection-list']}`,
    )?.innerHTML;
    // A commit that changes nothing still re-derives but reuses row references.
    services.emitCommit('doc-b');
    expect(counters.derivations).toBe(2);
    expect(counters.commits).toBe(1);
    expect(counters.rowsReused).toBeGreaterThan(0);
    expect(
      mounted.querySelector(`.${panelStyles['connection-list']}`)?.innerHTML,
    ).toBe(before);
    // A commit that adds an edge renders the new row live.
    services.setEdges([
      edge({ id: 'rel-1', type: 'markdown.link', metadata: { href: 'b.md' } }),
      edge({
        id: 'rel-2',
        type: 'markdown.link',
        metadata: { href: 'c.md', alias: 'Cee' },
        target: {
          documentId: 'doc-c' as DocumentId,
          kindId: 'froglight.markdown' as DocumentKindId,
          location: { resourceId: 'res-c' as ResourceId },
        },
      }),
    ]);
    services.emitCommit('doc-a');
    expect(mounted.textContent).toContain('c.md');
    expect(counters.derivations).toBe(3);
  });

  it('unsubscribes on unmount so commits stop deriving', () => {
    const counters = createKnowledgePanelCounters();
    const services = stubServices({});
    mount(
      createElement(ReferencesPanel, {
        context: knowledgeContext(),
        services,
        counters,
      }),
    );
    expect(counters.derivations).toBe(1);
    unmount();
    services.emitCommit('doc-a');
    expect(counters.derivations).toBe(1);
    expect(counters.commits).toBe(0);
  });

  it('exposes knowledge rows as native buttons (: Tab/Enter, no traps)', () => {
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'blockpage.link',
          source: {
            resourceId: 'res-a' as ResourceId,
            address: 'block-7',
          },
          metadata: { blockId: 'block-7' },
        }),
      ],
    });
    const mounted = mount(
      createElement(ReferencesPanel, {
        context: knowledgeContext(),
        services,
      }),
    );
    const nav = mounted.querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe('Outgoing references');
    const buttons = [...mounted.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.disabled).toBe(false);
      // Natively tabbable in document order: no positive tabindex anywhere.
      expect(button.tabIndex).toBeLessThanOrEqual(0);
    }
    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);
    // No focus trap: panels own no keydown handlers, so Escape leaves focus
    // exactly where the screen reader expects it.
    act(() => {
      buttons[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('activates the destination row through keyboard Enter', async () => {
    const opened: unknown[] = [];
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-1',
          type: 'blockpage.link',
          source: {
            resourceId: 'res-a' as ResourceId,
            address: 'block-7',
          },
          metadata: { blockId: 'block-7' },
        }),
      ],
    });
    const mounted = mount(
      createElement(ReferencesPanel, {
        context: knowledgeContext({
          openDocument: (id, address) => opened.push([id, address]),
          revealAddress: () => undefined,
        }),
        services,
      }),
    );
    const button = mounted.querySelector<HTMLButtonElement>(
      `button.${panelStyles['connection-primary']}`,
    )!;
    button.focus();
    expect(document.activeElement).toBe(button);
    // Native buttons fire click on Enter/Space; panels own no keydown
    // handlers, so keyboard activation flows through onClick → revealAddress.
    // jsdom never synthesizes that click from a key event, so button.click()
    // stands in for the browser's native Enter activation here.
    act(() => {
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(button);
    expect(opened).toEqual([]);
    await act(async () => {
      button.click();
    });
    expect(opened).toEqual([['doc-b', undefined]]);
  });

  it('keeps Backlinks keyboard activation at parity with References', async () => {
    const opened: unknown[] = [];
    const services = stubServices({
      edges: [
        edge({
          id: 'rel-self',
          type: 'blockpage.link',
          source: {
            resourceId: 'res-b' as ResourceId,
            address: 'block-1',
          },
          target: {
            documentId: 'doc-b' as DocumentId,
            kindId: 'froglight.blockpage' as DocumentKindId,
            location: { resourceId: 'res-b' as ResourceId },
          },
          metadata: { blockId: 'block-1' },
        }),
      ],
    });
    const mounted = mount(
      createElement(BacklinksPanel, {
        context: knowledgeContext({
          documentId: 'doc-b',
          openDocument: (id, address) => opened.push([id, address]),
          revealAddress: () => undefined,
        }),
        services,
      }),
    );
    expect(mounted.querySelector('nav')?.getAttribute('aria-label')).toBe(
      'Incoming backlinks',
    );
    const buttons = [...mounted.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons[0]!.type).toBe('button');
    expect(buttons[0]!.tabIndex).toBeLessThanOrEqual(0);
    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => {
      buttons[0]!.click();
    });
    expect(opened).toEqual([['doc-b', 'block-1']]);
  });
});

describe('knowledge panels — registration', () => {
  async function captureRegistry(
    runtime: Runtime,
  ): Promise<RightSidebarRegistry> {
    let captured: RightSidebarRegistry | null = null;
    const probeId = `test.capture-${Math.random().toString(36).slice(2)}`;
    await runtime.registerSlot({
      id: probeId,
      plugin: definePlugin({
        id: probeId,
        requirements: { requires: [rightSidebarRegistryToken] },
        activate: (ctx) => {
          captured = ctx.require(rightSidebarRegistryToken);
        },
      }),
    });
    if (captured === null) throw new Error('registry failed to activate');
    return captured;
  }

  it('registers four always-visible panels in a stable order', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: rightSidebarRegistryPlugin,
    });
    await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    const registry = await captureRegistry(runtime);
    const empty = knowledgeContext();
    expect(registry.list(empty).map((panel) => panel.id)).toEqual([
      'references',
      'backlinks',
      'related',
      'document-live',
    ]);
    for (const id of ['references', 'backlinks', 'related', 'document-live']) {
      expect(registry.get(id)?.when, `${id} has no when gate`).toBeUndefined();
    }
    await runtime.dispose();
  });

  it('registers without workspace services and still shows unavailable states', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: rightSidebarRegistryPlugin,
    });
    await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    const registry = await captureRegistry(runtime);
    const ReferencesComponent = registry.get('references')!.component;
    const mounted = mount(
      createElement(ReferencesComponent!, {
        context: knowledgeContext(),
      }),
    );
    expect(
      mounted.querySelector(`.${panelStyles['right-sidebar-empty']} strong`)
        ?.textContent,
    ).toBe('Knowledge unavailable');
    await runtime.dispose();
  });

  it('owns four registrations with dispose/reactivate symmetry', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: rightSidebarRegistryPlugin,
    });
    await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    const registry = await captureRegistry(runtime);
    const context = knowledgeContext();
    expect(registry.list(context)).toHaveLength(4);
    await runtime.removeSlot('knowledge');
    expect(registry.list(context)).toHaveLength(0);
    await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    expect(registry.list(context)).toHaveLength(4);
    await runtime.dispose();
  });
});

describe('knowledge panels — live workspace integration', () => {
  async function composeKnowledge(): Promise<{
    runtime: Runtime;
    registry: RightSidebarRegistry;
    workspace: WorkspaceService;
    relationships: RelationshipService;
  }> {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    await runtime.registerSlot({
      id: 'markdown-kind',
      plugin: definePlugin({
        id: 'test.markdown-kind',
        requirements: { requires: [documentRegistryToken] },
        activate: (ctx) => {
          ctx.effect(
            () =>
              ctx.require(documentRegistryToken).register(markdownKind).dispose,
          );
        },
      }),
    });
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: rightSidebarRegistryPlugin,
    });
    await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    let registry: RightSidebarRegistry | null = null;
    let workspace: WorkspaceService | null = null;
    let relationships: RelationshipService | null = null;
    await runtime.registerSlot({
      id: 'probe',
      plugin: definePlugin({
        id: 'test.knowledge-probe',
        requirements: {
          requires: [
            rightSidebarRegistryToken,
            workspaceToken,
            relationshipsToken,
          ],
        },
        activate: (ctx) => {
          registry = ctx.require(rightSidebarRegistryToken);
          workspace = ctx.require(workspaceToken) as WorkspaceService;
          relationships = ctx.require(
            relationshipsToken,
          ) as RelationshipService;
        },
      }),
    });
    if (registry === null || workspace === null || relationships === null) {
      throw new Error('knowledge composition failed');
    }
    return { runtime, registry, workspace, relationships };
  }

  function contextFor(documentId: string): RightSidebarContext {
    return knowledgeContext({ documentId });
  }

  it('derives backlinks from real markdown links and updates them on save', async () => {
    const { runtime, registry, workspace } = await composeKnowledge();
    const target = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('b.md'),
      initialModel: { raw: '# Bee\n' },
    });
    const source = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('a.md'),
      initialModel: { raw: '# Aye\n\nSee [Bee](b.md).\n' },
    });
    const BacklinksComponent = registry.get('backlinks')!.component!;
    const revealed: string[] = [];
    const mountedHost = document.createElement('div');
    document.body.appendChild(mountedHost);
    const slotRoot = createRoot(mountedHost);
    await act(async () => {
      slotRoot.render(
        createElement(BacklinksComponent, {
          context: {
            ...contextFor(String(target.documentId)),
            openDocument: () => undefined,
            revealAddress: (address: string) => revealed.push(address),
          },
        }),
      );
    });
    try {
      expect(mountedHost.textContent).toContain('a.md');
      expect(
        mountedHost.querySelector(`.${panelStyles['right-sidebar-empty']}`),
      ).toBeNull();
      // Editing the source to remove the link updates backlinks on save.
      const session = (await workspace.openDocument(
        source.documentId,
      )) as unknown as {
        model: MarkdownModel;
        markDirty(): void;
        save(): Promise<unknown>;
      };
      (session.model as unknown as { raw: string }).raw =
        '# Aye\n\nNo links here.\n';
      session.markDirty();
      await act(async () => {
        await session.save();
      });
      expect(
        mountedHost.querySelector(
          `.${panelStyles['right-sidebar-empty']} strong`,
        )?.textContent,
      ).toBe('No backlinks');
      expect(revealed).toEqual([]);
    } finally {
      await act(async () => {
        slotRoot.unmount();
      });
      mountedHost.remove();
      await runtime.dispose();
    }
  });

  it('reveals the exact block source for resource edges end to end', async () => {
    const { runtime, registry, workspace, relationships } =
      await composeKnowledge();
    const doc = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('solo.md'),
      initialModel: { raw: '# Solo\n' },
    });
    relationships.add({
      type: 'blockpage.link',
      source: {
        resourceId: doc.location.resourceId,
        address: 'block-3',
      },
      target: {
        documentId: doc.documentId,
        kindId: doc.kindId,
        location: { resourceId: doc.location.resourceId },
      },
      metadata: { blockId: 'block-3' },
    });
    const ReferencesComponent = registry.get('references')!.component!;
    const revealed: string[] = [];
    const mountedHost = document.createElement('div');
    document.body.appendChild(mountedHost);
    const slotRoot = createRoot(mountedHost);
    await act(async () => {
      slotRoot.render(
        createElement(ReferencesComponent, {
          context: {
            ...contextFor(String(doc.documentId)),
            openDocument: () => undefined,
            revealAddress: (address: string) => revealed.push(address),
          },
        }),
      );
    });
    try {
      const button = [...mountedHost.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Show in this note',
      )!;
      await act(async () => {
        button.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      });
      expect(revealed).toEqual(['block-3']);
    } finally {
      await act(async () => {
        slotRoot.unmount();
      });
      mountedHost.remove();
      await runtime.dispose();
    }
  });
});

describe('knowledge panels — cache pruning under churn', () => {
  const documents = [
    { documentId: 'doc-a', resourceId: 'res-a' },
    ...Array.from({ length: 50 }, (_, index) => ({
      documentId: `doc-p${index}`,
      resourceId: `res-p${index}`,
    })),
  ];
  const peersFor = (target: {
    documentId: string;
    resourceId: string;
    href?: string;
  }): string | null => resolveKnowledgePeer({ target, documents });
  function bulkEdges(count: number): Relationship[] {
    return Array.from({ length: count }, (_, index) =>
      edge({
        id: `rel-${index}`,
        type: 'markdown.link',
        metadata: { href: `p${index}.md` },
        target: {
          documentId: `doc-p${index}` as DocumentId,
          kindId: 'froglight.markdown' as DocumentKindId,
          location: { resourceId: `res-p${index}` as ResourceId },
        },
      }),
    );
  }

  it('evicts deleted rows/related entries while reusing survivors by reference', () => {
    const counters = createKnowledgePanelCounters();
    const cache: KnowledgeRowCache = createKnowledgeRowCache();
    const full = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: bulkEdges(50),
      resolveDocument: peersFor,
      counters,
      cache,
    });
    expect(full.outgoing).toHaveLength(50);
    expect(cache.rows.size).toBe(50);
    expect(cache.related.size).toBe(50);
    const survivorBefore = full.outgoing[0]!;

    // Bulk delete: keep only rel-0. Pruning must drop the other 49 row
    // slots and 49 related slots; the survivor keeps referential identity.
    const pruned = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: bulkEdges(50).slice(0, 1),
      resolveDocument: peersFor,
      counters,
      cache,
    });
    expect(pruned.outgoing).toHaveLength(1);
    expect(pruned.outgoing[0]).toBe(survivorBefore);
    expect(cache.rows.size).toBe(1);
    expect(cache.related.size).toBe(1);

    // Delete everything: caches drain to zero (memory bounded).
    const empty = deriveKnowledgePanels({
      documentId: 'doc-a',
      resourceId: 'res-a',
      edges: [],
      resolveDocument: peersFor,
      counters,
      cache,
    });
    expect(empty.outgoing).toEqual([]);
    expect(empty.related).toEqual([]);
    expect(cache.rows.size).toBe(0);
    expect(cache.related.size).toBe(0);
  });
});

describe('knowledge panels — registration atomicity', () => {
  it('leaves no leaked tabs when a mid-batch registration throws', async () => {
    const runtime = new Runtime();
    const live = new Map<string, RightSidebarPanelDef>();
    const throwingRegistry: RightSidebarRegistry = {
      register(panel) {
        if (panel.id === 'backlinks') throw new Error('boom-backlinks');
        live.set(panel.id, panel);
        return {
          dispose: () => {
            live.delete(panel.id);
          },
        };
      },
      list: () => [...live.values()],
      get: (id) => live.get(id),
      onDidChange: () => ({ dispose: () => undefined }),
    };
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: definePlugin({
        id: 'test.throwing-registry',
        activate: (ctx) => {
          ctx.provide(rightSidebarRegistryToken, throwingRegistry);
        },
      }),
    });
    const slot = await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    // Four separate effect-owned registrations roll back via the runtime
    // scope: the successful `references` registration is unwound when
    // `backlinks` throws, so no tab leaks.
    expect(slot.state).toBe('failed');
    expect([...live.keys()]).toEqual([]);
    await runtime.dispose();
  });
});

describe('knowledge panels — vault lifecycle', () => {
  async function markdownKindSlot(runtime: Runtime): Promise<void> {
    await runtime.registerSlot({
      id: 'markdown-kind',
      plugin: definePlugin({
        id: 'test.markdown-kind-lifecycle',
        requirements: { requires: [documentRegistryToken] },
        activate: (ctx) => {
          ctx.effect(
            () =>
              ctx.require(documentRegistryToken).register(markdownKind).dispose,
          );
        },
      }),
    });
  }

  async function currentWorkspace(
    runtime: Runtime,
  ): Promise<WorkspaceService | null> {
    let captured: WorkspaceService | null = null;
    const probeId = `test.ws-probe-${Math.random().toString(36).slice(2)}`;
    await runtime.registerSlot({
      id: probeId,
      plugin: definePlugin({
        id: probeId,
        requirements: { optionallyRequires: [workspaceToken] },
        activate: (ctx) => {
          captured = (ctx.try(workspaceToken) as WorkspaceService) ?? null;
        },
      }),
    });
    await runtime.removeSlot(probeId);
    return captured;
  }

  it('goes live when the vault appears after cold-boot launcher (no sticky unavailable)', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: rightSidebarRegistryPlugin,
    });
    // Cold boot: knowledge installs with no vault/workspace (launcher).
    await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    const holder: { registry: RightSidebarRegistry | null } = {
      registry: null,
    };
    await runtime.registerSlot({
      id: 'capture',
      plugin: definePlugin({
        id: 'test.capture-coldboot',
        requirements: { requires: [rightSidebarRegistryToken] },
        activate: (ctx) => {
          holder.registry = ctx.require(rightSidebarRegistryToken);
        },
      }),
    });
    const registry = holder.registry;
    if (registry === null) throw new Error('registry missing');
    const Host = registry.get('references')!.component!;
    const mountedHost = document.createElement('div');
    document.body.appendChild(mountedHost);
    const slotRoot = createRoot(mountedHost);
    try {
      await act(async () => {
        slotRoot.render(createElement(Host, { context: knowledgeContext() }));
      });
      expect(
        mountedHost.querySelector(
          `.${panelStyles['right-sidebar-empty']} strong`,
        )?.textContent,
      ).toBe('Knowledge unavailable');

      // Vault + workspace appear later: the live resolver picks them up on
      // the next Host render — no reinstall, no sticky unavailable.
      await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
      await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
      await markdownKindSlot(runtime);
      await act(async () => {
        slotRoot.render(createElement(Host, { context: knowledgeContext() }));
      });
      // No edges yet, but services are live: kind-neutral empty state,
      // never the unavailable state.
      expect(
        mountedHost.querySelector(
          `.${panelStyles['right-sidebar-empty']} strong`,
        )?.textContent,
      ).toBe('No references');
    } finally {
      await act(async () => {
        slotRoot.unmount();
      });
      mountedHost.remove();
      await runtime.dispose();
    }
  });

  it('refreshes across vault close/reopen without stale reads', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    await markdownKindSlot(runtime);
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: rightSidebarRegistryPlugin,
    });
    await runtime.registerSlot({
      id: 'knowledge',
      plugin: knowledgePanelsPlugin,
    });
    const holder: { registry: RightSidebarRegistry | null } = {
      registry: null,
    };
    await runtime.registerSlot({
      id: 'capture',
      plugin: definePlugin({
        id: 'test.capture-lifecycle',
        requirements: { requires: [rightSidebarRegistryToken] },
        activate: (ctx) => {
          holder.registry = ctx.require(rightSidebarRegistryToken);
        },
      }),
    });
    const registry = holder.registry;
    if (registry === null) throw new Error('registry missing');
    const firstWorkspace = await currentWorkspace(runtime);
    if (firstWorkspace === null) throw new Error('workspace missing');
    const target = await firstWorkspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('b.md'),
      initialModel: { raw: '# Bee\n' },
    });
    await firstWorkspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('a.md'),
      initialModel: { raw: '# Aye\n\nSee [Bee](b.md).\n' },
    });
    const Host = registry.get('backlinks')!.component!;
    const mountedHost = document.createElement('div');
    document.body.appendChild(mountedHost);
    const slotRoot = createRoot(mountedHost);
    try {
      await act(async () => {
        slotRoot.render(
          createElement(Host, {
            context: knowledgeContext({
              documentId: String(target.documentId),
            }),
          }),
        );
      });
      expect(mountedHost.textContent).toContain('a.md');

      // Vault close withdraws workspace/relationships: next resolve fails
      // closed to null instead of reading the disposed binding.
      await runtime.removeSlot('vault');
      await act(async () => {
        slotRoot.render(
          createElement(Host, {
            context: knowledgeContext({
              documentId: String(target.documentId),
            }),
          }),
        );
      });
      expect(
        mountedHost.querySelector(
          `.${panelStyles['right-sidebar-empty']} strong`,
        )?.textContent,
      ).toBe('Knowledge unavailable');
      expect(mountedHost.textContent).not.toContain('Bee');

      // Reopen yields a fresh vault (old docs are gone — proves no stale
      // reads when the new graph renders).
      await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
      const secondWorkspace = await currentWorkspace(runtime);
      if (secondWorkspace === null) throw new Error('reopened missing');
      expect(secondWorkspace).not.toBe(firstWorkspace);
      const fresh = await secondWorkspace.createDocument({
        kindId: markdownKindId,
        path: workspacePath('fresh.md'),
        initialModel: { raw: '# Fresh\n' },
      });
      await act(async () => {
        slotRoot.render(
          createElement(Host, {
            context: knowledgeContext({
              documentId: String(fresh.documentId),
            }),
          }),
        );
      });
      // Fresh vault has no edges: live empty state over fresh services,
      // never the disposed vault's "Bee" row.
      expect(
        mountedHost.querySelector(
          `.${panelStyles['right-sidebar-empty']} strong`,
        )?.textContent,
      ).toBe('No backlinks');
      expect(mountedHost.textContent).not.toContain('Bee');
    } finally {
      await act(async () => {
        slotRoot.unmount();
      });
      mountedHost.remove();
      await runtime.dispose();
    }
  });
});

describe('knowledge panels — default UI composition', () => {
  it('exposes four knowledge tabs through installDefaultUi', async () => {
    const runtime = new Runtime();
    const ui = await installDefaultUi(runtime);
    try {
      const context = knowledgeContext();
      const ids = ui.rightSidebar.list(context).map((panel) => panel.id);
      for (const expected of [
        'references',
        'backlinks',
        'related',
        'document-live',
      ]) {
        expect(ids, `default UI exposes ${expected}`).toContain(expected);
      }
      for (const id of [
        'references',
        'backlinks',
        'related',
        'document-live',
      ]) {
        expect(
          ui.rightSidebar.get(id)?.when,
          `${id} has no when gate`,
        ).toBeUndefined();
      }
      // The vault-scoped settings tab activates only once workspace settings
      // are available; this host-only composition has no open workspace.
      expect(ids).not.toContain('document-settings');
    } finally {
      await runtime.dispose();
    }
  });
});

describe('knowledge navigation', () => {
  it('labels incoming links by source and opens that source address', () => {
    const opened: unknown[] = [];
    const services = stubServices({
      edges: [
        edge({
          id: 'link',
          type: 'markdown.link',
          source: { resourceId: 'res-a' as ResourceId, address: 'block-7' },
          metadata: { href: 'b.md', alias: 'Target alias' },
        }),
      ],
    });
    const element = mount(
      createElement(BacklinksPanel, {
        services,
        context: knowledgeContext({
          documentId: 'doc-b',
          openDocument: (id, address) => opened.push([id, address]),
        }),
      }),
    );
    const button = element.querySelector<HTMLButtonElement>('button');
    expect(button?.textContent).toContain('a.md');
    act(() => button?.click());
    expect(opened).toEqual([['doc-a', 'block-7']]);
  });

  it('names related documents by current path and opens their stable identity', () => {
    const opened: string[] = [];
    const services = stubServices({
      edges: [edge({ id: 'link', type: 'markdown.link' })],
    });
    const element = mount(
      createElement(RelatedPanel, {
        services,
        context: knowledgeContext({ openDocument: (id) => opened.push(id) }),
      }),
    );
    const button = element.querySelector<HTMLButtonElement>('button');
    expect(button?.textContent).toContain('b.md');
    act(() => button?.click());
    expect(opened).toEqual(['doc-b']);
  });
});
