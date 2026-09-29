import { validateSurfaceForWrite } from '../surfaces/codec.js';
/**
 * Notebook codec.
 * Engine-free: no editor, renderer, DOM, or host types.
 *
 * Preservation-first: page records are kept verbatim so unknown members
 * round-trip byte-stably in place; per-page damage degrades that page to an
 * opaque-with-warning entry while the notebook still opens. Embedded
 * surface payloads are validated by the shared surface codec, so format
 * guarantees live in exactly one place (spec §4).
 */

import { FroglightError } from '../errors.js';
import {
  parseJsonAsync,
  utf8Decode,
  utf8Encode,
  utf8EncodeJsonAsync,
} from '../encoding.js';
import {
  frameBounds,
  type JsonRecord,
  type SurfaceModel,
} from '../surfaces/model.js';
import {
  decodeSurfacePayloadValue,
  decodeSurfacePayloadValueAsync,
  SURFACE_FORMAT_VERSION,
  type DecodeSurfacePayloadResult,
} from '../surfaces/codec.js';
import {
  NOTEBOOK_FORMAT_VERSION,
  type NotebookModel,
  type NotebookPageEntry,
  type NotebookPageId,
} from './model.js';
import { isValidPaperOptions } from './paper.js';
import { isWorkspacePath } from '../paths.js';

export { NOTEBOOK_FORMAT_VERSION };

/** Security limits per spec §7. */
export const NOTEBOOK_LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxPages: 1_000,
  maxLabelLength: 100_000,
} as const;

/** Machine-readable recovery annotations (spec §4.3); never free text. */
export type NotebookWarningCode =
  | 'MALFORMED_PAGE_DROPPED'
  | 'INVALID_PAGE_OPAQUE'
  | 'PAGE_SURFACE_UNBOUNDED'
  | 'DUPLICATE_PAGE_REFERENCE'
  | 'DANGLING_PAGE_REFERENCE'
  | 'PAGE_MISSING_FROM_ORDER'
  | 'UNKNOWN_PAGE_BASE'
  | 'INVALID_PAGE_BASE'
  | 'PAGE_BASE_FRAME_MISMATCH';

export interface NotebookWarning {
  readonly code: NotebookWarningCode;
  /** The damaged or repaired page, when applicable. */
  readonly pageId?: NotebookPageId;
}

