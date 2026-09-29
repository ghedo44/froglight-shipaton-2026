/**
 * `.blockpage` canonical codec.
 * Engine-free: no editor, DOM, or host types.
 *
 * Preservation-first: parsed records are kept verbatim so unknown fields,
 * block types, and marks round-trip byte-stably (spec §6).
 *
 * Remote-media enforcement split: this codec owns
 * locator validation at rest (https-only, no userinfo, length cap, pin
 * format — see `isValidRemoteMediaUrl`); providers own fetch-time
 * enforcement and MUST re-validate before fetching. This codec never
 * fetches, follows redirects, or rewrites canonical bytes with outcomes.
 */

import { FroglightError } from '../errors.js';
import type { DocumentRef, DecodedDocument } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import { parseJsonAsync, utf8Decode, utf8Encode } from '../encoding.js';
import {
  childrenOf,
  countInlineRuns,
  isCoreBlockType,
  isRemoteMediaAttempt,
  isUnsafeAssetSrc,
  isValidCoreRecord,
  isResourceMark,
  isResourceTarget,
  inlineRunsOf,
  MAX_REMOTE_MEDIA_URL_UTF16,
  type BlockId,
  type BlockPageModel,
  type BlockRecord,
  type JsonRecord,
} from './model.js';

export const BLOCK_PAGE_FORMAT_VERSION = 1;

/** Security limits per spec §8. */
export const BLOCK_PAGE_LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxBlocks: 100_000,
  maxDepth: 64,
  maxRunsPerBlock: 10_000,
  maxResourceAddress: 4_096,
  maxCompositionLabel: 2_048,
  /** Opt-in remote media URL cap, aligned with the address precedent (spec §8). */
  maxRemoteUrl: MAX_REMOTE_MEDIA_URL_UTF16,
} as const;

/** Machine-readable recovery annotations (spec §7); never free text to parse. */
export type BlockPageWarningCode =
  | 'MALFORMED_BLOCK_DROPPED'
  | 'INVALID_CORE_BLOCK_OPAQUE'
  | 'REMOTE_URL_REJECTED'
  | 'DUPLICATE_ROOT_REFERENCE'
  | 'DANGLING_ROOT_REFERENCE'
  | 'DANGLING_CHILD_REFERENCE'
  | 'CYCLE_BROKEN'
  | 'DEPTH_TRUNCATED';

export interface BlockPageWarning {
  readonly code: BlockPageWarningCode;
  /** The damaged or repaired block, when applicable. */
  readonly blockId?: BlockId;
  /** The referenced id that was removed or deduplicated, when applicable. */
  readonly refId?: BlockId;
}

