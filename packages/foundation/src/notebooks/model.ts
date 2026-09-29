/**
 * Canonical notebook model.
 *
 * Preservation-first: page records are kept verbatim so unknown members
 * round-trip byte-stably in place; the embedded surface payload rides the
 * shared surface codec, so its guarantees live in exactly one place.
 * Host- and editor-free.
 */

import {
  boundedFrame,
  emptySurface,
  type JsonRecord,
  type SurfaceModel,
} from '../surfaces/model.js';
import type { StoredAsset } from '../assets.js';
import type { NotebookPaperOptions } from './paper.js';

export const NOTEBOOK_FORMAT_VERSION = 1;

/** Product defaults for newly created pages (A4 proportions, ~150 dpi). */
export const NOTEBOOK_DEFAULT_PAGE_WIDTH = 1240;
export const NOTEBOOK_DEFAULT_PAGE_HEIGHT = 1754;

/** Page identifier: opaque non-empty string, unique per notebook (spec §3). */
export type NotebookPageId = string;

export interface NotebookPageBox {
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface TemplateNotebookPageBase {
  readonly kind: 'template';
  readonly template: string;
  /** Optional paper customization (slice 10, additive, current format). */
  readonly paper?: NotebookPaperOptions;
  readonly [key: string]: unknown;
}

export interface PdfNotebookPageBase {
  readonly kind: 'pdf-page';
  readonly asset: StoredAsset;
  readonly pageIndex: number;
  readonly pageBox: NotebookPageBox;
  readonly [key: string]: unknown;
}

export type NotebookPageBase = TemplateNotebookPageBase | PdfNotebookPageBase;

/**
 * One navigable page. `record` is the verbatim parsed page record (its key
 * order survives round trips); `surface` is the decoded embedded payload
 * and the single mutable editing view — the codec re-serializes it into
 * `record.surface` on encode (spec §4).
 */
export interface NotebookPage {
  readonly kind: 'page';
  readonly id: NotebookPageId;
  readonly record: JsonRecord;
  readonly surface: SurfaceModel;
}

/**
 * A page preserved verbatim because it cannot be presented safely
 * (unreadable payload, unsupported payload version, unbounded frame,
 * invalid label/template members — spec §4.1–§4.3). Canonical bytes are
 * never altered; consumers exclude these from navigation.
 */
export interface OpaqueNotebookPage {
  readonly kind: 'opaque';
  readonly id: NotebookPageId;
  /** The damaged page record exactly as parsed. */
  readonly raw: JsonRecord;
}

export type NotebookPageEntry = NotebookPage | OpaqueNotebookPage;

/** Notebook metadata record, kept verbatim (unknown fields byte-stable). */
export type NotebookMeta = JsonRecord;

/** Canonical notebook model. Plain/mutable so editor adapters update in place. */
export interface NotebookModel {
  formatVersion: typeof NOTEBOOK_FORMAT_VERSION;
  meta: NotebookMeta;
  pageOrder: NotebookPageId[];
  pages: Record<NotebookPageId, NotebookPageEntry>;
  /**
   * Unknown document-level members captured at decode (spec §3),
   * re-emitted after the known members on encode.
   */
  unknownFields?: Record<string, unknown>;
}

/** True when the entry is a navigable page with a decodable surface. */
export function isNavigablePage(
  entry: NotebookPageEntry | undefined,
): entry is NotebookPage {
  return entry !== undefined && entry.kind === 'page';
}

/** Navigable page ids in canonical order, excluding opaque entries. */
export function navigablePageIds(model: NotebookModel): NotebookPageId[] {
  return model.pageOrder.filter((id) => isNavigablePage(model.pages[id]));
}

/** Page label accessor (`undefined` when absent). */
export function labelOf(page: NotebookPage): string | undefined {
  const label = page.record.label;
  return typeof label === 'string' ? label : undefined;
}

/** Page template accessor (`undefined` meaning the blank default). */
export function baseOf(page: NotebookPage): NotebookPageBase {
  return page.record.base as unknown as NotebookPageBase;
}

/** Page template accessor (`undefined` for PDF-backed pages). */
export function templateOf(page: NotebookPage): string | undefined {
  const base = baseOf(page);
  return base.kind === 'template' ? base.template : undefined;
}

/** Paper options accessor (`undefined` means template defaults). */
export function paperOptionsOf(page: NotebookPage): NotebookPaperOptions | undefined {
  const base = baseOf(page);
  if (base.kind !== 'template') return undefined;
  const paper = (base as { paper?: unknown }).paper;
  if (paper === undefined) return undefined;
  if (typeof paper !== 'object' || paper === null || Array.isArray(paper)) {
    return undefined;
  }
  return paper as NotebookPaperOptions;
}

/** Set/replace paper options on a template page; no-op for PDF pages. */
export function setPaperOptions(
  page: NotebookPage,
  paper: NotebookPaperOptions | undefined,
): void {
  const current = baseOf(page);
  if (current.kind !== 'template') return;
  if (paper === undefined) {
    const next: Record<string, unknown> = { ...current };
    delete next.paper;
    page.record.base = next as unknown as typeof page.record.base;
    return;
  }
  page.record.base = {
    ...current,
    kind: 'template',
    template: current.template,
    paper: { ...paper },
  } as unknown as typeof page.record.base;
}

/** Set/clear the page label in the verbatim record. */
export function setPageLabel(page: NotebookPage, label: string | undefined): void {
  if (label === undefined) delete page.record.label;
  else page.record.label = label;
}

/** Set/clear the page template in the verbatim record. */
export function setPageTemplate(page: NotebookPage, template: string | undefined): void {
  const current = baseOf(page);
  page.record.base = {
    ...(current.kind === 'template' ? current : {}),
    kind: 'template',
    template: template ?? 'froglight.blank',
  };
}

/** Empty notebook with canonical meta shape (`title` optional). */
export function emptyNotebook(title?: string): NotebookModel {
  const meta: NotebookMeta = { tags: [], properties: {} };
  if (title !== undefined && title !== '') meta.title = title;
  return { formatVersion: NOTEBOOK_FORMAT_VERSION, meta, pageOrder: [], pages: {} };
}

export interface NotebookPageOptions {
  readonly label?: string;
  readonly template?: string;
  /** Paper customization for template pages (slice 10). */
  readonly paper?: NotebookPaperOptions;
  /** Defaults to a blank bounded A4-proportioned surface (product default). */
  readonly surface?: SurfaceModel;
}

/** Construct a fresh valid page record. */
export function notebookPage(
  id: NotebookPageId,
  options: NotebookPageOptions = {},
): NotebookPage {
  const surface =
    options.surface ??
    emptySurface(boundedFrame(NOTEBOOK_DEFAULT_PAGE_WIDTH, NOTEBOOK_DEFAULT_PAGE_HEIGHT));
  const { unknownFields, ...known } = surface as SurfaceModel &
    Record<string, unknown>;
  const payload = { ...known, ...(typeof unknownFields === 'object' && unknownFields !== null ? unknownFields : {}) };
  const record: JsonRecord = {
    id,
    ...(options.label !== undefined ? { label: options.label } : {}),
    base: {
      kind: 'template',
      template: options.template ?? 'froglight.blank',
      ...(options.paper !== undefined ? { paper: { ...options.paper } } : {}),
    },
    surface: payload as JsonRecord,
  };
  return { kind: 'page', id, record, surface };
}

export interface PdfNotebookPageOptions {
  readonly asset: StoredAsset;
  readonly pageIndex: number;
  readonly pageBox: NotebookPageBox;
  readonly label?: string;
  readonly surface?: SurfaceModel;
}

/** Construct a PDF-backed page whose canonical Surface frame uses PDF points. */
export function pdfNotebookPage(
  id: NotebookPageId,
  options: PdfNotebookPageOptions,
): NotebookPage {
  const surface =
    options.surface ??
    emptySurface(boundedFrame(options.pageBox.widthPt, options.pageBox.heightPt));
  const { unknownFields, ...known } = surface as SurfaceModel & Record<string, unknown>;
  const payload = {
    ...known,
    ...(typeof unknownFields === 'object' && unknownFields !== null ? unknownFields : {}),
  };
  const record: JsonRecord = {
    id,
    ...(options.label !== undefined ? { label: options.label } : {}),
    base: {
      kind: 'pdf-page',
      asset: { path: options.asset.path, sha256: options.asset.sha256 },
      pageIndex: options.pageIndex,
      pageBox: {
        widthPt: options.pageBox.widthPt,
        heightPt: options.pageBox.heightPt,
      },
    },
    surface: payload as JsonRecord,
  };
  return { kind: 'page', id, record, surface };
}

/** Append a freshly constructed page to the model's canonical order. */
export function appendPage(model: NotebookModel, page: NotebookPage): void {
  model.pages[page.id] = page;
  model.pageOrder.push(page.id);
}
