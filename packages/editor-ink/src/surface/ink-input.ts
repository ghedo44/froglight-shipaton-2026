/**
 * Ink input batch normalization (writing-experience input model).
 *
 * One DOM PointerEvent fans out to `getCoalescedEvents()` (confirmed
 * samples) plus `getPredictedEvents()` (ephemeral lookahead). Every sample
 * is normalized against the single canvas rect the caller already read,
 * keeps temporal order, drops consecutive duplicates, and carries plain
 * data only — DOM events are never retained past dispatch.
 *
 * The only DOM-touching step is reading coordinates and event lists off
 * the incoming event; everything else is pure and unit-testable.
 */

import type {
  InkInputBatch,
  NormalizedPointerEvent,
} from '@froglight/foundation';
import { normalizePointerAxes, viewPointFromRect } from './pointer.js';

/** Structural view of a PointerEvent (real events satisfy this shape). */
export interface RawInkPointerEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly shiftKey?: boolean;
  readonly pressure?: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly twist?: number;
  readonly twistAngle?: number;
  readonly timeStamp?: number;
  getCoalescedEvents?: () => readonly RawInkPointerEvent[];
  getPredictedEvents?: () => readonly RawInkPointerEvent[];
}

export interface CanvasRect {
  readonly left: number;
  readonly top: number;
}

function rawList(
  event: RawInkPointerEvent,
  method: 'getCoalescedEvents' | 'getPredictedEvents',
): readonly RawInkPointerEvent[] {
  const fn = event[method];
  if (typeof fn !== 'function') return [];
  try {
    const list = (fn as () => unknown).call(event);
    if (!Array.isArray(list)) return [];
    // Browser event getters can yield holes/nulls; drop non-object entries
    // so one malformed sample never breaks the gesture.
    return (list as unknown[]).filter(
      (entry): entry is RawInkPointerEvent =>
        typeof entry === 'object' && entry !== null,
    );
  } catch {
    // A throwing event list must never break the gesture.
    return [];
  }
}

function normalizeOne(
  raw: RawInkPointerEvent,
  rect: CanvasRect,
): NormalizedPointerEvent | null {
  // Malformed entries (null holes, missing coords) are dropped, never
  // thrown — the engine must not get stuck on browser quirks.
  if (typeof raw !== 'object' || raw === null) return null;
  if (
    typeof raw.clientX !== 'number' ||
    typeof raw.clientY !== 'number' ||
    !Number.isFinite(raw.clientX) ||
    !Number.isFinite(raw.clientY)
  ) {
    return null;
  }
  const normalized = normalizePointerAxes(viewPointFromRect(raw, rect), {
    ...(typeof raw.pressure === 'number' ? { pressure: raw.pressure } : {}),
    ...(typeof raw.tiltX === 'number' ? { tiltX: raw.tiltX } : {}),
    ...(typeof raw.tiltY === 'number' ? { tiltY: raw.tiltY } : {}),
    ...(typeof raw.twist === 'number' ? { twist: raw.twist } : {}),
    ...(typeof raw.twistAngle === 'number'
      ? { twistAngle: raw.twistAngle }
      : {}),
  });
  const time =
    typeof raw.timeStamp === 'number' && Number.isFinite(raw.timeStamp)
      ? raw.timeStamp
      : null;
  return {
    point: normalized.point,
    ...(typeof raw.shiftKey === 'boolean' ? { shift: raw.shiftKey } : {}),
    ...(normalized.pressure !== undefined
      ? { pressure: normalized.pressure }
      : {}),
    ...(normalized.tilt !== undefined ? { tilt: normalized.tilt } : {}),
    ...(normalized.twist !== undefined ? { twist: normalized.twist } : {}),
    // Absent timing stays absent ("no data", never zero) so capture omits dt.
    ...(time !== null ? { time } : {}),
  };
}

function tiltEquals(
  a: NormalizedPointerEvent['tilt'],
  b: NormalizedPointerEvent['tilt'],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y;
}

