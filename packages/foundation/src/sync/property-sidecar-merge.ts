/**
 * Semantic three-way merge for canonical resource-property sidecars.
 *
 * Sync remains byte-oriented for every other file. A sidecar is eligible only
 * when all three bytes decode as the current, owner-matching canonical record.
 * Corrupt, unsupported, or ambiguous input returns null so the ordinary sync
 * conflict-copy policy preserves both byte sequences without rewriting either.
 */

import { utf8Decode, utf8Encode } from '../encoding.js';
import { stableStringify } from '../records.js';

type JsonRecord = Record<string, unknown>;

interface PropertySidecar extends JsonRecord {
  readonly format: 'froglight.properties';
  readonly version: 1;
  readonly owner: string;
  readonly values: JsonRecord;
  readonly relations: readonly string[];
}

const MAX_SIDECAR_BYTES = 1024 * 1024;
const MISSING = Symbol('missing');
const CONFLICT = Symbol('conflict');

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidPropertyValue(value: unknown, depth = 0): boolean {
  return (
    depth <= 16 &&
    (value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (Array.isArray(value) &&
        value.length <= 10_000 &&
        value.every((item) => isValidPropertyValue(item, depth + 1))) ||
      (isRecord(value) &&
        Object.keys(value).length <= 1_000 &&
        Object.values(value).every((item) =>
          isValidPropertyValue(item, depth + 1),
        )))
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function ownerFromPath(path: string): string | null {
  const prefix = '.froglight/properties/';
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return null;
  const encoded = path.slice(prefix.length, -'.json'.length);
  if (encoded.length === 0 || encoded.includes('/')) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parseSidecar(
  bytes: Uint8Array,
  owner: string,
): PropertySidecar | null {
  if (bytes.byteLength > MAX_SIDECAR_BYTES) return null;
  try {
    const text = utf8Decode(bytes);
    // The shared decoder replaces malformed UTF-8. Decline a semantic rewrite
    // if decoding was lossy so the original bytes survive in a conflict copy.
    if (!sameBytes(bytes, utf8Encode(text))) return null;
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      value['format'] !== 'froglight.properties' ||
      value['version'] !== 1 ||
      value['owner'] !== owner ||
      !isRecord(value['values']) ||
      !Object.values(value['values']).every((item) =>
        isValidPropertyValue(item),
      ) ||
      !Array.isArray(value['relations']) ||
      !value['relations'].every((item) => typeof item === 'string') ||
      new Set(value['relations']).size !== value['relations'].length
    ) {
      return null;
    }
    return value as PropertySidecar;
  } catch {
    return null;
  }
}

function equal(
  left: unknown | typeof MISSING,
  right: unknown | typeof MISSING,
) {
  if (left === MISSING || right === MISSING) return left === right;
  return stableStringify(left) === stableStringify(right);
}

function valueAt(record: JsonRecord, key: string): unknown | typeof MISSING {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : MISSING;
}

function mergeValue(
  base: unknown | typeof MISSING,
  local: unknown | typeof MISSING,
  remote: unknown | typeof MISSING,
): unknown | typeof MISSING | typeof CONFLICT {
  if (equal(local, remote)) return local;
  if (equal(base, local)) return remote;
  if (equal(base, remote)) return local;
  return CONFLICT;
}

function mergeRecord(
  base: JsonRecord,
  local: JsonRecord,
  remote: JsonRecord,
  ignored: ReadonlySet<string> = new Set(),
): JsonRecord | null {
  const merged: JsonRecord = Object.create(null) as JsonRecord;
  const keys = [
    ...new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]),
  ].sort();
  for (const key of keys) {
    if (ignored.has(key)) continue;
    const value = mergeValue(
      valueAt(base, key),
      valueAt(local, key),
      valueAt(remote, key),
    );
    if (value === CONFLICT) return null;
    if (value !== MISSING) merged[key] = value;
  }
  return merged;
}

function relationSet(record: PropertySidecar): JsonRecord {
  return Object.fromEntries(record.relations.map((id) => [id, true]));
}

/**
 * Merge independent property IDs and independent unknown top-level fields.
 * A same-field conflict returns null and is handled by the normal deterministic
 * whole-file conflict copy, keeping both acknowledged versions recoverable.
 */
export function mergePropertySidecarBytes(input: {
  readonly path: string;
  readonly base: Uint8Array;
  readonly local: Uint8Array;
  readonly remote: Uint8Array;
}): Uint8Array | null {
  const owner = ownerFromPath(input.path);
  if (owner === null) return null;
  const base = parseSidecar(input.base, owner);
  const local = parseSidecar(input.local, owner);
  const remote = parseSidecar(input.remote, owner);
  if (base === null || local === null || remote === null) return null;

  const values = mergeRecord(base.values, local.values, remote.values);
  const relations = mergeRecord(
    relationSet(base),
    relationSet(local),
    relationSet(remote),
  );
  const ignored = new Set([
    'format',
    'version',
    'owner',
    'values',
    'relations',
  ]);
  const extras = mergeRecord(base, local, remote, ignored);
  if (values === null || relations === null || extras === null) return null;

  return utf8Encode(
    stableStringify({
      ...extras,
      format: 'froglight.properties',
      version: 1,
      owner,
      values,
      relations: Object.keys(relations).sort(),
    }),
  );
}
