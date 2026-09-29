// @vitest-environment jsdom
/**
 * Outline context wiring.
 *
 * The generic outline path live end-to-end: the shell context builder
 * populates `context.outline` + `context.outlineRevision` from a
 * structural outline registry (compatible), the panel renders rows
 * verbatim with no per-kind fork, and Markdown keeps working through the
 * same generic path (workbench-owned registry).
 *
 * Covers: non-Markdown rows through the REAL builder, Markdown intact,
 * referential stability on revision hit, revision advance, unknown-kind
 * fail-closed, frozen-row discipline, 1:1 plain-data translation, and
 * effect-owned invalidation on unmount.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockPageKindId,
  extractHeadings,
  latexKindId,
  markdownKindId,
  notebookKindId,
} from '@froglight/foundation';
import {
  buildRightSidebarContext,
  useSidebarOutlineInvalidation,
  type SidebarOutlineRegistryLike,
  type SidebarOutlineRowLike,
} from './workspace/hooks/useRightSidebarContext.js';
import { OutlinePanel } from './RightSidebarPanels.jsx';
import { WorkspaceView } from './WorkspaceView.jsx';
import {
  createFakeWorkbenchController,
  createHarness,
  makeChoice,
  settle,
  until,
} from './test-support.js';
import type { PaneView } from '../workbench.js';
import type { WorkbenchDocumentView } from '../workbench-view.js';
import type { WorkbenchOutlineProviderLike } from '../workbench-view.js';
import panelStyles from './RightSidebarPanels.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement): HTMLElement {
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

function paneState(documentId: string | null): PaneView {
  return {
    pane: 'main',
    tabs: [],
    activeTab: null,
    mode: 'edit',
    documentId,
    viewId: null,
    title: 'doc',
    path: 'doc',
    dirty: false,
    recoveryWarnings: [],
    canGoBack: false,
    canGoForward: false,
  };
}

function docView(documentId: string, kindId: string): WorkbenchDocumentView {
  return { documentId, kindId, path: documentId, title: documentId };
}

function readingWithText(text: string | null) {
  return {
    onDidChange: () => ({ dispose: () => undefined }),
    readingPresentation: () =>
      ({ kind: 'editor-readonly', kindId: null }) as const,
    getPaneText: () => text,
    availableTabModes: () => ['edit', 'reading'] as const,
    tabMode: () => 'edit' as const,
    setTabMode: () => undefined,
    openDocument: () => undefined,
    revealAddress: () => true,
  };
}

/** Minimal revision-keyed fake mirroring the module contract.*/
function createFakeRegistry(): SidebarOutlineRegistryLike & {
  calls: number;
  invalidated: { kindId?: string; identity?: string }[];
  extractors: Map<string, (model: unknown) => SidebarOutlineRowLike[]>;
} {
  const extractors = new Map<
    string,
    (model: unknown) => SidebarOutlineRowLike[]
  >();
  const slots = new Map<
    string,
    { key: string | number; rows: readonly SidebarOutlineRowLike[] }
  >();
  const invalidated: { kindId?: string; identity?: string }[] = [];
  const registry: SidebarOutlineRegistryLike & {
    calls: number;
    invalidated: typeof invalidated;
    extractors: typeof extractors;
  } = {
    calls: 0,
    invalidated,
    extractors,
    supports: (kindId) => extractors.has(String(kindId)),
    getOutline(kindId, model, revision, input) {
      const extractor = extractors.get(String(kindId));
      if (extractor === undefined) {
        const error = new Error(
          `unknown outline kind: ${String(kindId)}`,
        ) as Error & {
          code: string;
        };
        error.code = 'UNKNOWN_OUTLINE_KIND';
        throw error;
      }
      const identity = input?.documentIdentity ?? '';
      const key = `${String(kindId)}${identity}`;
      const effective = revision ?? JSON.stringify(model);
      const slot = slots.get(key);
      if (slot !== undefined && slot.key === effective) return slot.rows;
      registry.calls += 1;
      const rows = Object.freeze(
        extractor(model).map((row) => Object.freeze({ ...row })),
      );
      slots.set(key, { key: effective, rows });
      return rows;
    },
    invalidate(kindId, documentIdentity) {
      invalidated.push({ kindId, identity: documentIdentity });
      if (kindId === undefined && documentIdentity === undefined) {
        slots.clear();
        return;
      }
      if (kindId !== undefined && documentIdentity !== undefined) {
        slots.delete(`${String(kindId)}${documentIdentity}`);
        return;
      }
      if (kindId !== undefined) {
        const prefix = `${String(kindId)}`;
        for (const k of [...slots.keys()])
          if (k.startsWith(prefix)) slots.delete(k);
        return;
      }
      const suffix = `${documentIdentity as string}`;
      for (const k of [...slots.keys()])
        if (k.endsWith(suffix)) slots.delete(k);
    },
  };
  return registry;
}

