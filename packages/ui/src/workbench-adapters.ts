/**
 * Explicit composition-root adapters between the host-bearing
 * `WorkbenchController` and the UI document/host ports.
 *
 * The real controller exposes host-bearing signatures:
 * - `createAndOpen(path, editorParent?, opts?)`
 * - `openDocument(documentId, editorParent?, opts?)`
 *
 * The UI-facing `WorkbenchDocumentPort` exposes document-only signatures:
 * - `createAndOpen(path, opts?)`
 * - `openDocument(documentId, opts?)`
 *
 * Because the controller's second parameter is `unknown`, structural typing
 * does not detect the semantic mismatch: calling
 * `controller.createAndOpen(path, { kindId })` interprets `{ kindId }` as
 * `editorParent`, falling back to Markdown and storing the options object as
 * the pane editor host.
 *
 * These adapters are the ONLY supported bridge. Do not pass the raw
 * controller structurally as both `WorkbenchDocumentPort` and
 * `WorkbenchHostPort` when their call contracts differ.
 */

import type {
  WorkbenchDocumentPort,
  WorkbenchHostPort,
} from './workbench-ports.js';
import type { OpenLinkResultView } from './workbench-view.js';

/**
 * Minimal structural shape of the real controller's document surface.
 * Defined here (UI-owned) so `@froglight/ui` never imports
 * `@froglight/application`. Any object with these host-bearing methods
 * satisfies it structurally.
 */
export interface HostBearingDocumentSource {
  createAndOpen(
    path: string,
    editorParent?: unknown,
    opts?: { pane?: string; kindId?: string },
  ): Promise<unknown>;
  openDocument(
    documentId: string,
    editorParent?: unknown,
    opts?: { pane?: string; address?: string; preserveFocus?: boolean },
  ): Promise<void>;
  openLink(
    destination: string,
    opts?: { readonly pane?: string },
  ): Promise<OpenLinkResultView>;
  deleteDocument(documentId: string): Promise<void>;
  pruneMissingDocuments(): Promise<void>;
  saveActive(): Promise<{ committed: boolean; error: unknown } | null>;
  savePane(
    pane: string,
  ): Promise<{ committed: boolean; error: unknown } | null>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  onDidChange(listener: () => void): { dispose(): void };
}

/**
 * Adapt a host-bearing controller into a document-only port.
 *
 * - `documents.createAndOpen(path, opts)` =>
 *   `controller.createAndOpen(path, undefined, opts)`
 * - `documents.openDocument(documentId, opts)` =>
 *   `controller.openDocument(documentId, undefined, opts)`
 *
 * The `undefined` editor parent lets the controller default to the target
 * pane's own stored host, so background opens never mount into another
 * pane's DOM and the options object is never stored as an editor host.
 */
export function createWorkbenchDocumentPort(
  source: HostBearingDocumentSource,
): WorkbenchDocumentPort {
  return {
    onDidChange(listener: () => void) {
      return source.onDidChange(listener);
    },
    createAndOpen(
      path: string,
      opts?: { pane?: string; kindId?: string },
    ): Promise<unknown> {
      return source.createAndOpen(path, undefined, opts);
    },
    openDocument(
      documentId: string,
      opts?: { pane?: string; address?: string; preserveFocus?: boolean },
    ): Promise<void> {
      return source.openDocument(documentId, undefined, opts);
    },
    openLink(
      destination: string,
      opts?: { readonly pane?: string },
    ): Promise<OpenLinkResultView> {
      return source.openLink(destination, opts);
    },
    deleteDocument(documentId: string): Promise<void> {
      return source.deleteDocument(documentId);
    },
    pruneMissingDocuments(): Promise<void> {
      return source.pruneMissingDocuments();
    },
    saveActive(): Promise<{ committed: boolean; error: unknown } | null> {
      return source.saveActive();
    },
    savePane(
      pane: string,
    ): Promise<{ committed: boolean; error: unknown } | null> {
      return source.savePane(pane);
    },
    goBack(): Promise<boolean> {
      return source.goBack();
    },
    goForward(): Promise<boolean> {
      return source.goForward();
    },
  };
}

/**
 * The host port already carries host-bearing signatures, so the source can
 * serve it directly. This passthrough exists so composition roots name the
 * host capability explicitly instead of relying on accidental structural
 * compatibility.
 */
export function asWorkbenchHostPort(
  source: WorkbenchHostPort,
): WorkbenchHostPort {
  return source;
}
