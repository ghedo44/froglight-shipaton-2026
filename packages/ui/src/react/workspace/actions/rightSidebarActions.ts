/**
 * Portable actions behind the document sidebar context.
 *
 * Three separated concerns, each delegating outward without DOM traversal:
 *
 * - `revealDocumentAddress` routes to the active presentation through the
 *   workbench controller (which prefers the reader while reading);
 * - `requestMarkdownPrint` builds the derived print projection through an
 *   injected printer (canonical bytes are never touched);
 * - `requestNotebookExport` asks the controller for notebook-PDF
 *   bytes, and `downloadExportedFile` hands those bytes to the browser
 *   download adapter.
 */

import type {
  NotebookPdfExportOptions,
  PdfExportOptions,
} from '../../../right-sidebar-registry.js';

export interface AddressRevealer {
  readonly revealAddress: (pane: string, address: string) => boolean;
}

/** Reveal a portable in-document address; no shell DOM traversal involved. */
export function revealDocumentAddress(
  controller: AddressRevealer,
  pane: string,
  address: string,
): void {
  controller.revealAddress(pane, address);
}

export type MarkdownPrintOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unavailable' | string };

/**
 * Create the Markdown print projection. `unavailable` means the focused
 * document exposes no text projection; any other failure carries its message.
 */
export function requestMarkdownPrint(input: {
  readonly title: string;
  readonly markdown: string | null | undefined;
  readonly options: PdfExportOptions;
  readonly print: (projection: {
    readonly title: string;
    readonly markdown: string;
    readonly options: PdfExportOptions;
  }) => void;
}): MarkdownPrintOutcome {
  const { title, markdown, options, print } = input;
  if (markdown === null || markdown === undefined) {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    print({ title, markdown, options });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

export interface NotebookExportResult {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly warnings: readonly unknown[];
}

export type NotebookExportOutcome =
  | { readonly ok: true; readonly result: NotebookExportResult }
  | { readonly ok: false; readonly reason: 'unavailable' | string };

/** Ask the controller for notebook-PDF bytes for the focused pane. */
export async function requestNotebookExport(input: {
  readonly exportPdf?: (
    options: NotebookPdfExportOptions,
    pane?: string,
  ) => Promise<NotebookExportResult>;
  readonly pane: string;
  readonly options: NotebookPdfExportOptions;
}): Promise<NotebookExportOutcome> {
  const { exportPdf, pane, options } = input;
  if (exportPdf === undefined) return { ok: false, reason: 'unavailable' };
  try {
    return { ok: true, result: await exportPdf(options, pane) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface DownloadEnv {
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly clickAnchor: (url: string, filename: string) => void;
  readonly schedule: (task: () => void, ms: number) => void;
}

function browserDownloadEnv(): DownloadEnv {
  return {
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    clickAnchor: (url, filename) => {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
    },
    schedule: (task, ms) => {
      setTimeout(task, ms);
    },
  };
}

/** Hand exported bytes to the browser as a file download. */
export function downloadExportedFile(
  input: { readonly bytes: Uint8Array; readonly filename: string },
  env: DownloadEnv = browserDownloadEnv(),
): void {
  const url = env.createObjectUrl(
    new Blob([input.bytes as BlobPart], { type: 'application/pdf' }),
  );
  env.clickAnchor(url, input.filename);
  env.schedule(() => env.revokeObjectUrl(url), 1000);
}