function markdownRegistry() {
  const registry = createFakeRegistry();
  registry.extractors.set(String(markdownKindId), (model) =>
    extractHeadings(model as string).map((heading) => ({
      id: heading.slug,
      address: heading.slug,
      level: heading.level,
      label: heading.text,
    })),
  );
  return registry;
}

describe('outline context wiring', () => {
  it('populates non-Markdown rows through the real builder (1:1 plain data)', () => {
    const registry = createFakeRegistry();
    registry.extractors.set('test.beta', () => [
      { id: 'page-a', address: 'page-a', level: 1, label: 'Site A' },
      { id: 'page-a:obj-1', address: 'page-a', level: 2, label: 'Canopy' },
    ]);
    const context = buildRightSidebarContext({
      reading: readingWithText(null),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-9'),
      focusedDocument: docView('doc-9', 'test.beta'),
      notify: () => undefined,
      outlineRegistry: registry,
      outlineModel: { pages: [{ id: 'page-a' }] },
      outlineRevision: 7,
    });
    expect(context?.outline?.map((row) => row.label)).toEqual([
      'Site A',
      'Canopy',
    ]);
    expect(context?.outlineRevision).toBe(7);
    // 1:1 translation: only the four plain fields cross, frozen, no `kind`.
    expect(context?.outline?.[1]).toEqual({
      id: 'page-a:obj-1',
      address: 'page-a',
      level: 2,
      label: 'Canopy',
    });
    for (const row of context?.outline ?? []) {
      expect(Object.isFrozen(row)).toBe(true);
      expect('kind' in row).toBe(false);
    }
    expect(Object.isFrozen(context?.outline)).toBe(true);
    // Object rows delegate their page-scoped address (panel seam).
    const mounted = mount(createElement(OutlinePanel, { context: context! }));
    const buttons = [
      ...mounted.querySelectorAll<HTMLButtonElement>(
        `.${panelStyles['outline-entry']}`,
      ),
    ];
    expect(buttons.map((entry) => entry.textContent)).toEqual([
      'Site A',
      'Canopy',
    ]);
  });

  it('keeps Markdown behavior intact through the same generic path', () => {
    const registry = markdownRegistry();
    const context = buildRightSidebarContext({
      reading: readingWithText('# Field notes\n\n## Habitat'),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-1'),
      focusedDocument: docView('doc-1', String(markdownKindId)),
      notify: () => undefined,
      outlineRegistry: registry,
      outlineRevision: 'rev-md-1',
    });
    // No per-kind UI fork: Markdown flows through getOutline like any kind.
    expect(registry.getOutline).toBeDefined();
    expect(context?.outline?.map((row) => row.label)).toEqual([
      'Field notes',
      'Habitat',
    ]);
    const mounted = mount(createElement(OutlinePanel, { context: context! }));
    expect(
      [...mounted.querySelectorAll(`.${panelStyles['outline-entry']}`)].map(
        (entry) => entry.textContent,
      ),
    ).toEqual(['Field notes', 'Habitat']);
  });

  it('preserves referential stability on revision hit and refreshes on advance', () => {
    const registry = createFakeRegistry();
    registry.extractors.set('test.alpha', (model) =>
      (model as readonly { slug: string; text: string }[]).map((heading) => ({
        id: heading.slug,
        address: heading.slug,
        level: 1,
        label: heading.text,
      })),
    );
    const model = [{ slug: 'a', text: 'A' }];
    const input = {
      reading: readingWithText(null),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-1'),
      focusedDocument: docView('doc-1', 'test.alpha'),
      notify: () => undefined,
      outlineRegistry: registry,
      outlineModel: model,
      outlineRevision: 'rev-1',
    } as const;
    const first = buildRightSidebarContext(input);
    const second = buildRightSidebarContext(input);
    expect(registry.calls).toBe(1);
    expect(second?.outline).toBe(first?.outline);
    const third = buildRightSidebarContext({
      ...input,
      outlineRevision: 'rev-2',
    });
    expect(registry.calls).toBe(2);
    expect(third?.outline).not.toBe(first?.outline);
  });

  it('fails closed for unknown kinds (tab hidden, never throws)', () => {
    const registry = createFakeRegistry();
    const context = buildRightSidebarContext({
      reading: readingWithText(null),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-x'),
      focusedDocument: docView('doc-x', 'test.unknown'),
      notify: () => undefined,
      outlineRegistry: registry,
      outlineModel: {},
      outlineRevision: 'rev-1',
    });
    expect(context?.outline).toBeUndefined();
  });

  it('invalidates the document slot on unmount via the effect-owned hook', () => {
    const registry = createFakeRegistry();
    registry.extractors.set('test.beta', () => [
      { id: 'p', address: 'p', level: 1, label: 'P' },
    ]);
    function Probe(): React.ReactElement {
      useSidebarOutlineInvalidation(registry, 'test.beta', 'doc-9');
      return createElement('div');
    }
    mount(createElement(Probe));
    expect(registry.invalidated).toEqual([]);
    unmount();
    expect(registry.invalidated).toEqual([
      { kindId: 'test.beta', identity: 'doc-9' },
    ]);
  });

  it('never mutates frozen provider rows', () => {
    const registry = createFakeRegistry();
    const frozenModel = Object.freeze({ pages: [] });
    registry.extractors.set('test.beta', () => [
      { id: 'p', address: 'p', level: 1, label: 'P' },
    ]);
    const first = buildRightSidebarContext({
      reading: readingWithText(null),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-9'),
      focusedDocument: docView('doc-9', 'test.beta'),
      notify: () => undefined,
      outlineRegistry: registry,
      outlineModel: frozenModel,
      outlineRevision: 'rev-1',
    });
    const snapshot = JSON.parse(JSON.stringify(first?.outline)) as unknown;
    buildRightSidebarContext({
      reading: readingWithText(null),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-9'),
      focusedDocument: docView('doc-9', 'test.beta'),
      notify: () => undefined,
      outlineRegistry: registry,
      outlineModel: frozenModel,
      outlineRevision: 'rev-1',
    });
    expect(first?.outline).toEqual(snapshot);
  });

  describe('error-branch split + shell-owned registry', () => {
    it('warns and fails closed for unexpected extractor errors', () => {
      const registry = createFakeRegistry();
      registry.extractors.set('test.alpha', () => {
        throw new Error('extractor boom');
      });
      const warned: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]): void => {
        warned.push(args);
      };
      try {
        const context = buildRightSidebarContext({
          reading: readingWithText(null),
          pdf: {} as never,
          openDocument: () => undefined,
          focusedPane: 'main',
          focusedState: paneState('doc-1'),
          focusedDocument: docView('doc-1', 'test.alpha'),
          notify: () => undefined,
          outlineRegistry: registry,
          outlineModel: [{ slug: 'a', text: 'A' }],
          outlineRevision: 'rev-1',
        });
        expect(context?.outline).toBeUndefined();
        expect(context?.outlineRevision).toBeUndefined();
      } finally {
        console.warn = original;
      }
      expect(
        warned.some((args) =>
          String(args[0]).includes('[right-sidebar-context]'),
        ),
      ).toBe(true);
    });

    it('keeps unknown-kind failures silent (fail closed, no warn)', () => {
      const registry = createFakeRegistry();
      const warned: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]): void => {
        warned.push(args);
      };
      try {
        const context = buildRightSidebarContext({
          reading: readingWithText(null),
          pdf: {} as never,
          openDocument: () => undefined,
          focusedPane: 'main',
          focusedState: paneState('doc-x'),
          focusedDocument: docView('doc-x', 'test.unknown'),
          notify: () => undefined,
          outlineRegistry: registry,
          outlineModel: {},
          outlineRevision: 'rev-1',
        });
        expect(context?.outline).toBeUndefined();
      } finally {
        console.warn = original;
      }
      expect(warned).toEqual([]);
    });

    it('disables outlines when no registry is passed (shell-owned, no singleton)', () => {
      const warned: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]): void => {
        warned.push(args);
      };
      try {
        // Even Markdown text stays empty without an explicit registry: the
        // builder holds no module singleton (funnel removal).
        const withoutRegistry = buildRightSidebarContext({
          reading: readingWithText('# Field notes\n\n## Habitat'),
          pdf: {} as never,
          openDocument: () => undefined,
          focusedPane: 'main',
          focusedState: paneState('doc-1'),
          focusedDocument: docView('doc-1', String(markdownKindId)),
          notify: () => undefined,
          outlineRevision: 'rev-1',
        });
        expect(withoutRegistry?.outline).toBeUndefined();
        const nulled = buildRightSidebarContext({
          reading: readingWithText('# Field notes\n\n## Habitat'),
          pdf: {} as never,
          openDocument: () => undefined,
          focusedPane: 'main',
          focusedState: paneState('doc-1'),
          focusedDocument: docView('doc-1', String(markdownKindId)),
          notify: () => undefined,
          outlineRegistry: null,
          outlineRevision: 'rev-1',
        });
        expect(nulled?.outline).toBeUndefined();
      } finally {
        console.warn = original;
      }
      expect(warned).toEqual([]);
    });
  });
});

