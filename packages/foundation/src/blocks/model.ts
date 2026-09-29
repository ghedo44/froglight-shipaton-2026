/**
 * Canonical block page model.
 *
 * Preservation-first: block and meta records are kept as parsed JSON
 * records so unknown fields survive byte-stable round trips.
 * Typed accessors and constructors give editors/consumers a safe view of
 * core-typed records without ever re-normalizing unknown payloads.
 */

/**
 * Block identifier. Unlike generated identity ids (ResourceId/DocumentId),
 * block ids originate from parsed user documents, so a branded opaque type
 * would add constructor ceremony without runtime enforcement — validity is
 * structural: non-empty string, unique per document (spec §3).
 */
export type BlockId = string;

export type JsonAtom = null | boolean | number | string;
export type JsonValue =
  | JsonAtom
  | { [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonRecord = { [key: string]: JsonValue };

/** Closed core mark set; anything else is an unknown mark preserved verbatim. */
export const CORE_MARKS = ['bold', 'italic', 'strikethrough', 'code'] as const;
export type BareMark = (typeof CORE_MARKS)[number];

export interface LinkMark {
  readonly type: 'link';
  readonly href: string;
}

/** Stable cross-document identity; paths/titles are never canonical identity. */
export interface ResourceTarget {
  readonly documentId: string;
  readonly kindId: string;
  readonly resourceId: string;
  readonly address?: string;
}

export interface ResourceMark {
  readonly type: 'resource';
  readonly target: ResourceTarget;
}

export type Mark = BareMark | LinkMark | ResourceMark | string | JsonRecord;

export interface Run {
  readonly text: string;
  readonly marks?: readonly Mark[];
}

/** Core block type ids (namespace `froglight.` per spec §5). */
export const BLOCK_PAGE_BLOCK_TYPES = {
  paragraph: 'froglight.paragraph',
  heading: 'froglight.heading',
  list: 'froglight.list',
  code: 'froglight.code',
  table: 'froglight.table',
  image: 'froglight.image',
  quote: 'froglight.quote',
  divider: 'froglight.divider',
  toggle: 'froglight.toggle',
  callout: 'froglight.callout',
  resourceLink: 'froglight.resource-link',
  resourceEmbed: 'froglight.resource-embed',
  transclusion: 'froglight.transclusion',
  linkedView: 'froglight.linked-view',
  video: 'froglight.video',
  audio: 'froglight.audio',
  file: 'froglight.file',
  math: 'froglight.math',
  diagram: 'froglight.diagram',
} as const;

export type CoreBlockType =
  (typeof BLOCK_PAGE_BLOCK_TYPES)[keyof typeof BLOCK_PAGE_BLOCK_TYPES];

const CORE_TYPE_ID_SET: ReadonlySet<string> = new Set(
  Object.values(BLOCK_PAGE_BLOCK_TYPES),
);

/** True when `type` names a spec §4 core block type. */
export function isCoreBlockType(type: unknown): type is CoreBlockType {
  return typeof type === 'string' && CORE_TYPE_ID_SET.has(type);
}

/** Dot-namespaced extension id per spec §5 (plugin types and future marks). */
export function isValidNamespacedTypeId(typeId: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/.test(typeId);
}

/** Raw block record: `{id, type}` plus arbitrary payload fields. */
export interface BlockRecord {
  readonly id: BlockId;
  readonly type: string;
  [key: string]: unknown;
}

/** List item inside a `froglight.list` block. */
export interface ListItem {
  readonly runs: Run[];
  /** To-do state; a list containing checked items renders as a to-do list. */
  readonly checked?: boolean;
  readonly children?: readonly BlockId[];
}

/**
 * Opt-in remote media locator: an explicit per-block author
 * choice to reference `https:` content instead of ingesting bytes into the
 * vault. The distinct `remote` key keeps the opt-in explicit in canonical
 * bytes — a remote URL is never inferred from, or auto-upgraded out of, the
 * vault-relative `src` form.
 */
export interface RemoteMediaLocator {
  readonly remote: { readonly url: string };
  /**
   * Optional integrity pin. When present it MUST be a
   * lowercase-hex SHA-256 (64 chars) and providers verify fetched bytes
   * against it; when absent the locator is availability-only by design —
   * fetch failure/offline renders a placeholder, never a mutation.
   */
  readonly sha256?: string;
}

/** Vault-identity locator: relative path plus required integrity hash (mirrors `froglight.image`). */
export interface VaultMediaLocator {
  readonly src: string;
  readonly sha256: string;
}

/**
 * Exactly one locator per media block: vault identity or opt-in remote,
 * never both, never neither.
 */
export type MediaLocator = VaultMediaLocator | RemoteMediaLocator;

/** Optional presentation text for media blocks; never identity/resolution input. */
export interface MediaPresentation {
  readonly name?: string;
  readonly caption?: string;
  readonly alt?: string;
}

/**
 * Canonical remote-URL length cap: 4096 UTF-16 code units, aligned with the
 * spec §8 `maxResourceAddress` precedent (string `.length` units).
 */
export const MAX_REMOTE_MEDIA_URL_UTF16 = 4_096;

/** Lowercase-hex SHA-256 pin format.*/
const REMOTE_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Codec-side remote URL validation. Engine-free: the `URL`
 * global is pure parsing, no DOM/fetch).
 *
 * Enforcement assignment: the codec validates locator *shape at rest*
 * (https-only, no userinfo, length cap). Providers own *fetch-time*
 * enforcement (sandboxed surface, no http-downgrade
 * redirects, offline/unreachable placeholder, integrity-pin check) and
 * MUST re-validate before fetching — the codec never fetches.
 *
 * Canonical bytes must equal fetch inputs, so anything the WHATWG parser
 * would silently rewrite is rejected before parsing: backslash `\`
 * (U+005C, rewritten to `/` for special schemes such as `https:`),
 * ASCII control /
 * space characters (`[\u0000-\u0020\u007F]`) anywhere (embedded
 * tab/newline is stripped, leading C0/space trimmed), a missing
 * double-slash authority opener (`https:/host` parses as `https://host`),
 * and an empty authority (`https:///`, `https://?q` — the parser may
 * recover these into a fetchable host, e.g. `https:///path` → host
 * `path`, so the raw authority form is checked, not just the parsed
 * hostname). A non-empty parsed hostname is still required as
 * defense-in-depth across runtimes.
 */
export function isValidRemoteMediaUrl(url: string): boolean {
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.length > MAX_REMOTE_MEDIA_URL_UTF16
  )
    return false;
  // Canonical bytes must be fetchable as-is: reject padded forms the URL
  // parser would silently trim.
  if (url !== url.trim()) return false;
  // WHATWG strips embedded tab/newline, trims leading C0 controls, and
  // rewrites backslash to `/` for special schemes, so any control/space
  // byte or backslash anywhere means canonical !== fetch input.
  // eslint-disable-next-line no-control-regex -- canonical URLs must reject C0 bytes
  if (/[\\\u0000-\u0020\u007F]/.test(url)) return false;
  // Single-slash `https:/host` parses as `https://host`: the canonical
  // bytes must carry the explicit double-slash authority opener.
  if (!/^https:\/\//i.test(url)) return false;
  // The raw authority must be non-empty: the parser recovers some
  // empty-authority forms into a fetchable host instead of throwing.
  const afterSlashes = url.replace(/^https:\/\//i, '');
  if (
    afterSlashes === '' ||
    afterSlashes[0] === '/' ||
    afterSlashes[0] === '?' ||
    afterSlashes[0] === '#'
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname === '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  // `new URL` normalizes empty userinfo inconsistently across runtimes, so
  // reject any literal userinfo separator in the authority: `https://@host/`
  // must never become a fetchable shape either.
  const authority =
    url
      .replace(/^https:/i, '')
      .replace(/^\/\//, '')
      .split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return false;
  return true;
}

/**
 * Shape validation for one opt-in `remote` locator object.
 *
 * Contract: `value` is the *inner* `{url}` object (`record.remote`), NOT
 * the whole block record — the optional `sha256` pin lives alongside
 * `remote` on the record and is checked by the media-record validator,
 * not here. Unknown extra keys on the inner object are preserved and
 * ignored.
 */
export function isValidRemoteLocator(
  value: unknown,
): value is RemoteMediaLocator {
  if (!isJsonRecord(value)) return false;
  return typeof value.url === 'string' && isValidRemoteMediaUrl(value.url);
}

/** Canonical document model. Plain/mutable so editor adapters can update in place. */
export interface BlockPageModel {
  formatVersion: number;
  meta: JsonRecord;
  rootOrder: BlockId[];
  blocks: Record<BlockId, BlockRecord>;
  [key: string]: unknown;
}

// --- Constructors (emit canonical field order per spec §4) ---

export function paragraphBlock(id: BlockId, runs: Run[]): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.paragraph, runs };
}

export function headingBlock(
  id: BlockId,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  runs: Run[],
): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.heading, level, runs };
}