export interface DecodeBlockPageResult extends DecodedDocument<BlockPageModel> {
  /** Partial-recovery notes (spec §7); empty for clean decodes. */
  readonly warnings: readonly BlockPageWarning[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function corrupt(message: string): FroglightError {
  return new FroglightError('RECORD_CORRUPT', `block page: ${message}`);
}

/** Remove one child reference from a container record (copy-on-write caller). */
function removeChildRef(record: BlockRecord, targetId: BlockId): void {
  const filterKids = (kids: unknown[]): unknown[] =>
    kids.filter((kid) => kid !== targetId);
  if (record.type === 'froglight.list' && Array.isArray(record.items)) {
    for (const item of record.items as JsonRecord[]) {
      if (Array.isArray(item.children)) {
        (item as { children?: unknown }).children = filterKids(item.children);
      }
    }
  }
  if (Array.isArray(record.children)) {
    (record as { children?: unknown }).children = filterKids(record.children);
  }
}

/**
 * Partial recovery pass (spec §7): drops non-object/typed-less entries,
 * flags invalid core records as opaque, dedupes root order, removes
 * dangling references, breaks cycles and truncates over-deep chains.
 * Copy-on-write: clean documents are never mutated.
 */
function recoverStructure(
  rawBlocks: Record<string, unknown>,
  rawRootOrder: string[],
  warnings: BlockPageWarning[],
): { blocks: Record<BlockId, BlockRecord>; rootOrder: BlockId[] } {
  const blocks: Record<BlockId, BlockRecord> = {};
  for (const [key, value] of Object.entries(rawBlocks)) {
    if (
      !isPlainObject(value) ||
      typeof (value as JsonRecord).type !== 'string'
    ) {
      warnings.push({ code: 'MALFORMED_BLOCK_DROPPED', blockId: key });
      continue;
    }
    blocks[key] = value as BlockRecord;
  }

  for (const record of Object.values(blocks)) {
    if (countInlineRuns(record) > BLOCK_PAGE_LIMITS.maxRunsPerBlock) {
      throw new FroglightError(
        'FORMAT_LIMIT_EXCEEDED',
        `block "${String(record.id)}" exceeds max runs`,
      );
    }
    // Path escapes are a hard security error, not partial recovery (spec §8).
    // Media vault paths share the image posture exactly (mirror-image rule).
    const imageSrc = record.type === 'froglight.image' ? record.src : undefined;
    if (typeof imageSrc === 'string' && isUnsafeAssetSrc(imageSrc)) {
      throw new FroglightError(
        'FORMAT_LIMIT_EXCEEDED',
        `image "${String(record.id)}" references an unsafe asset path`,
      );
    }
    const mediaSrc =
      record.type === 'froglight.video' ||
      record.type === 'froglight.audio' ||
      record.type === 'froglight.file'
        ? record.src
        : undefined;
    if (typeof mediaSrc === 'string' && isUnsafeAssetSrc(mediaSrc)) {
      throw new FroglightError(
        'FORMAT_LIMIT_EXCEEDED',
        `media "${String(record.id)}" references an unsafe asset path`,
      );
    }
    if (isCoreBlockType(record.type) && !isValidCoreRecord(record)) {
      // Remote opt-in attempts get the specific scheme/pin failure code
      // every other core violation stays generic. Either way
      // the record is preserved verbatim as opaque — invalid remotes are
      // never normalized into a fetchable shape.
      // Scope note: any invalid media record carrying a `remote` key reports
      // REMOTE_URL_REJECTED — including ambiguous dual locators or a valid
      // remote alongside bad presentation text — because the key marks an
      // explicit opt-in attempt. Narrowing to locator-field-only failures
      // would flip the asserted ambiguous-locator fixture and split
      // validation between model and codec, so the broad scope stays.
      warnings.push(
        isRemoteMediaAttempt(record)
          ? { code: 'REMOTE_URL_REJECTED', blockId: record.id }
          : { code: 'INVALID_CORE_BLOCK_OPAQUE', blockId: record.id },
      );
    }
    if (
      typeof record.label === 'string' &&
      record.label.length > BLOCK_PAGE_LIMITS.maxCompositionLabel
    ) {
      throw new FroglightError(
        'FORMAT_LIMIT_EXCEEDED',
        `block "${String(record.id)}" exceeds max composition label length`,
      );
    }
    const targets: unknown[] = [record.target];
    for (const run of inlineRunsOf(record)) {
      for (const mark of run.marks ?? [])
        if (isResourceMark(mark)) targets.push(mark.target);
    }
    for (const target of targets) {
      if (
        isResourceTarget(target) &&
        target.address !== undefined &&
        target.address.length > BLOCK_PAGE_LIMITS.maxResourceAddress
      ) {
        throw new FroglightError(
          'FORMAT_LIMIT_EXCEEDED',
          `block "${String(record.id)}" exceeds max resource address length`,
        );
      }
    }
  }

  const seenRoots = new Set<BlockId>();
  const rootOrder: BlockId[] = [];
  for (const id of rawRootOrder) {
    if (seenRoots.has(id)) {
      warnings.push({ code: 'DUPLICATE_ROOT_REFERENCE', refId: id });
      continue;
    }
    seenRoots.add(id);
    if (!(id in blocks)) {
      warnings.push({ code: 'DANGLING_ROOT_REFERENCE', refId: id });
      continue;
    }
    rootOrder.push(id);
  }

  // Cycle breaking + depth truncation over child-id edges.
  const state = new Map<BlockId, 'visiting' | 'done'>();
  const path: BlockId[] = [];
  const visit = (id: BlockId, depth: number): void => {
    const status = state.get(id);
    const parent = path[path.length - 1];
    if (status === 'done') return;
    if (status === 'visiting') {
      if (parent !== undefined) {
        warnings.push({ code: 'CYCLE_BROKEN', blockId: parent, refId: id });
        removeChildRef(blocks[parent]!, id);
      }
      return;
    }
    if (depth > BLOCK_PAGE_LIMITS.maxDepth) {
      if (parent !== undefined) {
        warnings.push({ code: 'DEPTH_TRUNCATED', blockId: parent, refId: id });
        removeChildRef(blocks[parent]!, id);
      }
      return;
    }
    state.set(id, 'visiting');
    path.push(id);
    for (const child of childrenOf(blocks[id]!)) {
      if (!(child in blocks)) {
        warnings.push({
          code: 'DANGLING_CHILD_REFERENCE',
          blockId: id,
          refId: child,
        });
        removeChildRef(blocks[id]!, child);
      } else {
        visit(child, depth + 1);
      }
    }
    path.pop();
    state.set(id, 'done');
  };
  for (const id of Object.keys(blocks)) visit(id, 0);

  return { blocks, rootOrder };
}

/** Decode canonical `.blockpage` bytes into a model plus derived projections. */
export function decodeBlockPage(
  data: Uint8Array,
  _ref: DocumentRef,
): DecodeBlockPageResult {
  if (data.byteLength > BLOCK_PAGE_LIMITS.maxFileBytes) {
    throw new FroglightError(
      'FORMAT_LIMIT_EXCEEDED',
      'block page exceeds max file size',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(data));
  } catch {
    throw corrupt('not valid JSON');
  }
  return decodeBlockPageValue(parsed);
}

export async function decodeBlockPageAsync(
  data: Uint8Array,
  ref: DocumentRef,
  isCurrent: () => boolean,
): Promise<DecodeBlockPageResult | null> {
  if (data.byteLength > BLOCK_PAGE_LIMITS.maxFileBytes) {
    throw new FroglightError('FORMAT_LIMIT_EXCEEDED', 'block page exceeds max file size');
  }
  let parsed: unknown | null;
  try {
    parsed = await parseJsonAsync(data, isCurrent);
  } catch {
    if (!isCurrent()) return null;
    throw corrupt('not valid JSON');
  }
  if (parsed === null && !isCurrent()) return null;
  void ref;
  return decodeBlockPageValue(parsed);
}

function decodeBlockPageValue(parsed: unknown): DecodeBlockPageResult {
  if (!isPlainObject(parsed)) throw corrupt('document is not a JSON object');

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== 'number') throw corrupt('missing formatVersion');
  if (
    !Number.isInteger(formatVersion) ||
    formatVersion < 1 ||
    formatVersion !== BLOCK_PAGE_FORMAT_VERSION
  ) {
    // Unknown versions (newer, zero, negative, fractional) are rejected,
    // never best-effort parsed (spec §2).
    throw new FroglightError(
      'UNKNOWN_FORMAT_VERSION',
      `block page formatVersion ${String(formatVersion)} is not supported (v${BLOCK_PAGE_FORMAT_VERSION})`,
    );
  }

  const meta = parsed.meta;
  if (!isPlainObject(meta)) throw corrupt('meta must be an object');
  const rawBlocks = parsed.blocks;
  if (!isPlainObject(rawBlocks)) throw corrupt('blocks must be an object');
  if (Object.keys(rawBlocks).length > BLOCK_PAGE_LIMITS.maxBlocks) {
    throw new FroglightError(
      'FORMAT_LIMIT_EXCEEDED',
      'block page exceeds max block count',
    );
  }
  const rootOrder = parsed.rootOrder;
  if (
    !Array.isArray(rootOrder) ||
    rootOrder.some((id) => typeof id !== 'string')
  ) {
    throw corrupt('rootOrder must be an array of block ids');
  }

  // Records are consumed as-is: preservation is the default; only structural
  // damage is repaired, each action annotated as a warning (spec §7).
  const warnings: BlockPageWarning[] = [];
  const recovered = recoverStructure(
    rawBlocks,
    rootOrder as string[],
    warnings,
  );
  const model = {
    ...(parsed as Record<string, unknown>),
    formatVersion,
    meta: meta as BlockPageModel['meta'],
    rootOrder: recovered.rootOrder,
    blocks: recovered.blocks,
  } as BlockPageModel;
  return {
    model,
    metadata: {},
    relationships: [] as RelationshipInput[],
    warnings,
  };
}

/** Deterministic canonical serializer (spec §6): 2-space indent, LF, trailing newline. */
export function canonicalBlockPageJson(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Encode a model back to canonical bytes. */
export function encodeBlockPage(
  model: BlockPageModel,
  _ref: DocumentRef,
): Uint8Array {
  return utf8Encode(canonicalBlockPageJson(model));
}