describe('shell mount through WorkspaceView', () => {
  it('renders non-Markdown rows with an injected registry and invalidates on close', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    });
    const choice = makeChoice({ id: 'v-beta', name: 'Beta Vault' });
    const h = await createHarness([choice]);
    const betaModel = { pages: [{ id: 'page-a' }] };
    const betaRows = Object.freeze([
      Object.freeze({
        id: 'page-a',
        address: 'page-a',
        level: 1,
        label: 'Site A',
      }),
      Object.freeze({
        id: 'page-a:obj-1',
        address: 'page-a',
        level: 2,
        label: 'Canopy',
      }),
    ]) as readonly SidebarOutlineRowLike[];
    const invalidated: { kindId?: string; identity?: string }[] = [];
    const injected: SidebarOutlineRegistryLike = {
      getOutline(kindId) {
        if (String(kindId) !== 'test.beta') {
          const error = new Error(
            `unknown outline kind: ${String(kindId)}`,
          ) as Error & { code: string };
          error.code = 'UNKNOWN_OUTLINE_KIND';
          throw error;
        }
        return betaRows;
      },
      invalidate(kindId, documentIdentity) {
        invalidated.push({ kindId, identity: documentIdentity });
      },
    };
    const betaController = createFakeWorkbenchController({
      documents: [
        {
          documentId: 'doc-beta',
          kindId: 'test.beta',
          path: 'site.beta',
          text: '',
        },
      ],
    });
    Object.assign(betaController, {
      outlineRegistry: injected,
      getOutlineModel: (documentId: string) =>
        documentId === 'doc-beta'
          ? { model: betaModel, revision: 'rev-beta-1' }
          : null,
    } satisfies Partial<WorkbenchOutlineProviderLike> as Record<
      string,
      unknown
    >);
    const shellHost = document.createElement('div');
    document.body.appendChild(shellHost);
    const shellRoot = createRoot(shellHost);
    try {
      await act(async () => {
        shellRoot.render(
          createElement(WorkspaceView, {
            controller: betaController,
            ui: h.ui,
            choice,
            onClose: () => undefined,
          }),
        );
        await settle();
      });
      await until(
        () =>
          shellHost.querySelectorAll(`.${panelStyles['outline-entry']}`)
            .length === 2,
      );
      expect(
        [...shellHost.querySelectorAll(`.${panelStyles['outline-entry']}`)].map(
          (entry) => entry.textContent,
        ),
      ).toEqual(['Site A', 'Canopy']);
      expect(invalidated).toEqual([]);
      await act(async () => {
        shellRoot.unmount();
        await settle();
      });
      expect(invalidated).toEqual([
        { kindId: 'test.beta', identity: 'doc-beta' },
      ]);
    } finally {
      shellHost.remove();
      await h.dispose();
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth,
      });
    }
  });
});

