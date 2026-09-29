// @vitest-environment jsdom
/**
 * Generic sidebar outline panel (outline-half).
 *
 * The panel renders ANY provider outline through one code path that consumes
 * only plain `{ id, address, level, label }` rows — no per-kind fork, no
 * editor-library types. Rows arrive through `RightSidebarContext.outline`
 * (populated from the outline registry by a follow-up wiring task);
 * the specs below drive the panel through a minimal fake revision-keyed
 * cache that mirrors the registry module contract (same revision returns
 * the same frozen rows, no extractor rerun), so the panel boundary proves:
 * generic rendering for two mock kinds, revision-key caching (no
 * per-keystroke recompute), live subscription updates without reload,
 * reveal delegation with graceful unknown addresses, frozen-row discipline,
 * and keyboard/screen-reader operability.
 */

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  blockPageKindId,
  latexKindId,
  markdownKindId,
  notebookKindId,
} from '@froglight/foundation';
import {
  rightSidebarRegistryPlugin,
  rightSidebarRegistryToken,
  type RightSidebarContext,
  type RightSidebarOutlineEntry,
  type RightSidebarRegistry,
} from '../right-sidebar-registry.js';
import { documentOutlinePlugin } from '../right-sidebar-panels.js';
import { OutlinePanel, resolveOutlineView } from './RightSidebarPanels.jsx';
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

function rerender(node: ReactElement): HTMLElement {
  if (root === null || host === null) throw new Error('no mounted panel');
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

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

/** Minimal revision-keyed cache mirroring the registry module contract.*/
interface FakeExtractor {
  readonly kindId: string;
  calls: number;
  extract(model: unknown): RightSidebarOutlineEntry[];
}

function createFakeOutlineCache(): {
  register(extractor: FakeExtractor): { dispose(): void };
  getOutline(
    kindId: string,
    model: unknown,
    revision: string | number,
    documentIdentity: string,
  ): readonly RightSidebarOutlineEntry[];
  invalidate(kindId?: string, documentIdentity?: string): void;
} {
  const extractors = new Map<string, FakeExtractor>();
  const slots = new Map<
    string,
    { key: string | number; rows: readonly RightSidebarOutlineEntry[] }
  >();
  const slotKey = (kindId: string, identity: string): string =>
    `${kindId}${identity}`;
  return {
    register(extractor) {
      if (extractors.has(extractor.kindId)) {
        throw new Error(`duplicate outline extractor: ${extractor.kindId}`);
      }
      extractors.set(extractor.kindId, extractor);
      let disposed = false;
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          if (extractors.get(extractor.kindId) === extractor) {
            extractors.delete(extractor.kindId);
          }
          const prefix = `${extractor.kindId}`;
          for (const key of [...slots.keys()]) {
            if (key.startsWith(prefix)) slots.delete(key);
          }
        },
      };
    },
    getOutline(kindId, model, revision, documentIdentity) {
      const extractor = extractors.get(kindId);
      if (extractor === undefined) {
        throw new Error(`unknown outline kind: ${kindId}`);
      }
      const key = slotKey(kindId, documentIdentity);
      const slot = slots.get(key);
      if (slot !== undefined && slot.key === revision) return slot.rows;
      extractor.calls += 1;
      const rows = Object.freeze(
        extractor.extract(model).map((row) => Object.freeze({ ...row })),
      );
      slots.set(key, { key: revision, rows });
      return rows;
    },
    invalidate(kindId, documentIdentity) {
      if (kindId === undefined && documentIdentity === undefined) {
        slots.clear();
        return;
      }
      if (kindId !== undefined && documentIdentity !== undefined) {
        slots.delete(slotKey(kindId, documentIdentity));
        return;
      }
      if (kindId !== undefined) {
        const prefix = `${kindId}`;
        for (const key of [...slots.keys()]) {
          if (key.startsWith(prefix)) slots.delete(key);
        }
        return;
      }
      const suffix = `${documentIdentity as string}`;
      for (const key of [...slots.keys()]) {
        if (key.endsWith(suffix)) slots.delete(key);
      }
    },
  };
}

type AlphaHeading = {
  readonly level: number;
  readonly text: string;
  readonly slug: string;
};
type BetaPage = {
  readonly id: string;
  readonly title: string;
  readonly objects: readonly { readonly id: string; readonly text: string }[];
};
type BetaModel = { readonly pages: readonly BetaPage[] };