export function codeBlock(
  id: BlockId,
  text: string,
  language?: string,
): BlockRecord {
  return language === undefined
    ? { id, type: BLOCK_PAGE_BLOCK_TYPES.code, text }
    : { id, type: BLOCK_PAGE_BLOCK_TYPES.code, language, text };
}

export function imageBlock(
  id: BlockId,
  src: string,
  sha256: string,
  alt?: string,
): BlockRecord {
  return alt === undefined
    ? { id, type: BLOCK_PAGE_BLOCK_TYPES.image, src, sha256 }
    : { id, type: BLOCK_PAGE_BLOCK_TYPES.image, src, sha256, alt };
}

export function listBlock(
  id: BlockId,
  ordered: boolean,
  items: ListItem[],
): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.list, ordered, items };
}

export function tableBlock(
  id: BlockId,
  columnCount: number,
  rows: ReadonlyArray<{ cells: Run[][] }>,
  options?: { align?: Array<'left' | 'center' | 'right'>; header?: boolean },
): BlockRecord {
  return {
    id,
    type: BLOCK_PAGE_BLOCK_TYPES.table,
    columnCount,
    ...(options?.align !== undefined ? { align: options.align } : {}),
    ...(options?.header !== undefined ? { header: options.header } : {}),
    rows,
  };
}