describe('shell mount through WorkspaceView', () => {
  const families: readonly {
    readonly kindId: string;
    readonly documentId: string;
    readonly path: string;
    readonly model: unknown;
    readonly revision: string;
    readonly rows: readonly SidebarOutlineRowLike[];
  }[] = [
    {
      kindId: String(blockPageKindId),
      documentId: 'doc-block',
      path: 'site.blockpage',
      model: { formatVersion: 1, rootOrder: ['h1'], blocks: {} },
      revision: 'rev-block-3',
      rows: [{ id: 'h1', address: 'h1', level: 1, label: 'Overview' }],
    },
    {
      kindId: String(notebookKindId),
      documentId: 'doc-notebook',
      path: 'notes/field.notebook',
      model: { title: 'Field notes', pages: [{ id: 'page-a' }] },
      revision: 'rev-notebook-5',
      rows: [
        { id: 'page-a', address: 'page-a', level: 1, label: 'Site A' },
        { id: 'page-a:t1', address: 'page-a', level: 2, label: 'Canopy' },
      ],
    },
    {
      kindId: String(latexKindId),
      documentId: 'doc-latex',
      path: 'paper.tex',
      model: { raw: '\\section{Intro}\n\\subsection{Background}\n' },
      revision: 'rev-latex-8',
      rows: [
        { id: 'intro', address: 'intro', level: 1, label: 'Intro' },
        {
          id: 'background',
          address: 'background',
          level: 2,
          label: 'Background',
        },
      ],
    },
  ];

  it('shows blockpage/notebook/latex rows through the same generic shell path', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    });
    const choice = makeChoice({ id: 'v-t020', name: 'T020 Vault' });
    const h = await createHarness([choice]);
    try {
      for (const family of families) {
        const seen: {
          kindId: string;
          revision: string | number | undefined;
          identity: string | undefined;
          hasModel: boolean;
        }[] = [];
        const frozenRows = Object.freeze(
          family.rows.map((row) => Object.freeze({ ...row })),
        ) as readonly SidebarOutlineRowLike[];
        const injected: SidebarOutlineRegistryLike = {
          getOutline(kindId, model, revision, input) {
            seen.push({
              kindId: String(kindId),
              revision,
              identity: input?.documentIdentity,
              hasModel: model !== null && model !== undefined,
            });
            if (String(kindId) !== family.kindId) {
              const error = new Error(
                `unknown outline kind: ${String(kindId)}`,
              ) as Error & { code: string };
              error.code = 'UNKNOWN_OUTLINE_KIND';
              throw error;
            }
            return frozenRows;
          },
          invalidate() {
            // Slot hygiene is pinned by the shell test; here the
            // registry only needs to satisfy the structural port.
          },
        };
        const controller = createFakeWorkbenchController({
          documents: [
            {
              documentId: family.documentId,
              kindId: family.kindId,
              path: family.path,
              text: '',
            },
          ],
        });
        Object.assign(controller, {
          outlineRegistry: injected,
          getOutlineModel: (documentId: string) =>
            documentId === family.documentId
              ? { model: family.model, revision: family.revision }
              : null,
        } satisfies Partial<WorkbenchOutlineProviderLike> as Record<
          string,
          unknown
        >);
        const shellHost = document.createElement('div');
        document.body.appendChild(shellHost);
        const shellRoot = createRoot(shellHost);
        try {
          await act(async () => {
            shellRoot.render(
              createElement(WorkspaceView, {
                controller,
                ui: h.ui,
                choice,
                onClose: () => undefined,
              }),
            );
            await settle();
          });
          await until(
            () =>
              shellHost.querySelectorAll(`.${panelStyles['outline-entry']}`)
                .length === family.rows.length,
          );
          expect(
            [
              ...shellHost.querySelectorAll(`.${panelStyles['outline-entry']}`),
            ].map((entry) => entry.textContent),
          ).toEqual(family.rows.map((row) => row.label));
          // No per-kind UI fork: the kind id passes through verbatim with
          // the session revision scoped to the document identity.
          expect(seen[0]).toEqual({
            kindId: family.kindId,
            revision: family.revision,
            identity: family.documentId,
            hasModel: true,
          });
        } finally {
          await act(async () => {
            shellRoot.unmount();
            await settle();
          });
          shellHost.remove();
        }
      }
    } finally {
      await h.dispose();
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth,
      });
    }
  });
});