function alphaExtractor(): FakeExtractor {
  return {
    kindId: 'test.alpha',
    calls: 0,
    extract: (model) =>
      (model as readonly AlphaHeading[]).map((heading) => ({
        id: heading.slug,
        address: heading.slug,
        level: heading.level,
        label: heading.text,
      })),
  };
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? text
  );
}

function betaExtractor(): FakeExtractor {
  return {
    kindId: 'test.beta',
    calls: 0,
    extract: (model) => {
      const rows: RightSidebarOutlineEntry[] = [];
      for (const page of (model as BetaModel).pages) {
        rows.push({
          id: page.id,
          address: page.id,
          level: 1,
          label: page.title,
        });
        for (const object of page.objects) {
          rows.push({
            id: `${page.id}:${object.id}`,
            address: page.id,
            level: 2,
            label: firstLine(object.text),
          });
        }
      }
      return rows;
    },
  };
}

const ALPHA_V1: readonly AlphaHeading[] = [
  { level: 1, text: 'Field notes', slug: 'field-notes' },
  { level: 2, text: 'Habitat', slug: 'habitat' },
  { level: 3, text: 'Shade', slug: 'shade' },
  { level: 2, text: 'Calls', slug: 'calls' },
];

const BETA_V1: BetaModel = {
  pages: [
    {
      id: 'page-a',
      title: 'Site A',
      objects: [
        { id: 'obj-1', text: 'Canopy\nsecond line' },
        { id: 'obj-2', text: 'Soil' },
      ],
    },
    { id: 'page-b', title: 'Site B', objects: [] },
  ],
};

function outlineContext(
  overrides: Partial<RightSidebarContext> = {},
): RightSidebarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId: 'test.alpha',
    title: 'notes.md',
    path: 'notes.md',
    mode: 'edit',
    availableModes: ['edit', 'reading'],
    dirty: false,
    text: null,
    openDocument: () => undefined,
    revealAddress: () => undefined,
    setMode: () => undefined,
    exportPdf: () => undefined,
    ...overrides,
  };
}

function rowButtons(container: HTMLElement): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      `.${panelStyles['outline-entry']}`,
    ),
  ];
}