function sameSample(
  a: NormalizedPointerEvent,
  b: NormalizedPointerEvent,
): boolean {
  // Time is deliberately excluded: stationary repeats carry no new
  // information even when the clock advanced between them.
  return (
    a.point.x === b.point.x &&
    a.point.y === b.point.y &&
    a.pressure === b.pressure &&
    tiltEquals(a.tilt, b.tilt) &&
    a.twist === b.twist
  );
}

function dedup(
  samples: readonly NormalizedPointerEvent[],
): NormalizedPointerEvent[] {
  const out: NormalizedPointerEvent[] = [];
  for (const sample of samples) {
    const last = out[out.length - 1];
    if (last !== undefined && sameSample(last, sample)) continue;
    out.push(sample);
  }
  return out;
}

/**
 * Normalize a single event (down/up paths) against an already-read rect.
 * Malformed input yields null so callers can drop it without getting stuck.
 */
export function normalizeInkPointerEvent(
  event: RawInkPointerEvent,
  rect: CanvasRect,
): NormalizedPointerEvent | null {
  return normalizeOne(event, rect);
}

function compact(
  samples: readonly (NormalizedPointerEvent | null)[],
): NormalizedPointerEvent[] {
  return samples.filter(
    (sample): sample is NormalizedPointerEvent => sample !== null,
  );
}

/**
 * Normalize one incoming pointer event into a confirmed/predicted batch.
 * `rect` must be the canvas box read once by the caller for this event —
 * this function never touches layout itself.
 */
export function normalizeInkInputBatch(
  event: RawInkPointerEvent,
  rect: CanvasRect,
): InkInputBatch {
  const coalesced = rawList(event, 'getCoalescedEvents');
  // The parent is a processed summary, not an additional contact sample.
  // Appending it can jump back across a curve when its position differs
  // from the last coalesced sample (Pointer Events §9.1).
  const contacts = compact(coalesced.map((raw) => normalizeOne(raw, rect)));
  return {
    confirmed: dedup(
      contacts.length > 0 ? contacts : compact([normalizeOne(event, rect)]),
    ),
    predicted: dedup(
      compact(
        rawList(event, 'getPredictedEvents').map((raw) =>
          normalizeOne(raw, rect),
        ),
      ),
    ),
  };
}

/**
 * Normalize a gesture-ending PointerEvent without treating the outer
 * pointerup pressure reset as a final contact sample. Coalesced entries are
 * still real contact data (including pressure 0) and stay untouched. When
 * the outer event has no positive pressure, it inherits the latest contact
 * axes; a stationary lift then deduplicates, while a lift-only coordinate
 * still closes the stroke without narrowing its tip.
 */
export function normalizeInkPointerUpBatch(
  event: RawInkPointerEvent,
  rect: CanvasRect,
  previous: NormalizedPointerEvent | null,
): InkInputBatch {
  const coalesced = compact(
    rawList(event, 'getCoalescedEvents').map((raw) => normalizeOne(raw, rect)),
  );
  let release = normalizeOne(event, rect);
  const contact = coalesced[coalesced.length - 1] ?? previous;
  const hasPositiveReleasePressure =
    typeof event.pressure === 'number' &&
    Number.isFinite(event.pressure) &&
    event.pressure > 0;
  if (
    release !== null &&
    contact !== undefined &&
    contact !== null &&
    !hasPositiveReleasePressure
  ) {
    release = {
      point: release.point,
      ...(release.shift !== undefined ? { shift: release.shift } : {}),
      ...(contact.pressure !== undefined ? { pressure: contact.pressure } : {}),
      ...(contact.tilt !== undefined ? { tilt: { ...contact.tilt } } : {}),
      ...(contact.twist !== undefined ? { twist: contact.twist } : {}),
      ...(release.time !== undefined ? { time: release.time } : {}),
    };
  }
  const stream = [...coalesced, ...(release === null ? [] : [release])];
  const confirmed =
    previous === null ? dedup(stream) : dedup([previous, ...stream]).slice(1);
  return { confirmed, predicted: [] };
}