export function quoteBlock(id: BlockId, runs: Run[]): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.quote, runs };
}

export function dividerBlock(id: BlockId): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.divider };
}

export function toggleBlock(id: BlockId, runs: Run[]): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.toggle, runs };
}

export function calloutBlock(
  id: BlockId,
  runs: Run[],
  options?: { icon?: string; tone?: string },
): BlockRecord {
  return {
    id,
    type: BLOCK_PAGE_BLOCK_TYPES.callout,
    ...(options?.icon !== undefined ? { icon: options.icon } : {}),
    ...(options?.tone !== undefined ? { tone: options.tone } : {}),
    runs,
  };
}

export function resourceLinkBlock(
  id: BlockId,
  target: ResourceTarget,
  label?: string,
): BlockRecord {
  return {
    id,
    type: BLOCK_PAGE_BLOCK_TYPES.resourceLink,
    target,
    ...(label !== undefined ? { label } : {}),
  };
}

export function resourceEmbedBlock(
  id: BlockId,
  target: ResourceTarget,
  options?: { label?: string; presentation?: JsonRecord },
): BlockRecord {
  return {
    id,
    type: BLOCK_PAGE_BLOCK_TYPES.resourceEmbed,
    target,
    ...(options?.label !== undefined ? { label: options.label } : {}),
    ...(options?.presentation !== undefined
      ? { presentation: options.presentation }
      : {}),
  };
}

export function transclusionBlock(
  id: BlockId,
  target: ResourceTarget & { readonly address: string },
  options?: { label?: string; presentation?: JsonRecord },
): BlockRecord {
  return {
    id,
    type: BLOCK_PAGE_BLOCK_TYPES.transclusion,
    target,
    ...(options?.label !== undefined ? { label: options.label } : {}),
    ...(options?.presentation !== undefined
      ? { presentation: options.presentation }
      : {}),
  };
}

export function linkedViewBlock(
  id: BlockId,
  target: ResourceTarget,
  viewId: string,
  options?: { label?: string; overrides?: JsonRecord },
): BlockRecord {
  return {
    id,
    type: BLOCK_PAGE_BLOCK_TYPES.linkedView,
    target,
    viewId,
    ...(options?.label !== undefined ? { label: options.label } : {}),
    ...(options?.overrides !== undefined
      ? { overrides: options.overrides }
      : {}),
  };
}

