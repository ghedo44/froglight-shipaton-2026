/**
 * Whiteboard codec — infinite surface document.
 * Wraps the shared surface payload codec (single source of truth for
 * versioning, preservation, corruption, limits) and enforces whiteboard-
 * specific invariants: infinite frame only.
 * Engine-free.
 */

import { FroglightError } from '../errors.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  decodeSurfacePayload,
  decodeSurfacePayloadAsync,
  encodeSurfacePayload,
  SURFACE_FORMAT_VERSION,
  SURFACE_LIMITS,
  canonicalSurfaceJson,
  encodeSurfacePayloadAsync,
  type DecodeSurfacePayloadResult,
  type SurfaceWarning,
} from '../surfaces/codec.js';
import type { SurfaceModel } from '../surfaces/model.js';

export const WHITEBOARD_FORMAT_VERSION = SURFACE_FORMAT_VERSION;
export const WHITEBOARD_LIMITS = SURFACE_LIMITS;

export type WhiteboardWarning = SurfaceWarning;
export interface DecodeWhiteboardResult {
  readonly model: SurfaceModel;
  readonly warnings: readonly WhiteboardWarning[];
  /**
   * Derived bounds seeds from the shared decode pass (same contract as
   * `DecodeSurfacePayloadResult.seedBounds`): disposable, never canonical.
   */
  readonly seedBounds: DecodeSurfacePayloadResult['seedBounds'];
}

function corrupt(message: string): FroglightError {
  return new FroglightError('RECORD_CORRUPT', `whiteboard: ${message}`);
}

/**
 * Decode whiteboard canonical bytes. Rejects bounded frames (whiteboard is
 * infinite only) as `RECORD_CORRUPT`; otherwise identical to surface payload
 * guarantees.
 */
export function decodeWhiteboard(data: Uint8Array): DecodeWhiteboardResult {
  const result: DecodeSurfacePayloadResult = decodeSurfacePayload(data);
  const frame = result.model.frame as Record<string, unknown>;
  if (frame.kind !== 'infinite') {
    throw corrupt('whiteboard frame must be infinite');
  }
  return result;
}

export async function decodeWhiteboardAsync(
  data: Uint8Array,
  isCurrent: () => boolean,
): Promise<DecodeWhiteboardResult | null> {
  const result = await decodeSurfacePayloadAsync(data, isCurrent);
  if (result === null || !isCurrent()) return null;
  const frame = result.model.frame as Record<string, unknown>;
  if (frame.kind !== 'infinite') throw corrupt('whiteboard frame must be infinite');
  return result;
}

/** Deterministic canonical serializer — reuses surface canonical JSON. */
export function canonicalWhiteboardJson(model: SurfaceModel): string {
  return canonicalSurfaceJson(model);
}

/** Encode whiteboard model to canonical bytes. Enforces infinite frame. */
export function encodeWhiteboard(model: SurfaceModel): Uint8Array {
  const frame = model.frame as Record<string, unknown>;
  if (frame.kind !== 'infinite') {
    throw corrupt('whiteboard frame must be infinite');
  }
  return encodeSurfacePayload(model);
}

/** Encode a whiteboard cooperatively, validating its canonical frame first. */
export async function encodeWhiteboardAsync(
  model: SurfaceModel,
  isCurrent: () => boolean,
): Promise<Uint8Array | null> {
  const frame = model.frame as Record<string, unknown>;
  if (frame.kind !== 'infinite') {
    throw corrupt('whiteboard frame must be infinite');
  }
  return encodeSurfacePayloadAsync(model, isCurrent);
}

/** Re-export shared helpers for tests that want round-trip without wrapper. */
export { utf8Decode, utf8Encode };
