import type { DocumentPresentationMode } from '@froglight/foundation';
import { createServiceToken, definePlugin } from '@froglight/runtime';
import type { ComponentType } from 'react';
import type { DocumentInspectorSnapshot } from './document-inspector.js';

export interface RightSidebarContext {
  readonly pane: string;
  readonly documentId: string;
  readonly kindId: string;
  readonly title: string;
  readonly path: string;
  readonly mode: DocumentPresentationMode;
  /** Presentation choices declared by the focused document kind. */
  readonly availableModes: readonly DocumentPresentationMode[];
  readonly dirty: boolean;
  /** Canonical text projection when the document family exposes one. */
  readonly text: string | null;
  /**
   * Generic provider outline rows (tasks).
   *
   * Rows-only contract: the outline panel renders `outline` verbatim
   * through one provider-neutral path. When absent (or empty) the panel
   * stays empty while the Outline tab remains available for supported
   * document kinds. Rows arrive from the shell outline-registry wiring; only
   * `{ id, address, level, label }` crosses as plain data, never engine
   * or model refs.
   */
  readonly outline?: readonly RightSidebarOutlineEntry[] | null;
  /** An extractor exists for this kind; an empty outline still has a tab. */
  readonly outlineSupported?: boolean;
  /**
   * Content revision key for `outline`. The upstream revision-keyed cache
   * returns the same frozen row reference on a revision hit, so the panel
   * memoizes derived view data on the rows reference and never recomputes
   * per keystroke at a stable revision.
   */
  readonly outlineRevision?: string | number;
  /** Live provider controls projected into sidebar property sections. */
  readonly inspector?: DocumentInspectorSnapshot;
  executeInspectorControl?(id: string, value?: string): void;
  openDocument(documentId: string, address?: string): void;
  revealAddress(address: string): void;
  setMode(mode: DocumentPresentationMode): void;
  exportPdf(options: PdfExportOptions): void;
  exportNotebookPdf?(options: NotebookPdfExportOptions): void;
  exportPng?(): void;
}

/**
 * One generic outline row for the document sidebar.
 *
 * Mirrors the provider outline shape (`{ id, address, level, label }`) as
 * plain data so the sidebar stays provider-neutral: no editor-library
 * types and no per-kind branches. `id` is stable within one outline and
 * keys React rows across edits (never the revision); `address` is the
 * portable in-document address passed verbatim to `revealAddress`.
 */
export interface RightSidebarOutlineEntry {
  readonly id: string;
  readonly address: string;
  readonly level: number;
  readonly label: string;
}

export interface PdfExportOptions {
  readonly pageSize: 'a4' | 'letter';
  readonly margins: 'normal' | 'narrow';
  readonly includeTitle: boolean;
}

export interface NotebookPdfExportOptions {
  readonly mode: 'preserve' | 'flatten';
  readonly rasterDpi?: number;
}

/** Props received by a component-based sidebar panel. */
export interface RightSidebarPanelProps {
  readonly context: RightSidebarContext;
}

/** One effect-owned tab in the document-aware right sidebar. */
export interface RightSidebarPanelDef {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly order?: number;
  /** Panels sharing a group appear as sections of one sidebar tab. */
  readonly group?: {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly order: number;
  };
  readonly when?: (context: RightSidebarContext) => boolean;
  /**
   * React component mounted directly by the sidebar slot — the only
   * presentation shape. Trusted UI plugins take it from the UI
   * package React entrypoint.
   */
  readonly component: ComponentType<RightSidebarPanelProps>;
}

export interface RightSidebarRegistry {
  register(panel: RightSidebarPanelDef): { dispose(): void };
  list(context?: RightSidebarContext): readonly RightSidebarPanelDef[];
  get(id: string): RightSidebarPanelDef | undefined;
  onDidChange(listener: () => void): { dispose(): void };
}

export const rightSidebarRegistryToken =
  createServiceToken<RightSidebarRegistry>('froglight.right-sidebar-registry');

export function createRightSidebarRegistry(): {
  readonly registry: RightSidebarRegistry;
  dispose(): void;
} {
  const panels = new Map<string, RightSidebarPanelDef>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const ordered = (): RightSidebarPanelDef[] =>
    [...panels.values()].sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER) ||
        a.title.localeCompare(b.title),
    );

  const registry: RightSidebarRegistry = {
    register(panel) {
      const previous = panels.get(panel.id);
      panels.set(panel.id, panel);
      notify();
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (panels.get(panel.id) !== panel) return;
          if (previous === undefined) panels.delete(panel.id);
          else panels.set(panel.id, previous);
          notify();
        },
      };
    },
    list: (context) =>
      ordered().filter(
        (panel) => context === undefined || panel.when?.(context) !== false,
      ),
    get: (id) => panels.get(id),
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };

  return {
    registry,
    dispose() {
      panels.clear();
      listeners.clear();
    },
  };
}

export const rightSidebarRegistryPlugin = definePlugin({
  id: 'froglight.right-sidebar-registry',
  activate: (ctx) => {
    const created = createRightSidebarRegistry();
    ctx.provide(rightSidebarRegistryToken, created.registry);
    ctx.effect(() => created.dispose);
  },
});
