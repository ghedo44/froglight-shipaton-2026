import type { NotebookModel } from '../notebooks/model.js';
import type { NormalizedPdfPageGeometry } from './geometry.js';

export const PDF_LIMITS = {
  maxSourceBytes: 512 * 1024 * 1024,
  maxPages: 10_000,
  maxRenderDimension: 8_192,
  maxRenderArea: 32_000_000,
  maxTextCharactersPerPage: 2_000_000,
  maxTextItemsPerPage: 250_000,
  maxLinksPerPage: 50_000,
  maxOutlineNodes: 100_000,
  maxConcurrentPageTasks: 4,
} as const;

export interface PdfTextItem {
  readonly text: string;
  readonly bounds?: readonly { readonly x: number; readonly y: number }[];
}

export interface PdfPageText {
  readonly kind: 'source' | 'ocr';
  readonly items: readonly PdfTextItem[];
}

export interface PdfOutlineEntry {
  readonly id: string;
  readonly title: string;
  readonly pageIndex?: number;
  readonly children: readonly PdfOutlineEntry[];
}

export type PdfLink =
  | { readonly kind: 'external'; readonly url: string; readonly bounds?: readonly number[] }
  | { readonly kind: 'page'; readonly pageIndex: number; readonly bounds?: readonly number[] };

export interface PdfPageInfo {
  readonly pageIndex: number;
  readonly geometry: NormalizedPdfPageGeometry;
  /** Known after extraction; providers may omit it to keep geometry lookup lazy. */
  readonly hasSourceText?: boolean;
}

export interface PdfMountedPageHandle {
  readonly setSourceInteractionEnabled?: (enabled: boolean) => void;
  readonly destroy: () => void | Promise<void>;
}

export interface PdfPageMountRequest {
  readonly pageIndex: number;
  readonly parent: unknown;
  readonly scale: number;
  readonly signal?: AbortSignal;
  readonly sourceInteraction: boolean;
  /** Explicit application-owned navigation path; extraction never navigates. */
  readonly onLinkActivate?: (link: PdfLink) => void;
}

export interface PdfDocumentHandle {
  readonly pageCount: number;
  getPageInfo(pageIndex: number, signal?: AbortSignal): Promise<PdfPageInfo>;
  getPageText(pageIndex: number, signal?: AbortSignal): Promise<PdfPageText>;
  getOutline(signal?: AbortSignal): Promise<readonly PdfOutlineEntry[]>;
  getLinks(pageIndex: number, signal?: AbortSignal): Promise<readonly PdfLink[]>;
  mountPage?(request: PdfPageMountRequest): Promise<PdfMountedPageHandle>;
  close(): Promise<void>;
}

export interface PdfProvider {
  open(input: {
    readonly bytes: Uint8Array;
    readonly password?: string;
    readonly signal?: AbortSignal;
  }): Promise<PdfDocumentHandle>;
}

export type PdfExportWarningCode =
  | 'EXPORT_FEATURE_DROPPED'
  | 'EXPORT_TEXT_FALLBACK'
  | 'EXPORT_FLATTENED';

export interface PdfExportWarning {
  readonly code: PdfExportWarningCode;
  readonly pageId?: string;
  readonly detail?: string;
}

export interface PdfExportAssetResolver {
  read(path: string): Promise<Uint8Array>;
}

export interface PdfExportRequest {
  readonly notebook: NotebookModel;
  readonly mode: 'preserve' | 'flatten';
  readonly rasterDpi?: number;
  readonly assets: PdfExportAssetResolver;
  readonly renderFlattenedPage?: (
    pageId: string,
    dpi: number,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface PdfExportProvider {
  exportNotebook(request: PdfExportRequest): Promise<{
    readonly bytes: Uint8Array;
    readonly warnings: readonly PdfExportWarning[];
  }>;
}

export type PdfSourceInteractionMode = 'source-select' | 'surface-authoring' | 'pan';