export interface DecodeNotebookResult {
  readonly model: NotebookModel;
  /** Partial-recovery notes (spec §4.3); empty for clean decodes. */
  readonly warnings: readonly NotebookWarning[];
  /**
   * Per-page decode-time Ink bounds seeds (`pageId → seedBounds`, same
   * contract as the surface codec): disposable, never canonical. Opaque
   * pages have no entry.
   */
  readonly seedBoundsByPage: ReadonlyMap<
    NotebookPageId,
    DecodeSurfacePayloadResult['seedBounds']
  >;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function corrupt(message: string): FroglightError {
  return new FroglightError('RECORD_CORRUPT', `notebook: ${message}`);
}

function limit(message: string): FroglightError {
  return new FroglightError('FORMAT_LIMIT_EXCEEDED', `notebook: ${message}`);
}

/**
 * Validate one embedded payload through the shared surface codec.
 * Returns the decoded model plus its decode-time bounds seeds, or `null`
 * with a machine-readable reason when the page must be preserved verbatim
 * as opaque; hard security limits always propagate (spec §4.2/§7).
 */
function decodeEmbeddedSurface(value: unknown): {
  model: SurfaceModel;
  seedBounds: DecodeSurfacePayloadResult['seedBounds'];
} | null {
  if (!isPlainObject(value)) return null;
  try {
    const decoded = decodeSurfacePayloadValue(value);
    return { model: decoded.model, seedBounds: decoded.seedBounds };
  } catch (error) {
    if (error instanceof FroglightError && error.code === 'RECORD_CORRUPT')
      return null;
    // A future payload version is unreadable here but must never be dropped
    // or misparsed — preserve the page verbatim (spec §4.2).
    if (
      error instanceof FroglightError &&
      error.code === 'UNKNOWN_FORMAT_VERSION'
    ) {
      return null;
    }
    throw error;
  }
}

async function decodeEmbeddedSurfaceAsync(
  value: unknown,
  isCurrent: () => boolean,
): Promise<{
  model: SurfaceModel;
  seedBounds: DecodeSurfacePayloadResult['seedBounds'];
} | null> {
  if (!isPlainObject(value)) return null;
  try {
    const decoded = await decodeSurfacePayloadValueAsync(value, isCurrent);
    if (decoded === null || !isCurrent()) return null;
    return { model: decoded.model, seedBounds: decoded.seedBounds };
  } catch (error) {
    if (error instanceof FroglightError && error.code === 'RECORD_CORRUPT')
      return null;
    if (
      error instanceof FroglightError &&
      error.code === 'UNKNOWN_FORMAT_VERSION'
    )
      return null;
    throw error;
  }
}

type BaseValidation =
  | {
      readonly valid: true;
      readonly pageBox?: {
        readonly widthPt: number;
        readonly heightPt: number;
      };
    }
  | {
      readonly valid: false;
      readonly code: 'UNKNOWN_PAGE_BASE' | 'INVALID_PAGE_BASE';
    };

function validateBase(value: unknown): BaseValidation {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    return { valid: false, code: 'INVALID_PAGE_BASE' };
  }
  if (value.kind === 'template') {
    if (typeof value.template !== 'string' || value.template === '') {
      return { valid: false, code: 'INVALID_PAGE_BASE' };
    }
    // Slice 10 paper options are additive: absent means template defaults;
    // present must be a valid record, otherwise the page degrades to
    // opaque-with-warning (never a silent reinterpretation).
    if (value.paper !== undefined && !isValidPaperOptions(value.paper)) {
      return { valid: false, code: 'INVALID_PAGE_BASE' };
    }
    return { valid: true };
  }
  if (value.kind !== 'pdf-page')
    return { valid: false, code: 'UNKNOWN_PAGE_BASE' };
  const asset = value.asset;
  const pageBox = value.pageBox;
  if (
    !isPlainObject(asset) ||
    typeof asset.path !== 'string' ||
    !isWorkspacePath(asset.path) ||
    typeof asset.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(asset.sha256) ||
    !Number.isInteger(value.pageIndex) ||
    (value.pageIndex as number) < 0 ||
    !isPlainObject(pageBox) ||
    typeof pageBox.widthPt !== 'number' ||
    !Number.isFinite(pageBox.widthPt) ||
    pageBox.widthPt <= 0 ||
    typeof pageBox.heightPt !== 'number' ||
    !Number.isFinite(pageBox.heightPt) ||
    pageBox.heightPt <= 0
  ) {
    return { valid: false, code: 'INVALID_PAGE_BASE' };
  }
  return {
    valid: true,
    pageBox: { widthPt: pageBox.widthPt, heightPt: pageBox.heightPt },
  };
}

/**
 * Rebuild a valid page's record for encoding: verbatim key order, with the
 * current surface model re-serialized in place at its original position
 * (spec §4/§6).
 */
function pageRecordJson(
  page: Extract<NotebookPageEntry, { kind: 'page' }>,
): JsonRecord {
  const surface = surfacePayloadRecord(page.surface);
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(page.record)) {
    out[key] = key === 'surface' ? surface : value;
  }
  if (!('surface' in out)) out.surface = surface;
  return out;
}

/** Embedded Surface models are already JSON records; avoid a stringify/parse round trip. */
function surfacePayloadRecord(model: SurfaceModel): JsonRecord {
  const { unknownFields, ...known } = model as SurfaceModel &
    Record<string, unknown>;
  known.formatVersion = SURFACE_FORMAT_VERSION;
  return (
    unknownFields && typeof unknownFields === 'object'
      ? { ...known, ...unknownFields }
      : known
  ) as JsonRecord;
}

function assertWritableLimits(model: NotebookModel): void {
  for (const page of Object.values(model.pages))
    if (page.kind === 'page') validateSurfaceForWrite(page.surface);
  const pageCount = Object.keys(model.pages).length;
  if (pageCount > NOTEBOOK_LIMITS.maxPages) {
    throw limit(
      `document exceeds max page count (${NOTEBOOK_LIMITS.maxPages})`,
    );
  }
  for (const [id, entry] of Object.entries(model.pages)) {
    const record = entry.kind === 'opaque' ? entry.raw : entry.record;
    if (
      typeof record.label === 'string' &&
      record.label.length > NOTEBOOK_LIMITS.maxLabelLength
    ) {
      throw limit(`page "${id}" exceeds max label length`);
    }
  }
}

/** Decode canonical notebook bytes into a model plus warnings (spec §3–§4). */
export function decodeNotebook(data: Uint8Array): DecodeNotebookResult {
  if (data.byteLength > NOTEBOOK_LIMITS.maxFileBytes) {
    throw limit('document exceeds max file size');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(data));
  } catch {
    throw corrupt('not valid JSON');
  }
  return decodeNotebookValue(parsed);
}