/**
 * Shared media constructor. Canonical field order: `id, type`,
 * then the locator (`src, sha256` for vault identity; `remote` plus
 * optional `sha256` pin for opt-in remote), then presentation
 * (`name?, caption?, alt?` — cached display text that MUST NOT participate
 * in identity or resolution, ResourceTarget `label` precedent).
 */
function mediaBlock(
  type: 'froglight.video' | 'froglight.audio' | 'froglight.file',
  id: BlockId,
  locator: MediaLocator,
  options?: MediaPresentation,
): BlockRecord {
  const presentation = {
    ...(options?.name !== undefined ? { name: options.name } : {}),
    ...(options?.caption !== undefined ? { caption: options.caption } : {}),
    ...(options?.alt !== undefined ? { alt: options.alt } : {}),
  };
  if ('remote' in locator) {
    return {
      id,
      type,
      remote: { url: locator.remote.url },
      ...(locator.sha256 !== undefined ? { sha256: locator.sha256 } : {}),
      ...presentation,
    };
  }
  return {
    id,
    type,
    src: locator.src,
    sha256: locator.sha256,
    ...presentation,
  };
}

export function videoBlock(
  id: BlockId,
  locator: MediaLocator,
  options?: MediaPresentation,
): BlockRecord {
  return mediaBlock(BLOCK_PAGE_BLOCK_TYPES.video, id, locator, options);
}

export function audioBlock(
  id: BlockId,
  locator: MediaLocator,
  options?: MediaPresentation,
): BlockRecord {
  return mediaBlock(BLOCK_PAGE_BLOCK_TYPES.audio, id, locator, options);
}

export function fileBlock(
  id: BlockId,
  locator: MediaLocator,
  options?: MediaPresentation,
): BlockRecord {
  return mediaBlock(BLOCK_PAGE_BLOCK_TYPES.file, id, locator, options);
}

/**
 * Source-only math/diagram constructors: canonical content is
 * the author-written source text; rendered output is derived and never
 * serialized.
 */
export function mathBlock(id: BlockId, source: string): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.math, source };
}

export function diagramBlock(id: BlockId, source: string): BlockRecord {
  return { id, type: BLOCK_PAGE_BLOCK_TYPES.diagram, source };
}

export function emptyBlockPage(meta: JsonRecord = {}): BlockPageModel {
  return { formatVersion: 1, meta, rootOrder: [], blocks: {} };
}

// --- Shape validation (single source of truth for core-record structure) ---

/** Asset paths must stay inside the vault (spec §8). */
export function isUnsafeAssetSrc(src: string): boolean {
  return (
    src.startsWith('/') || src.includes('\\') || src.split('/').includes('..')
  );
}

/** Structural validation of a core-typed record (spec §4). */
export function isValidCoreRecord(record: BlockRecord): boolean {
  switch (record.type) {
    case 'froglight.paragraph':
    case 'froglight.heading':
      return runsOf(record) !== null;
    case 'froglight.code':
      return typeof record.text === 'string';
    case 'froglight.image': {
      if (typeof record.src !== 'string' || typeof record.sha256 !== 'string')
        return false;
      return !isUnsafeAssetSrc(record.src);
    }
    case 'froglight.list': {
      if (typeof record.ordered !== 'boolean' || !Array.isArray(record.items))
        return false;
      return (record.items as readonly unknown[]).every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          Array.isArray((item as { runs?: unknown }).runs),
      );
    }
    case 'froglight.table': {
      if (typeof record.columnCount !== 'number' || record.columnCount < 1)
        return false;
      if (!Array.isArray(record.rows)) return false;
      return (record.rows as readonly unknown[]).every(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          !Array.isArray(row) &&
          Array.isArray((row as { cells?: unknown }).cells),
      );
    }
    case 'froglight.quote':
    case 'froglight.toggle':
      return runsOf(record) !== null;
    case 'froglight.divider':
      return true;
    case 'froglight.callout': {
      if (runsOf(record) === null) return false;
      const { icon, tone } = record;
      if (icon !== undefined && typeof icon !== 'string') return false;
      return tone === undefined || typeof tone === 'string';
    }
    case 'froglight.resource-link':
      return isResourceTarget(record.target) && optionalString(record.label);
    case 'froglight.resource-embed':
      return (
        isResourceTarget(record.target) &&
        optionalString(record.label) &&
        isPresentation(record.presentation)
      );
    case 'froglight.transclusion':
      return (
        isResourceTarget(record.target) &&
        (record.target as ResourceTarget).address !== undefined &&
        optionalString(record.label) &&
        isPresentation(record.presentation)
      );
    case 'froglight.linked-view':
      return (
        isResourceTarget(record.target) &&
        typeof record.viewId === 'string' &&
        record.viewId.length > 0 &&
        optionalString(record.label) &&
        (record.overrides === undefined || isJsonRecord(record.overrides))
      );
    case 'froglight.video':
    case 'froglight.audio':
    case 'froglight.file':
      return isValidMediaRecord(record);
    case 'froglight.math':
    case 'froglight.diagram':
      // Source-only blocks: the source string is canonical;
      // rendered output is derived and never validated here.
      return typeof record.source === 'string';
    default:
      return false;
  }
}