describe('text-derived revision scoping', () => {
  it('ignores shell revision bumps for text-derived outlines (stable content key hits)', () => {
    const registry = markdownRegistry();
    const base = {
      reading: readingWithText('# Field notes\n\n## Habitat'),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-1'),
      focusedDocument: docView('doc-1', String(markdownKindId)),
      notify: () => undefined,
      outlineRegistry: registry,
    } as const;
    // Same text with different shell counters (the older storm):
    // the builder must ignore the counter and hit the frozen rows.
    const first = buildRightSidebarContext({
      ...base,
      outlineRevision: 'rev-shell-1',
    });
    const second = buildRightSidebarContext({
      ...base,
      outlineRevision: 'rev-shell-2',
    });
    expect(first?.outline?.map((row) => row.label)).toEqual([
      'Field notes',
      'Habitat',
    ]);
    expect(second?.outline).toBe(first?.outline);
    // Content change still recomputes through the same generic path.
    const changed = buildRightSidebarContext({
      reading: readingWithText('# Changed\n'),
      pdf: {} as never,
      openDocument: () => undefined,
      focusedPane: 'main',
      focusedState: paneState('doc-1'),
      focusedDocument: docView('doc-1', String(markdownKindId)),
      notify: () => undefined,
      outlineRegistry: registry,
      outlineRevision: 'rev-shell-2',
    });
    expect(changed?.outline).not.toBe(first?.outline);
    expect(changed?.outline?.map((row) => row.label)).toEqual(['Changed']);
  });

  it('WorkspaceView omits the global shell revision for Markdown so background bumps hit', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    });
    const choice = makeChoice({ id: 'v-f016', name: 'F016 Vault' });
    const h = await createHarness([choice]);
    const controller = createFakeWorkbenchController({
      documents: [
        {
          documentId: 'doc-md',
          kindId: String(markdownKindId),
          path: 'notes/field.md',
          text: '# Field notes\n\n## Habitat',
        },
      ],
    });
    const inner = markdownRegistry();
    const seenRevisions: (string | number | undefined)[] = [];
    const returned: unknown[] = [];
    const spy: SidebarOutlineRegistryLike = {
      getOutline(kindId, model, revision, input) {
        seenRevisions.push(revision);
        const rows = inner.getOutline(kindId, model, revision, input);
        returned.push(rows);
        return rows;
      },
      invalidate(kindId, documentIdentity) {
        inner.invalidate(kindId, documentIdentity);
      },
    };
    Object.assign(controller, {
      outlineRegistry: spy,
    });
    const shellHost = document.createElement('div');
    document.body.appendChild(shellHost);
    const shellRoot = createRoot(shellHost);
    try {
      await act(async () => {
        shellRoot.render(
          createElement(WorkspaceView, {
            controller,
            ui: h.ui,
            choice,
            onClose: () => undefined,
          }),
        );
        await settle();
      });
      await until(
        () =>
          shellHost.querySelectorAll(`.${panelStyles['outline-entry']}`)
            .length === 2,
      );
      // Text-derived: the shell must not pass its global counter.
      expect(seenRevisions.length).toBeGreaterThan(0);
      for (const revision of seenRevisions) {
        expect(revision).toBeUndefined();
      }
      const firstRef = returned[returned.length - 1];
      // Background-document bump: any shell notify without a text change
      // re-resolves but must hit the same frozen rows.
      const callsBefore = seenRevisions.length;
      await act(async () => {
        controller.setPaneDirty('main', true);
        await settle();
      });
      await until(
        () =>
          shellHost.querySelectorAll(`.${panelStyles['outline-entry']}`)
            .length === 2,
      );
      expect(seenRevisions.length).toBeGreaterThan(callsBefore);
      for (const revision of seenRevisions.slice(callsBefore)) {
        expect(revision).toBeUndefined();
      }
      const lastRef = returned[returned.length - 1];
      expect(lastRef).toBe(firstRef);
    } finally {
      await act(async () => {
        shellRoot.unmount();
        await settle();
      });
      shellHost.remove();
      await h.dispose();
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth,
      });
    }
  });
});