export async function decodeNotebookAsync(
  data: Uint8Array,
  isCurrent: () => boolean,
): Promise<DecodeNotebookResult | null> {
  if (data.byteLength > NOTEBOOK_LIMITS.maxFileBytes) {
    throw limit('document exceeds max file size');
  }
  let parsed: unknown | null;
  try {
    parsed = await parseJsonAsync(data, isCurrent);
  } catch {
    if (!isCurrent()) return null;
    throw corrupt('not valid JSON');
  }
  if (parsed === null && !isCurrent()) return null;
  const decoder = decodeNotebookSteps(parsed);
  let step = decoder.next();
  while (!step.done) {
    const embedded = await decodeEmbeddedSurfaceAsync(step.value, isCurrent);
    if (!isCurrent()) return null;
    step = decoder.next(embedded);
  }
  return step.value;
}

function decodeNotebookValue(parsed: unknown): DecodeNotebookResult {
  const decoder = decodeNotebookSteps(parsed);
  let step = decoder.next();
  while (!step.done) step = decoder.next(decodeEmbeddedSurface(step.value));
  return step.value;
}

function* decodeNotebookSteps(
  parsed: unknown,
): Generator<
  unknown,
  DecodeNotebookResult,
  ReturnType<typeof decodeEmbeddedSurface>
> {
  if (!isPlainObject(parsed)) throw corrupt('document is not a JSON object');

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== 'number') throw corrupt('missing formatVersion');
  if (
    !Number.isInteger(formatVersion) ||
    formatVersion !== NOTEBOOK_FORMAT_VERSION
  ) {
    // Unknown versions (newer, zero, negative, fractional) are rejected,
    // never best-effort parsed (spec §2).
    throw new FroglightError(
      'UNKNOWN_FORMAT_VERSION',
      `notebook formatVersion ${String(formatVersion)} is not supported (v${NOTEBOOK_FORMAT_VERSION})`,
    );
  }

  const rawMeta = parsed.meta ?? {};
  if (!isPlainObject(rawMeta)) throw corrupt('meta must be an object');

  const rawPageOrder = parsed.pageOrder;
  if (
    !Array.isArray(rawPageOrder) ||
    rawPageOrder.some((id) => typeof id !== 'string')
  ) {
    throw corrupt('pageOrder must be an array of page ids');
  }
  const rawPages = parsed.pages;
  if (!isPlainObject(rawPages)) throw corrupt('pages must be an object');
  if (Object.keys(rawPages).length > NOTEBOOK_LIMITS.maxPages) {
    throw limit(
      `document exceeds max page count (${NOTEBOOK_LIMITS.maxPages})`,
    );
  }

  // Records are consumed as-is; structural damage recovers per page with a
  // warning while security limits stay hard errors (spec §4/§7).
  const warnings: NotebookWarning[] = [];
  const pages: Record<NotebookPageId, NotebookPageEntry> = {};
  const seedBoundsByPage = new Map<
    NotebookPageId,
    DecodeSurfacePayloadResult['seedBounds']
  >();
  for (const [key, value] of Object.entries(rawPages)) {
    if (
      !isPlainObject(value) ||
      typeof value.id !== 'string' ||
      value.id === '' ||
      value.id !== key
    ) {
      warnings.push({ code: 'MALFORMED_PAGE_DROPPED', pageId: key });
      continue;
    }
    const record = value as JsonRecord;

    let structurallyValid = true;
    if (record.label !== undefined && typeof record.label !== 'string') {
      structurallyValid = false;
    } else if (
      typeof record.label === 'string' &&
      record.label.length > NOTEBOOK_LIMITS.maxLabelLength
    ) {
      throw limit(`page "${key}" exceeds max label length`);
    }
    const baseValidation = validateBase(record.base);
    if (!baseValidation.valid) {
      warnings.push({ code: baseValidation.code, pageId: key });
      pages[key] = { kind: 'opaque', id: key, raw: record };
      continue;
    }

    const embedded: {
      model: SurfaceModel;
      seedBounds: DecodeSurfacePayloadResult['seedBounds'];
    } | null = structurallyValid ? yield record.surface : null;
    const surface: SurfaceModel | null =
      embedded === null ? null : embedded.model;
    if (surface !== null && frameBounds(surface.frame) === null) {
      // The notebook contract requires bounded pages (spec §4.1).
      warnings.push({ code: 'PAGE_SURFACE_UNBOUNDED', pageId: key });
      pages[key] = { kind: 'opaque', id: key, raw: record };
      continue;
    }
    if (surface !== null && baseValidation.pageBox !== undefined) {
      const bounds = frameBounds(surface.frame);
      if (
        bounds === null ||
        Math.abs(bounds.width - baseValidation.pageBox.widthPt) > 1e-6 ||
        Math.abs(bounds.height - baseValidation.pageBox.heightPt) > 1e-6
      ) {
        warnings.push({ code: 'PAGE_BASE_FRAME_MISMATCH', pageId: key });
        pages[key] = { kind: 'opaque', id: key, raw: record };
        continue;
      }
    }
    if (surface === null) {
      // Unreadable payload, unsupported payload version, or invalid
      // label/template members — preserve verbatim (spec §4.2/§4.3).
      warnings.push({ code: 'INVALID_PAGE_OPAQUE', pageId: key });
      pages[key] = { kind: 'opaque', id: key, raw: record };
      continue;
    }
    if (embedded !== null) seedBoundsByPage.set(key, embedded.seedBounds);
    pages[key] = { kind: 'page', id: key, record, surface };
  }

  const seen = new Set<string>();
  const pageOrder: string[] = [];
  for (const id of rawPageOrder as string[]) {
    if (seen.has(id)) {
      warnings.push({ code: 'DUPLICATE_PAGE_REFERENCE', pageId: id });
      continue;
    }
    seen.add(id);
    if (!(id in pages)) {
      warnings.push({ code: 'DANGLING_PAGE_REFERENCE', pageId: id });
      continue;
    }
    pageOrder.push(id);
  }
  for (const id of Object.keys(pages)) {
    if (!seen.has(id)) {
      warnings.push({ code: 'PAGE_MISSING_FROM_ORDER', pageId: id });
      pageOrder.push(id);
    }
  }

  const unknownFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key !== 'formatVersion' &&
      key !== 'meta' &&
      key !== 'pageOrder' &&
      key !== 'pages'
    ) {
      unknownFields[key] = value;
    }
  }

  const model: NotebookModel = {
    formatVersion: NOTEBOOK_FORMAT_VERSION,
    meta: rawMeta as JsonRecord,
    pageOrder,
    pages,
    ...(Object.keys(unknownFields).length > 0 ? { unknownFields } : {}),
  };
  return { model, warnings, seedBoundsByPage };
}

