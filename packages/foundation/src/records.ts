/**
 * Versioned portable record helpers.
 *
 * Every Froglight metadata record stored in the workspace (`.froglight/`)
 * is a versioned JSON document that must be readable without the
 * application database and tolerant of unknown fields. Unknown fields are
 * ignored on read and preserved on write.
 *
 * Encoding is deterministic: keys are emitted in sorted order so the same
 * record always serializes to the same bytes on every host.
 */

import { ErrorCodes, FroglightError } from './errors.js';
import { utf8Decode, utf8Encode } from './encoding.js';

/** A versioned record: every Froglight metadata file starts with these. */
export interface VersionedRecord {
  readonly format: string;
  readonly version: number;
}

/**
 * Parse and validate a versioned JSON record. Throws structured
 * `FroglightError`s for format mismatch, unsupported version, and corrupt
 * JSON. `knownKeys` are the record's own keys; any other own keys are
 * returned as `extras` and must be preserved on write.
 */
export function parseVersionedRecord<T extends VersionedRecord>(
  data: Uint8Array,
  expectedFormat: string,
  supportedVersions: readonly number[],
  knownKeys: Iterable<string>,
): { readonly record: T; readonly extras: Readonly<Record<string, unknown>> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(data));
  } catch (cause) {
    throw new FroglightError(ErrorCodes.RECORD_CORRUPT, 'record is not valid JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FroglightError(ErrorCodes.RECORD_CORRUPT, 'record must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== expectedFormat) {
    throw new FroglightError(
      ErrorCodes.RECORD_FORMAT_MISMATCH,
      `expected format ${JSON.stringify(expectedFormat)}, got ${JSON.stringify(obj.format)}`,
    );
  }
  if (typeof obj.version !== 'number' || !supportedVersions.includes(obj.version)) {
    throw new FroglightError(
      ErrorCodes.RECORD_VERSION_UNSUPPORTED,
      `unsupported record version ${JSON.stringify(obj.version)}`,
    );
  }
  const known = new Set(knownKeys);
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      extras[key] = obj[key];
    }
  }
  return { record: obj as T, extras };
}

/**
 * Serialize a versioned record deterministically (sorted keys), merging
 * preserved `extras` back in so unknown fields survive round trips.
 */
export function serializeVersionedRecord(
  record: VersionedRecord & Record<string, unknown>,
  extras: Readonly<Record<string, unknown>> = {},
): Uint8Array {
  return utf8Encode(stableStringify({ ...record, ...extras }));
}

/**
 * Serialize any JSON-compatible value with deterministically sorted object
 * keys (stable across engines and insertion orders).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Return the own keys of `obj` that are not in `knownKeys` — used to
 * preserve unknown fields on nested record items (documents, revisions).
 */
export function pickUnknown(
  obj: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
): Record<string, unknown> {
  const known = new Set(knownKeys);
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      extras[key] = obj[key];
    }
  }
  return extras;
}