/**
 * Structural validation of a media record (spec §4): presentation text is
 * optional strings only, and exactly one locator — vault identity
 * (`src` + required `sha256`, mirroring `froglight.image`) or opt-in
 * remote (`remote.url` + optional hex pin) — must be present.
 */
function isValidMediaRecord(record: BlockRecord): boolean {
  if (
    !optionalString(record.name) ||
    !optionalString(record.caption) ||
    !optionalString(record.alt)
  ) {
    return false;
  }
  const vaultPresent = record.src !== undefined;
  // `remote` presence marks an explicit opt-in attempt even when malformed
  // (the codec reports such failures as REMOTE_URL_REJECTED, not generic
  // opaque). A bare `sha256` with neither `src` nor `remote` belongs to no
  // locator: the pin is only meaningful alongside `remote`, and vault
  // identity always pairs it with `src`.
  const remotePresent = record.remote !== undefined;
  if (vaultPresent && remotePresent) return false;
  if (vaultPresent) {
    return (
      typeof record.src === 'string' &&
      record.src.length > 0 &&
      !isUnsafeAssetSrc(record.src) &&
      typeof record.sha256 === 'string' &&
      record.sha256.length > 0
    );
  }
  if (remotePresent) {
    if (!isValidRemoteLocator(record.remote)) return false;
    return (
      record.sha256 === undefined ||
      (typeof record.sha256 === 'string' &&
        REMOTE_SHA256_RE.test(record.sha256))
    );
  }
  return false;
}

/**
 * True when a media record carries a `remote` key — i.e. the author
 * attempted the opt-in remote form. Used by the codec to report remote
 * validation failures with the specific `REMOTE_URL_REJECTED` warning
 *  instead of the generic opaque warning.
 */
export function isRemoteMediaAttempt(record: BlockRecord): boolean {
  return (
    (record.type === BLOCK_PAGE_BLOCK_TYPES.video ||
      record.type === BLOCK_PAGE_BLOCK_TYPES.audio ||
      record.type === BLOCK_PAGE_BLOCK_TYPES.file) &&
    record.remote !== undefined
  );
}

/** Count of inline runs in a text-bearing or table record, for the runs limit. */
export function countInlineRuns(record: BlockRecord): number {
  return inlineRunsOf(record).length;
}

/** Every structurally readable inline run carried by a block, including lists/tables. */
export function inlineRunsOf(record: BlockRecord): Run[] {
  const collected: Run[] = [];
  const append = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const run of value) {
      if (isJsonRecord(run) && typeof run.text === 'string')
        collected.push(run as unknown as Run);
    }
  };
  append(record.runs);
  if (
    record.type === BLOCK_PAGE_BLOCK_TYPES.list &&
    Array.isArray(record.items)
  ) {
    for (const item of record.items) if (isJsonRecord(item)) append(item.runs);
  }
  if (
    record.type === BLOCK_PAGE_BLOCK_TYPES.table &&
    Array.isArray(record.rows)
  ) {
    for (const row of record.rows) {
      if (!isJsonRecord(row) || !Array.isArray(row.cells)) continue;
      for (const cell of row.cells) append(cell);
    }
  }
  return collected;
}