/** Deterministic canonical serializer (spec §6): known members first, then unknown. */
export function notebookPayloadValue(model: NotebookModel): JsonRecord {
  const out: JsonRecord = {
    formatVersion: NOTEBOOK_FORMAT_VERSION,
    meta: model.meta,
    pageOrder: [...model.pageOrder],
    pages: Object.fromEntries(
      Object.entries(model.pages).map(([id, entry]) => [
        id,
        entry.kind === 'opaque' ? entry.raw : pageRecordJson(entry),
      ]),
    ),
  };
  const { unknownFields } = model as NotebookModel & Record<string, unknown>;
  if (unknownFields && typeof unknownFields === 'object') {
    Object.assign(out, unknownFields);
  }
  return out;
}
export function canonicalNotebookJson(model: NotebookModel): string {
  assertWritableLimits(model);
  return `${JSON.stringify(notebookPayloadValue(model), null, 2)}\n`;
}

/** Encode a model back to canonical bytes. */
export function encodeNotebook(model: NotebookModel): Uint8Array {
  const bytes = utf8Encode(canonicalNotebookJson(model));
  if (bytes.byteLength > NOTEBOOK_LIMITS.maxFileBytes) {
    throw limit('document exceeds max file size');
  }
  return bytes;
}

/** Encode a Notebook while yielding between JSON fragments. */
export async function encodeNotebookAsync(
  model: NotebookModel,
  isCurrent: () => boolean,
): Promise<Uint8Array | null> {
  assertWritableLimits(model);
  const out: JsonRecord = {
    formatVersion: NOTEBOOK_FORMAT_VERSION,
    meta: model.meta,
    pageOrder: [...model.pageOrder],
    pages: Object.fromEntries(
      Object.entries(model.pages).map(([id, entry]) => [
        id,
        entry.kind === 'opaque' ? entry.raw : pageRecordJson(entry),
      ]),
    ),
  };
  const { unknownFields } = model as NotebookModel & Record<string, unknown>;
  if (unknownFields && typeof unknownFields === 'object') {
    Object.assign(out, unknownFields);
  }
  const bytes = await utf8EncodeJsonAsync(out, isCurrent, true);
  if (bytes !== null && bytes.byteLength > NOTEBOOK_LIMITS.maxFileBytes) {
    throw limit('document exceeds max file size');
  }
  return bytes;
}