async function captureRegistry(
  runtime: Runtime,
): Promise<RightSidebarRegistry> {
  let captured: RightSidebarRegistry | null = null;
  const probeId = `test.capture-outline-${Math.random().toString(36).slice(2)}`;
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

describe('generic outline panel', () => {
  describe('resolveOutlineView', () => {
    it('indents by level relative to the shallowest row', () => {
      const view = resolveOutlineView([
        { id: 'a', address: 'a', level: 2, label: 'A' },
        { id: 'b', address: 'b', level: 3, label: 'B' },
        { id: 'c', address: 'c', level: 2, label: 'C' },
      ]);
      expect(view.baseLevel).toBe(2);
      expect(view.rows.map((row) => row.depth)).toEqual([0, 1, 0]);
    });

    it('returns an empty view for no rows without throwing', () => {
      const view = resolveOutlineView([]);
      expect(view.baseLevel).toBe(1);
      expect(view.rows).toEqual([]);
    });
  });

  describe('provider-neutral rendering', () => {
    it('renders one mock heading kind in document order with level indentation', () => {
      const cache = createFakeOutlineCache();
      cache.register(alphaExtractor());
      const rows = cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1');
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({ outline: rows, outlineRevision: 'rev-1' }),
        }),
      );
      const tree = mounted.querySelector(`.${panelStyles['outline-tree']}`);
      expect(tree?.getAttribute('aria-label')).toBe('Document outline');
      const buttons = rowButtons(mounted);
      expect(buttons.map((entry) => entry.textContent)).toEqual([
        'Field notes',
        'Habitat',
        'Shade',
        'Calls',
      ]);
      expect(buttons.map((entry) => entry.dataset.level)).toEqual([
        '1',
        '2',
        '3',
        '2',
      ]);
      expect(
        buttons.map((entry) =>
          entry.style.getPropertyValue('--_outline-depth'),
        ),
      ).toEqual(['0', '1', '2', '1']);
      expect(buttons.map((entry) => entry.title)).toEqual([
        'Field notes',
        'Habitat',
        'Shade',
        'Calls',
      ]);
      for (const entry of buttons) expect(entry.type).toBe('button');
    });

    it('renders a second mock page/object kind through the same panel', async () => {
      const cache = createFakeOutlineCache();
      cache.register(betaExtractor());
      const revealed: string[] = [];
      const rows = cache.getOutline('test.beta', BETA_V1, 7, 'doc-9');
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            kindId: 'test.beta',
            documentId: 'doc-9',
            outline: rows,
            outlineRevision: 7,
            openDocument: () => undefined,
            revealAddress: (address) => revealed.push(address),
          }),
        }),
      );
      const buttons = rowButtons(mounted);
      expect(buttons.map((entry) => entry.textContent)).toEqual([
        'Site A',
        'Canopy',
        'Soil',
        'Site B',
      ]);
      expect(buttons.map((entry) => entry.dataset.level)).toEqual([
        '1',
        '2',
        '2',
        '1',
      ]);
      // Object rows delegate their page-scoped address, not their row id.
      await click(buttons.find((entry) => entry.textContent === 'Soil')!);
      expect(revealed).toEqual(['page-a']);
    });

    it('renders nothing for a defined-but-empty outline', () => {
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({ outline: [], outlineRevision: 'rev-1' }),
        }),
      );
      expect(mounted.textContent).toBe('');
      expect(
        mounted.querySelector(`.${panelStyles['outline-tree']}`),
      ).toBeNull();
    });
  });

  describe('revision-key caching', () => {
    it('reuses frozen rows at the same revision without rerunning extractors', () => {
      const cache = createFakeOutlineCache();
      const alpha = alphaExtractor();
      cache.register(alpha);
      const first = cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1');
      const second = cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1');
      expect(alpha.calls).toBe(1);
      expect(second).toBe(first);
      expect(Object.isFrozen(first)).toBe(true);
    });

    it('keeps panel DOM nodes stable when the same cached rows rerender', () => {
      const cache = createFakeOutlineCache();
      cache.register(alphaExtractor());
      const rows = cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1');
      const context = outlineContext({
        outline: rows,
        outlineRevision: 'rev-1',
      });
      const mounted = mount(createElement(OutlinePanel, { context }));
      const before = rowButtons(mounted);
      rerender(createElement(OutlinePanel, { context }));
      const after = rowButtons(mounted);
      expect(after.map((entry) => entry.textContent)).toEqual(
        before.map((entry) => entry.textContent),
      );
      for (const [index, entry] of after.entries()) {
        expect(entry).toBe(before[index]);
      }
    });

    it('recomputes only when the revision advances', () => {
      const cache = createFakeOutlineCache();
      const alpha = alphaExtractor();
      cache.register(alpha);
      const v1 = cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1');
      const edited: readonly AlphaHeading[] = [
        ...ALPHA_V1,
        { level: 2, text: 'Tracks', slug: 'tracks' },
      ];
      const v2 = cache.getOutline('test.alpha', edited, 'rev-2', 'doc-1');
      expect(alpha.calls).toBe(2);
      expect(v2).not.toBe(v1);
      expect(v2.map((row) => row.label)).toEqual([
        'Field notes',
        'Habitat',
        'Shade',
        'Calls',
        'Tracks',
      ]);
    });
  });

  describe('live updates and stable reveal', () => {
    it('updates rows in place without reload when the subscription pushes new rows', () => {
      const cache = createFakeOutlineCache();
      cache.register(alphaExtractor());
      const hostElement = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            outline: cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1'),
            outlineRevision: 'rev-1',
          }),
        }),
      );
      const edited: readonly AlphaHeading[] = [
        { level: 1, text: 'Field notes', slug: 'field-notes' },
        { level: 2, text: 'Habitat (surveyed)', slug: 'habitat' },
        { level: 3, text: 'Shade', slug: 'shade' },
        { level: 2, text: 'Calls', slug: 'calls' },
      ];
      rerender(
        createElement(OutlinePanel, {
          context: outlineContext({
            outline: cache.getOutline('test.alpha', edited, 'rev-2', 'doc-1'),
            outlineRevision: 'rev-2',
          }),
        }),
      );
      // Same host, same React root: a live update, not a reload.
      expect(hostElement.isConnected).toBe(true);
      expect(rowButtons(hostElement).map((entry) => entry.textContent)).toEqual(
        ['Field notes', 'Habitat (surveyed)', 'Shade', 'Calls'],
      );
    });

    it('keeps the revealed row reachable and focused across edits', async () => {
      const cache = createFakeOutlineCache();
      cache.register(alphaExtractor());
      const revealed: string[] = [];
      const contextFor = (
        rows: readonly RightSidebarOutlineEntry[],
        revision: string,
      ): RightSidebarContext =>
        outlineContext({
          outline: rows,
          outlineRevision: revision,
          openDocument: () => undefined,
          revealAddress: (address) => revealed.push(address),
        });
      const mounted = mount(
        createElement(OutlinePanel, {
          context: contextFor(
            cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1'),
            'rev-1',
          ),
        }),
      );
      const shade = rowButtons(mounted).find(
        (entry) => entry.textContent === 'Shade',
      )!;
      shade.focus();
      await click(shade);
      expect(revealed).toEqual(['shade']);
      const edited: readonly AlphaHeading[] = [
        { level: 1, text: 'Transect', slug: 'transect' },
        ...ALPHA_V1,
      ];
      rerender(
        createElement(OutlinePanel, {
          context: contextFor(
            cache.getOutline('test.alpha', edited, 'rev-2', 'doc-1'),
            'rev-2',
          ),
        }),
      );
      const retained = rowButtons(mounted).find(
        (entry) => entry.textContent === 'Shade',
      )!;
      // Stable id keys keep the same DOM node (and keyboard focus) in place.
      expect(retained).toBe(shade);
      expect(retained.isConnected).toBe(true);
      expect(document.activeElement).toBe(shade);
      await click(retained);
      expect(revealed).toEqual(['shade', 'shade']);
    });

    it('treats unknown addresses as a graceful delegated no-op', async () => {
      const revealed: string[] = [];
      const rows: readonly RightSidebarOutlineEntry[] = Object.freeze([
        Object.freeze({
          id: 'ghost',
          address: 'missing-page',
          level: 1,
          label: 'Ghost',
        }),
      ]);
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            outline: rows,
            outlineRevision: 'rev-1',
            // Unknown to the nav target: record and ignore, never throw.
            openDocument: () => undefined,
            revealAddress: (address) => {
              revealed.push(address);
            },
          }),
        }),
      );
      const ghost = rowButtons(mounted).find(
        (entry) => entry.textContent === 'Ghost',
      )!;
      await expect(click(ghost)).resolves.toBeUndefined();
      expect(revealed).toEqual(['missing-page']);
      expect(ghost.isConnected).toBe(true);
    });

    it('never mutates frozen provider rows', () => {
      const rows = Object.freeze([
        Object.freeze({ id: 'a', address: 'a', level: 1, label: 'A' }),
        Object.freeze({ id: 'b', address: 'b', level: 2, label: 'B' }),
      ]) as readonly RightSidebarOutlineEntry[];
      const snapshot = JSON.parse(JSON.stringify(rows)) as unknown;
      const context = outlineContext({ outline: rows, outlineRevision: 3 });
      mount(createElement(OutlinePanel, { context }));
      rerender(createElement(OutlinePanel, { context }));
      expect(rows).toEqual(snapshot);
      expect(Object.isFrozen(rows)).toBe(true);
      for (const row of rows) expect(Object.isFrozen(row)).toBe(true);
    });
  });

  describe('keyboard and screen-reader operability', () => {
    it('exposes a labelled nav of focusable native buttons', () => {
      const cache = createFakeOutlineCache();
      cache.register(alphaExtractor());
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            outline: cache.getOutline('test.alpha', ALPHA_V1, 'rev-1', 'doc-1'),
            outlineRevision: 'rev-1',
          }),
        }),
      );
      const tree = mounted.querySelector('nav');
      expect(tree?.getAttribute('aria-label')).toBe('Document outline');
      const buttons = rowButtons(mounted);
      expect(buttons.length).toBeGreaterThan(0);
      for (const entry of buttons) {
        expect(entry.tagName).toBe('BUTTON');
        expect(entry.type).toBe('button');
        expect(entry.disabled).toBe(false);
        // Natively tabbable in document order: no positive tabindex anywhere.
        expect(entry.tabIndex).toBeLessThanOrEqual(0);
      }
      buttons[0]!.focus();
      expect(document.activeElement).toBe(buttons[0]);
      buttons[2]!.focus();
      expect(document.activeElement).toBe(buttons[2]);
    });
  });

  describe('no legacy markdown fallback', () => {
    it('renders no content when no provider outline is present', () => {
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            kindId: String(markdownKindId),
            text: '# Field notes\n\n## Habitat',
          }),
        }),
      );
      // Text alone never populates the panel: rows come only from
      // `context.outline` via the registry wiring.
      expect(rowButtons(mounted)).toEqual([]);
      expect(mounted.textContent).toBe('');
    });

    it('renders no content when text has no headings', () => {
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            kindId: String(markdownKindId),
            text: 'plain body',
          }),
        }),
      );
      expect(mounted.textContent).toBe('');
    });

    it('warns in dev for duplicate ids without breaking rendering', () => {
      const warned: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]): void => {
        warned.push(args);
      };
      try {
        const mounted = mount(
          createElement(OutlinePanel, {
            context: outlineContext({
              outline: [
                { id: 'dup', address: 'a', level: 1, label: 'First' },
                { id: 'dup', address: 'b', level: 1, label: 'Second' },
              ],
              outlineRevision: 'rev-dup',
            }),
          }),
        );
        expect(rowButtons(mounted).map((entry) => entry.textContent)).toEqual([
          'First',
          'Second',
        ]);
      } finally {
        console.warn = original;
      }
      expect(warned.some((args) => String(args[0]).includes('duplicate'))).toBe(
        true,
      );
    });

    it('renders both duplicate-id rows with distinct addresses (warn-and-render-both lock-in)', async () => {
      const warned: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]): void => {
        warned.push(args);
      };
      const revealed: string[] = [];
      try {
        const mounted = mount(
          createElement(OutlinePanel, {
            context: outlineContext({
              outline: [
                { id: 'dup', address: 'a', level: 1, label: 'First' },
                { id: 'dup', address: 'b', level: 1, label: 'Second' },
              ],
              outlineRevision: 'rev-dup-lockin',
              openDocument: () => undefined,
              revealAddress: (address) => revealed.push(address),
            }),
          }),
        );
        // Both rows render (no first-wins dedupe): the provider bug stays
        // visible and each row keeps its own portable address.
        const buttons = rowButtons(mounted);
        expect(buttons.map((entry) => entry.textContent)).toEqual([
          'First',
          'Second',
        ]);
        expect(buttons).toHaveLength(2);
        await click(buttons[0]!);
        await click(buttons[1]!);
        expect(revealed).toEqual(['a', 'b']);
      } finally {
        console.warn = original;
      }
      expect(
        warned.some(
          (args) =>
            String(args[0]).includes('duplicate') &&
            String(args[0]).includes('dup'),
        ),
      ).toBe(true);
    });
  });

  describe('duplicate-id key stability', () => {
    it('keeps duplicate-id rows correctly delegated across reorder/update with no duplicate-key error', async () => {
      const warned: unknown[][] = [];
      const errored: unknown[][] = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      console.warn = (...args: unknown[]): void => {
        warned.push(args);
      };
      console.error = (...args: unknown[]): void => {
        errored.push(args);
      };
      const revealed: string[] = [];
      try {
        const contextFor = (
          outline: readonly RightSidebarOutlineEntry[],
          outlineRevision: string,
        ): RightSidebarContext =>
          outlineContext({
            outline,
            outlineRevision,
            openDocument: () => undefined,
            revealAddress: (address) => revealed.push(address),
          });
        const v1: readonly RightSidebarOutlineEntry[] = Object.freeze([
          Object.freeze({ id: 'dup', address: 'a', level: 1, label: 'First' }),
          Object.freeze({ id: 'dup', address: 'b', level: 1, label: 'Second' }),
        ]);
        const mounted = mount(
          createElement(OutlinePanel, { context: contextFor(v1, 'rev-dup-1') }),
        );
        expect(rowButtons(mounted).map((entry) => entry.textContent)).toEqual([
          'First',
          'Second',
        ]);
        // Reorder + relabel: the second provider row moves first with an
        // edited label; delegation must follow the row address, not position.
        const v2: readonly RightSidebarOutlineEntry[] = Object.freeze([
          Object.freeze({
            id: 'dup',
            address: 'b',
            level: 1,
            label: 'Second (edited)',
          }),
          Object.freeze({ id: 'dup', address: 'a', level: 1, label: 'First' }),
        ]);
        rerender(
          createElement(OutlinePanel, { context: contextFor(v2, 'rev-dup-2') }),
        );
        const reordered = rowButtons(mounted);
        expect(reordered.map((entry) => entry.textContent)).toEqual([
          'Second (edited)',
          'First',
        ]);
        await click(reordered[0]!);
        await click(reordered[1]!);
        expect(revealed).toEqual(['b', 'a']);
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
      }
      // Dev duplicate-id warn stays visible (provider bug signal).
      expect(warned.some((args) => String(args[0]).includes('duplicate'))).toBe(
        true,
      );
      // React duplicate-key reconciliation error must never fire: colliding
      // ids are qualified (unique-id fast path keeps `entry.id` as key).
      const duplicateKeyErrors = errored.filter((args) =>
        String(args[0]).includes('same key'),
      );
      expect(duplicateKeyErrors).toEqual([]);
    });

    it('keeps unique ids keyed by entry.id for DOM stability', () => {
      const view = resolveOutlineView([
        { id: 'a', address: 'a', level: 1, label: 'A' },
        { id: 'b', address: 'b', level: 1, label: 'B' },
      ]);
      expect(view.rows.map((row) => row.key)).toEqual(['a', 'b']);
    });

    it('qualifies colliding ids so row keys stay unique', () => {
      const view = resolveOutlineView([
        { id: 'dup', address: 'a', level: 1, label: 'First' },
        { id: 'dup', address: 'b', level: 1, label: 'Second' },
      ]);
      const keys = view.rows.map((row) => row.key);
      expect(new Set(keys).size).toBe(2);
      expect(keys[0]).not.toBe(keys[1]);
    });
  });

  describe('effect-owned generic registration', () => {
    it('shows for a supported kind even with no rows', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      const registry = await captureRegistry(runtime);
      const betaRows: readonly RightSidebarOutlineEntry[] = [
        { id: 'page-a', address: 'page-a', level: 1, label: 'Site A' },
      ];
      expect(
        registry
          .list(outlineContext({ kindId: 'test.beta', outline: betaRows }))
          .map((panel) => panel.id),
      ).toEqual(['outline']);
      // Unsupported kinds without rows stay hidden.
      expect(
        registry
          .list(outlineContext({ kindId: 'test.beta' }))
          .map((panel) => panel.id),
      ).toEqual([]);
      // A known kind remains visible while its model is unavailable.
      expect(
        registry
          .list(
            outlineContext({
              kindId: String(markdownKindId),
              outlineSupported: true,
              text: '# Field notes',
            }),
          )
          .map((panel) => panel.id),
      ).toEqual(['outline']);
      await runtime.dispose();
    });

    it('keeps the tab for empty or absent outlines in supported families', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      const registry = await captureRegistry(runtime);
      for (const kindId of [
        blockPageKindId,
        notebookKindId,
        markdownKindId,
        latexKindId,
      ]) {
        const id = String(kindId);
        expect(
          registry
            .list(outlineContext({ kindId: id, outline: [] }))
            .map((panel) => panel.id),
          `empty outline keeps the tab for ${id}`,
        ).toEqual(['outline']);
        expect(
          registry
            .list(outlineContext({ kindId: id, outlineSupported: true }))
            .map((panel) => panel.id),
          `absent outline keeps the tab for ${id}`,
        ).toEqual(['outline']);
        expect(
          registry
            .list(
              outlineContext({
                kindId: id,
                outline: [{ id: 'a', address: 'a', level: 1, label: 'A' }],
              }),
            )
            .map((panel) => panel.id),
          `one row shows the tab for ${id}`,
        ).toEqual(['outline']);
      }
      // No-headings documents retain the supported tab.
      for (const kindId of [String(blockPageKindId), String(notebookKindId)]) {
        expect(
          registry
            .list(
              outlineContext({ kindId, outline: [], outlineRevision: 'rev-1' }),
            )
            .map((panel) => panel.id),
          `no-headings outline keeps the tab for ${kindId}`,
        ).toEqual(['outline']);
      }
      await runtime.dispose();
    });

    it('cleans up on deactivate and restores on reactivate', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      const registry = await captureRegistry(runtime);
      const beta = outlineContext({
        kindId: 'test.beta',
        outline: [{ id: 'p', address: 'p', level: 1, label: 'P' }],
      });
      expect(registry.list(beta).map((panel) => panel.id)).toEqual(['outline']);
      await runtime.removeSlot('outline');
      expect(registry.list(beta)).toEqual([]);
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      expect(registry.list(beta).map((panel) => panel.id)).toEqual(['outline']);
      await runtime.dispose();
    });
  });
});