// --- Accessors (null/Never when the record is not a valid core record) ---

export function isBareMark(mark: unknown): mark is BareMark {
  return (
    typeof mark === 'string' && (CORE_MARKS as readonly string[]).includes(mark)
  );
}

export function isLinkMark(mark: unknown): mark is LinkMark {
  return (
    typeof mark === 'object' &&
    mark !== null &&
    !Array.isArray(mark) &&
    (mark as JsonRecord).type === 'link' &&
    typeof (mark as JsonRecord).href === 'string'
  );
}

export function isResourceTarget(value: unknown): value is ResourceTarget {
  if (!isJsonRecord(value)) return false;
  if (
    typeof value.documentId !== 'string' ||
    value.documentId.length === 0 ||
    typeof value.kindId !== 'string' ||
    value.kindId.length === 0 ||
    typeof value.resourceId !== 'string' ||
    value.resourceId.length === 0
  )
    return false;
  return (
    value.address === undefined ||
    (typeof value.address === 'string' && value.address.length > 0)
  );
}

export function isResourceMark(mark: unknown): mark is ResourceMark {
  return (
    isJsonRecord(mark) &&
    mark.type === 'resource' &&
    isResourceTarget(mark.target)
  );
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isPresentation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isJsonRecord(value)) return false;
  const allowed = new Set(['showTitle', 'compact', 'maxLines', 'extensions']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.showTitle !== undefined && typeof value.showTitle !== 'boolean')
    return false;
  if (value.compact !== undefined && typeof value.compact !== 'boolean')
    return false;
  if (
    value.maxLines !== undefined &&
    (typeof value.maxLines !== 'number' ||
      !Number.isInteger(value.maxLines) ||
      value.maxLines < 1 ||
      value.maxLines > 20)
  )
    return false;
  if (value.extensions !== undefined) {
    if (!isJsonRecord(value.extensions)) return false;
    if (
      Object.keys(value.extensions).some((key) => !isValidNamespacedTypeId(key))
    )
      return false;
  }
  return true;
}

/** Runs of a text-bearing core record; null for non-core or invalid records. */
export function runsOf(record: BlockRecord): Run[] | null {
  const textBearing =
    record.type === BLOCK_PAGE_BLOCK_TYPES.paragraph ||
    record.type === BLOCK_PAGE_BLOCK_TYPES.heading ||
    record.type === BLOCK_PAGE_BLOCK_TYPES.quote ||
    record.type === BLOCK_PAGE_BLOCK_TYPES.toggle ||
    record.type === BLOCK_PAGE_BLOCK_TYPES.callout;
  if (!textBearing) {
    return null;
  }
  if (record.type === BLOCK_PAGE_BLOCK_TYPES.heading) {
    const level = record.level;
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < 1 ||
      level > 6
    )
      return null;
  }
  const runs = record.runs;
  if (!Array.isArray(runs)) return null;
  for (const run of runs) {
    if (typeof run !== 'object' || run === null || Array.isArray(run))
      return null;
    if (typeof (run as JsonRecord).text !== 'string') return null;
  }
  return runs as Run[];
}

/** Plain text of a code block; null when not a valid code record. */
export function codeTextOf(record: BlockRecord): string | null {
  if (record.type !== BLOCK_PAGE_BLOCK_TYPES.code) return null;
  return typeof record.text === 'string' ? record.text : null;
}

/** Child-id lists contributed by any container record (list items today). */
export function childrenOf(record: BlockRecord): BlockId[] {
  const children: BlockId[] = [];
  if (
    record.type === BLOCK_PAGE_BLOCK_TYPES.list &&
    Array.isArray(record.items)
  ) {
    for (const item of record.items as readonly JsonValue[]) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const kids = (item as JsonRecord).children;
        if (Array.isArray(kids)) {
          for (const kid of kids) {
            if (typeof kid === 'string') children.push(kid);
          }
        }
      }
    }
  }
  const own = record.children;
  if (Array.isArray(own)) {
    for (const kid of own) {
      if (typeof kid === 'string') children.push(kid);
    }
  }
  return children;
}
