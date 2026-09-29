/** Canonical eraser footprints; stroke geometry remains derived from its source. */
import polygonClipping from 'polygon-clipping';
import { subtractContours, contoursTouch } from './contour-subtraction.js';
import { FroglightError } from '../../errors.js';
import {
  pointSegmentDistance,
  segmentSegmentDistance,
  type Point,
} from '../geometry.js';

/** Polygons contain an outer ring followed by any holes. */
export type InkErasure = readonly (readonly (readonly Point[])[])[];

export const MAX_ERASURE_VERTICES = 20_000;
export const ERASURE_SAGITTA = 0.025;
// Independent of model.ts: model validation imports this module.
const MAX_COORDINATE = 1e9;

type ClipGeometry = Parameters<typeof polygonClipping.union>[0];

// Keep polygon topology alongside renderer-facing contours. Holes must not
// become independent filled rings when the next eraser batch reuses them.
const polygonTopology = new WeakMap<
  readonly (readonly Point[])[],
  ReturnType<typeof polygonClipping.union>
>();
function contoursOf(
  polygons: ReturnType<typeof polygonClipping.union>,
): Point[][] {
  const contours = fromClip(polygons).flat();
  polygonTopology.set(contours, polygons);
  return contours;
}

function finitePoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Partial<Point>;
  return (
    typeof point.x === 'number' &&
    Number.isFinite(point.x) &&
    Math.abs(point.x) <= MAX_COORDINATE &&
    typeof point.y === 'number' &&
    Number.isFinite(point.y) &&
    Math.abs(point.y) <= MAX_COORDINATE
  );
}

/** Structural and resource validation; never repairs or discards invalid masks. */
export function validErasure(value: unknown): value is InkErasure {
  if (!Array.isArray(value)) return false;
  let vertices = 0;
  for (const polygon of value) {
    if (!Array.isArray(polygon) || polygon.length === 0) return false;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 3) return false;
      vertices += ring.length;
      if (vertices > MAX_ERASURE_VERTICES || !ring.every(finitePoint))
        return false;
    }
  }
  return true;
}

function assertErasure(erasure: InkErasure): void {
  if (!validErasure(erasure)) {
    throw new FroglightError(
      'FORMAT_LIMIT_EXCEEDED',
      'Ink erasure must contain finite bounded polygons with at most 20000 vertices',
    );
  }
}

function toClip(erasure: InkErasure): ClipGeometry {
  return erasure.map((polygon) =>
    polygon.map((ring) =>
      ring.map((point): [number, number] => [point.x, point.y]),
    ),
  );
}

function fromClip(
  result: ReturnType<typeof polygonClipping.union>,
): Point[][][] {
  return result.map((polygon) =>
    polygon.map((ring) => ring.map(([x, y]) => ({ x, y }))),
  );
}

// The sweep-line boolean library throws `Unable to find segment ...` on
// near-coincident edges (overlapping capsule chains at large coordinates).
// Those inputs must never crash an eraser gesture: every call below retries
// once on a welded grid, then falls back to an un-normalized accumulation.
const CLIP_SNAP = 1e9;
/** Existing clipping coordinates; shared with persisted source-boundary references. */
export function snapInkBoundaryPoint(p: Point): Point {
  return {
    x: Math.round(p.x * CLIP_SNAP) / CLIP_SNAP,
    y: Math.round(p.y * CLIP_SNAP) / CLIP_SNAP,
  };
}

function snapClipGeometry(geom: ClipGeometry): ClipGeometry {
  const multi = (typeof (geom as unknown as [unknown][][][])[0]?.[0]?.[0] ===
  'number'
    ? [geom]
    : geom) as unknown as [number, number][][][];
  const out: [number, number][][][] = [];
  for (const polygon of multi) {
    const rings: [number, number][][] = [];
    for (const ring of polygon) {
      const cleaned: [number, number][] = [];
      for (const point of ring) {
        const [x, y] = point;
        const sx = Math.round(x * CLIP_SNAP) / CLIP_SNAP;
        const sy = Math.round(y * CLIP_SNAP) / CLIP_SNAP;
        const last = cleaned[cleaned.length - 1];
        if (last === undefined || last[0] !== sx || last[1] !== sy)
          cleaned.push([sx, sy]);
      }
      if (cleaned.length > 1) {
        const first = cleaned[0]!;
        const last = cleaned[cleaned.length - 1]!;
        if (first[0] === last[0] && first[1] === last[1]) cleaned.pop();
      }
      if (cleaned.length >= 3) rings.push(cleaned);
    }
    if (rings.length > 0) out.push(rings);
  }
  return out as ClipGeometry;
}

type ClipResult = ReturnType<typeof polygonClipping.union>;

function safeUnionOne(geom: ClipGeometry): ClipResult | null {
  if (geom.length === 0) return [];
  try {
    return polygonClipping.union(geom);
  } catch {
    try {
      const snapped = snapClipGeometry(geom);
      return snapped.length === 0 ? [] : polygonClipping.union(snapped);
    } catch {
      return null;
    }
  }
}

function safeUnionTwo(a: ClipGeometry, b: ClipGeometry): ClipResult | null {
  if (a.length === 0) return safeUnionOne(b);
  if (b.length === 0) return safeUnionOne(a);
  try {
    return polygonClipping.union(a, b);
  } catch {
    try {
      const sa = snapClipGeometry(a);
      const sb = snapClipGeometry(b);
      if (sa.length === 0) return safeUnionOne(sb);
      if (sb.length === 0) return safeUnionOne(sa);
      return polygonClipping.union(sa, sb);
    } catch {
      return null;
    }
  }
}

function safeDifferenceTwo(
  a: ClipGeometry,
  b: ClipGeometry,
): ClipResult | null {
  if (a.length === 0 || b.length === 0) return a as unknown as ClipResult;
  try {
    return polygonClipping.difference(a, b);
  } catch {
    try {
      const sa = snapClipGeometry(a);
      const sb = snapClipGeometry(b);
      if (sa.length === 0 || sb.length === 0)
        return (sa.length === 0 ? [] : sa) as unknown as ClipResult;
      return polygonClipping.difference(sa, sb);
    } catch {
      return null;
    }
  }
}

function safeIntersectionTwo(
  a: ClipGeometry,
  b: ClipGeometry,
): ClipResult | null {
  if (a.length === 0 || b.length === 0) return [];
  try {
    return polygonClipping.intersection(a, b);
  } catch {
    try {
      const sa = snapClipGeometry(a);
      const sb = snapClipGeometry(b);
      if (sa.length === 0 || sb.length === 0) return [];
      return polygonClipping.intersection(sa, sb);
    } catch {
      return null;
    }
  }
}

interface ClipBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bboxOfClipPolygon(
  polygon: readonly (readonly (readonly number[])[])[],
): ClipBBox | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const ring of polygon)
    for (const point of ring) {
      const x = point[0]!;
      const y = point[1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function bboxOverlaps(a: ClipBBox, b: ClipBBox): boolean {
  return !(
    a.maxX < b.minX ||
    b.maxX < a.minX ||
    a.maxY < b.minY ||
    b.maxY < a.minY
  );
}

function bboxOfPointRing(ring: readonly Point[]): ClipBBox | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

// Conservative overlap scan over mask groups (one polygon per group, holes
// included): a bbox hit only selects the sequential path, which stays
// correct. Sorted by minX so disjoint histories scan in O(G log G).
function maskGroupsOverlap(
  groups: readonly (readonly (readonly Point[])[])[],
): boolean {
  const boxes: ClipBBox[] = [];
  for (const rings of groups) {
    let group: ClipBBox | null = null;
    for (const ring of rings) {
      const box = bboxOfPointRing(ring);
      if (box === null) continue;
      group =
        group === null
          ? { ...box }
          : {
              minX: Math.min(group.minX, box.minX),
              minY: Math.min(group.minY, box.minY),
              maxX: Math.max(group.maxX, box.maxX),
              maxY: Math.max(group.maxY, box.maxY),
            };
    }
    if (group !== null) boxes.push(group);
  }
  boxes.sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (let j = i + 1; j < boxes.length && boxes[j]!.minX <= a.maxX; j++)
      if (bboxOverlaps(a, boxes[j]!)) return true;
  }
  return false;
}

function snapPointRing(ring: readonly Point[]): Point[] {
  return ring.map(snapInkBoundaryPoint);
}

// One mask polygon at a time: overlapping mask polygons would leave spurious
// islands in a single graph (their interior arcs never cancel), while one
// polygon per pass matches the union semantics exactly. Holes always travel
// with their outer ring inside the same pass.
function subtractGroupsSequentially(
  visible: readonly (readonly Point[])[],
  groups: readonly (readonly (readonly Point[])[])[],
): { contours: Point[][]; changed: boolean } | null {
  let current = visible;
  let changed = false;
  for (const rings of groups) {
    if (rings.length === 0) continue;
    let step = subtractContours(current, rings);
    if (step === null) {
      step = subtractContours(
        current.map(snapPointRing),
        rings.map(snapPointRing),
      );
      if (step === null) return null;
    }
    if (step.changed) {
      changed = true;
      current = step.contours;
    }
  }
  return { contours: current as Point[][], changed };
}

// Local subtraction over a mask, correct for overlapping polygons without
// any sweep-line boolean. A welded retry resolves most ambiguous junctions;
// persistent ambiguity returns null for the exact-boolean fallback.
function subtractMaskGroups(
  visible: readonly (readonly Point[])[],
  groups: readonly (readonly (readonly Point[])[])[],
): { contours: Point[][]; changed: boolean } | null {
  const flat = groups.flatMap((rings) => [...rings]);
  if (flat.length === 0)
    return {
      contours: visible.map((ring) => [...ring]),
      changed: false,
    };
  if (!maskGroupsOverlap(groups)) {
    const direct = subtractContours(visible, flat);
    if (direct !== null) return direct;
    return subtractContours(
      visible.map(snapPointRing),
      flat.map(snapPointRing),
    );
  }
  return subtractGroupsSequentially(visible, groups);
}

// Consecutive strokes in one eraser batch share identical footprint objects
// (rotation-free fast path in tools.ts). Reuse the cut union instead of
// sweeping the same capsules once per stacked line.
let lastCutFootprints: readonly (readonly Point[])[] | null = null;
let lastCutGeometry: ClipResult | null = null;

function cachedCutUnion(
  footprints: readonly (readonly Point[])[],
): ClipResult | null {
  const cached = lastCutFootprints;
  if (
    cached !== null &&
    lastCutGeometry !== null &&
    cached.length === footprints.length &&
    cached.every((ring, i) => ring === footprints[i])
  )
    return lastCutGeometry;
  return null;
}

function unionCutGeometry(
  footprints: readonly (readonly Point[])[],
  cut: InkErasure,
): ClipResult {
  const cached = cachedCutUnion(footprints);
  if (cached !== null) return cached;
  const unioned = safeUnionOne(toClip(cut));
  // An un-normalized concatenation covers the same area; the subtraction
  // below switches to one polygon per pass when those polygons overlap.
  const geometry = unioned ?? (toClip(cut) as unknown as ClipResult);
  lastCutFootprints = footprints;
  lastCutGeometry = geometry;
  return geometry;
}

// Union only the erasure polygons that can interact with the cut. Distant
// masks concatenate verbatim, so per-batch cost stays local to the stroke
// instead of rescanning the whole erasure history. Bbox separation is exact:
// disjoint boxes cannot intersect, so concatenation equals the union.
function unionErasureWithCut(
  erasureGeom: ClipResult,
  cutGeometry: ClipResult,
): ClipResult | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const polygon of cutGeometry) {
    const box = bboxOfClipPolygon(polygon);
    if (box === null) continue;
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  if (minX === Infinity) return erasureGeom as unknown as ClipResult;
  // Transitive bbox closure around the cut: unioning this set in one pass
  // leaves every remaining polygon truly disjoint from the result, so the
  // stored concatenation can never hold overlapping rings. The closure is a
  // sound superset (real overlap always overlaps boxes) computed on boxes.
  const combinedBox: ClipBBox = { minX, minY, maxX, maxY };
  const boxes = erasureGeom.map(bboxOfClipPolygon);
  const accepted = new Array<boolean>(erasureGeom.length).fill(false);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < erasureGeom.length; i++) {
      if (accepted[i]) continue;
      const box = boxes[i];
      if (box !== null && bboxOverlaps(box, combinedBox)) {
        accepted[i] = true;
        grew = true;
        if (box.minX < combinedBox.minX) combinedBox.minX = box.minX;
        if (box.minY < combinedBox.minY) combinedBox.minY = box.minY;
        if (box.maxX > combinedBox.maxX) combinedBox.maxX = box.maxX;
        if (box.maxY > combinedBox.maxY) combinedBox.maxY = box.maxY;
      }
    }
  }
  const overlapping: ClipResult[number][] = [];
  const disjoint: ClipResult[number][] = [];
  for (let i = 0; i < erasureGeom.length; i++) {
    const polygon = erasureGeom[i]!;
    if (accepted[i]) overlapping.push(polygon);
    else disjoint.push(polygon);
  }
  let combined: ClipResult | null;
  if (overlapping.length === 0)
    combined = [...disjoint, ...cutGeometry] as unknown as ClipResult;
  else {
    const merged = safeUnionTwo(
      overlapping as unknown as ClipGeometry,
      cutGeometry as unknown as ClipGeometry,
    );
    if (merged === null) return null;
    combined = [...disjoint, ...merged] as unknown as ClipResult;
  }
  // Near-cap histories still normalize through the full union so the vertex
  // cap applies to the union output exactly as before (closed rings gain one
  // vertex each). Far from the cap the partitioned concatenation is stored.
  let vertices = 0,
    rings = 0;
  for (const polygon of combined)
    for (const ring of polygon) {
      vertices += ring.length;
      rings += 1;
    }
  if (vertices + rings <= MAX_ERASURE_VERTICES) return combined;
  return safeUnionTwo(
    erasureGeom as unknown as ClipGeometry,
    cutGeometry as unknown as ClipGeometry,
  );
}

/** Never throws sweep-line errors; validation errors still propagate. */
function safeRebuildContours(
  outline: readonly Point[],
  erasure: InkErasure,
): Point[][] | null {
  try {
    return erasureContours(outline, erasure);
  } catch (error) {
    if (error instanceof FroglightError) throw error;
    return null;
  }
}

function signedArea(ring: readonly Point[]): number {
  const origin = ring[0];
  if (origin === undefined) return 0;
  return ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return (
      sum +
      (p.x - origin.x) * (q.y - origin.y) -
      (q.x - origin.x) * (p.y - origin.y)
    );
  }, 0);
}

function maskGroups(erasure: InkErasure): Point[][][] {
  return erasure.map((polygon) =>
    polygon.map((ring, index) => {
      const points = [...ring];
      if (signedArea(points) < 0 !== index > 0) points.reverse();
      return points;
    }),
  );
}

function rememberTopology(contours: Point[][]): Point[][] {
  const polarity =
    Math.sign(contours.reduce((sum, ring) => sum + signedArea(ring), 0)) || 1;
  const outers = contours.filter((r) => signedArea(r) * polarity > 0);
  const holes = contours.filter((r) => signedArea(r) * polarity < 0);
  const polygons = outers.map((r) => [r]);
  for (const hole of holes) {
    const containing = polygons.filter((p) => pointVisible([p[0]!], hole[0]!));
    containing.sort(
      (a, b) => Math.abs(signedArea(a[0]!)) - Math.abs(signedArea(b[0]!)),
    );
    containing[0]?.push(hole);
  }
  polygonTopology.set(
    contours,
    toClip(polygons) as ReturnType<typeof polygonClipping.union>,
  );
  return contours;
}

/** Retained contours use nonzero winding: holes have opposite orientation. */
export function erasureContours(
  outline: readonly Point[],
  erasure: InkErasure = [],
): Point[][] {
  assertErasure(erasure);
  if (!outline.every(finitePoint))
    throw new FroglightError(
      'FORMAT_LIMIT_EXCEEDED',
      'Ink outline has invalid coordinates',
    );
  if (outline.length < 3) return [];
  const result = subtractMaskGroups([outline], maskGroups(erasure));
  if (result !== null) return rememberTopology(result.contours);
  const exact = safeDifferenceTwo(
    [outline.map((p) => [p.x, p.y] as [number, number])],
    toClip(erasure),
  );
  // A failed rebuild must never substitute unerased source ink.
  if (exact === null)
    throw new FroglightError(
      'IO',
      'Ink erasure geometry could not be rebuilt; source ink was not substituted',
    );
  return contoursOf(exact);
}

/**
 * Union one tool footprint, only when it removes currently visible ink.
 * Nothing aliases or mutates the inputs. The stored union is the tool footprint,
 * not an intersection with the current derived stroke outline.
 */
export function addErasure(
  outline: readonly Point[],
  current: InkErasure | undefined,
  footprint: readonly Point[],
): { erasure: InkErasure; contours: Point[][]; changed: boolean } {
  return addErasureBatch(outline, current, [footprint]);
}

/** Subtract a confirmed input batch with one boolean pass over the source. */
export function addErasureBatch(
  outline: readonly Point[],
  current: InkErasure | undefined,
  footprints: readonly (readonly Point[])[],
  previousContours?: readonly (readonly Point[])[],
  baseRegion?: InkErasure,
): { erasure: InkErasure; contours: Point[][]; changed: boolean } {
  const erasure = current ?? [];
  assertErasure(erasure);
  const cut: InkErasure = footprints.map((footprint) => [footprint]);
  for (const polygon of cut) assertErasure([polygon]);
  // Shared across stacked strokes in one batch; falls back to the same
  // covered area without normalization when the sweep line fails.
  const cutGeometry = unionCutGeometry(footprints, cut);
  const visible =
    previousContours ??
    (baseRegion === undefined
      ? erasureContours(outline, erasure)
      : erasureRegionContours(baseRegion, erasure));
  // Already covered tool areas are a no-op, including shared boundary edges.
  // An undecidable difference stays conservative and keeps subtracting.
  let uncovered: ClipResult | null = cutGeometry;
  if (erasure.length > 0) {
    uncovered = safeDifferenceTwo(
      cutGeometry as unknown as ClipGeometry,
      toClip(erasure),
    );
    if (uncovered !== null && uncovered.length === 0)
      return { erasure, contours: visible as Point[][], changed: false };
  }
  const result = subtractMaskGroups(visible, fromClip(cutGeometry));
  // Shared boundaries with earlier cuts can make the incremental graph
  // ambiguous. Test only the newly exposed cut against the original outline
  // before falling back to a sweep over the entire fitted stroke.
  const contact =
    result === null && uncovered !== null
      ? subtractMaskGroups(
          baseRegion === undefined ? [outline] : baseRegion.flat(),
          fromClip(uncovered),
        )
      : null;
  if (contact !== null && !contact.changed)
    return { erasure, contours: visible as Point[][], changed: false };
  if (result === null && contact === null) {
    const source: ClipGeometry =
      baseRegion === undefined
        ? [outline.map((p) => [p.x, p.y] as [number, number])]
        : toClip(baseRegion);
    const exact =
      erasure.length === 0
        ? safeUnionOne(source)
        : safeDifferenceTwo(source, toClip(erasure));
    const contact =
      exact === null
        ? null
        : safeIntersectionTwo(
            exact as unknown as ClipGeometry,
            cutGeometry as unknown as ClipGeometry,
          );
    // Unknown contact preserves the confirmed erasure instead of dropping it.
    if (contact !== null && contact.length === 0)
      return { erasure, contours: visible as Point[][], changed: false };
  } else if (result !== null && !result.changed)
    return { erasure, contours: visible as Point[][], changed: false };
  let next: InkErasure;
  if (erasure.length === 0) {
    next = fromClip(cutGeometry);
  } else {
    const merged = unionErasureWithCut(
      toClip(erasure) as unknown as ClipResult,
      cutGeometry,
    );
    // Concatenation keeps the same covered area when the union fails.
    next = fromClip(
      merged ?? ([...toClip(erasure), ...cutGeometry] as unknown as ClipResult),
    );
  }
  assertErasure(next);
  if (result !== null)
    return {
      erasure: next,
      contours: rememberTopology(result.contours),
      changed: true,
    };
  // Rebuild from the gesture base as a final exact attempt. Failure leaves
  // canonical publication to the caller's rollback path.
  return {
    erasure: next,
    contours: (() => {
      const rebuilt =
        baseRegion === undefined
          ? safeRebuildContours(outline, next)
          : erasureRegionContours(baseRegion, next);
      if (rebuilt === null)
        throw new FroglightError(
          'IO',
          'Precision eraser geometry failed; prior content is retained',
        );
      return rebuilt;
    })(),
    changed: true,
  };
}

/** Inscribed disc/capsule approximation, with at most .025 units chord sagitta. */
export function capsuleFootprint(a: Point, b: Point, radius: number): Point[] {
  if (
    !finitePoint(a) ||
    !finitePoint(b) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    throw new FroglightError(
      'FORMAT_LIMIT_EXCEEDED',
      'Ink eraser requires finite coordinates and a positive radius',
    );
  }
  const maxAngle = 2 * Math.acos(Math.max(-1, 1 - ERASURE_SAGITTA / radius));
  const halfSteps = Math.max(6, Math.ceil(Math.PI / maxAngle));
  if (
    !Number.isFinite(halfSteps) ||
    (halfSteps + 1) * 2 > MAX_ERASURE_VERTICES
  ) {
    throw new FroglightError(
      'FORMAT_LIMIT_EXCEEDED',
      'Ink eraser footprint exceeds vertex limit',
    );
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  // Share exact tangent endpoints between both caps. Trigonometric
  // roundoff here creates near-coincident edges in overlapping sweeps.
  const nx = length === 0 ? 0 : -dy / length;
  const ny = length === 0 ? 1 : dx / length;
  const angle = Math.atan2(dy, dx);
  const ring: Point[] = [];
  for (let i = 0; i <= halfSteps; i++) {
    const theta = angle - Math.PI / 2 + (Math.PI * i) / halfSteps;
    ring.push(
      i === 0
        ? { x: b.x - radius * nx, y: b.y - radius * ny }
        : i === halfSteps
          ? { x: b.x + radius * nx, y: b.y + radius * ny }
          : {
              x: b.x + radius * Math.cos(theta),
              y: b.y + radius * Math.sin(theta),
            },
    );
  }
  for (let i = 0; i <= halfSteps; i++) {
    const theta = angle + Math.PI / 2 + (Math.PI * i) / halfSteps;
    if (length === 0 && i === 0) continue;
    ring.push(
      i === 0
        ? { x: a.x + radius * nx, y: a.y + radius * ny }
        : i === halfSteps
          ? { x: a.x - radius * nx, y: a.y - radius * ny }
          : {
              x: a.x + radius * Math.cos(theta),
              y: a.y + radius * Math.sin(theta),
            },
    );
  }
  assertErasure([[ring]]);
  return ring;
}

/** Nonzero winding over all outer and hole contours, including boundary hits. */
export function pointVisible(
  contours: readonly (readonly Point[])[],
  point: Point,
): boolean {
  if (!finitePoint(point)) return false;
  let winding = 0;
  for (const ring of contours) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const cross =
        (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y);
      if (
        cross === 0 &&
        point.x >= Math.min(a.x, b.x) &&
        point.x <= Math.max(a.x, b.x) &&
        point.y >= Math.min(a.y, b.y) &&
        point.y <= Math.max(a.y, b.y)
      )
        return true;
      if (a.y <= point.y && b.y > point.y && cross > 0) winding++;
      else if (a.y > point.y && b.y <= point.y && cross < 0) winding--;
    }
  }
  return winding !== 0;
}

/** Visible fill plus a tolerance around its actual boundary (including holes). */
export function hitVisible(
  contours: readonly (readonly Point[])[],
  point: Point,
  tolerance = 0,
): boolean {
  if (!finitePoint(point)) return false;
  if (pointVisible(contours, point)) return true;
  if (!Number.isFinite(tolerance) || tolerance <= 0) return false;
  for (const ring of contours) {
    for (let i = 0; i < ring.length; i++) {
      if (
        pointSegmentDistance(point, ring[i]!, ring[(i + 1) % ring.length]!) <=
        tolerance
      )
        return true;
    }
  }
  return false;
}

/** Pure swept hit-test; whole-stroke deletion never constructs a new mask. */
export function sweepHitsVisible(
  contours: readonly (readonly Point[])[],
  start: Point,
  end: Point,
  radius: number,
): boolean {
  if (
    !finitePoint(start) ||
    !finitePoint(end) ||
    !Number.isFinite(radius) ||
    radius < 0
  )
    return false;
  if (pointVisible(contours, start) || pointVisible(contours, end)) return true;
  for (const ring of contours) {
    for (let i = 0; i < ring.length; i++) {
      if (
        segmentSegmentDistance(
          start,
          end,
          ring[i]!,
          ring[(i + 1) % ring.length]!,
        ) <= radius
      )
        return true;
    }
  }
  return false;
}

function erasureRegionContours(base: InkErasure, mask: InkErasure): Point[][] {
  const result = subtractMaskGroups(base.flat(), maskGroups(mask));
  if (result !== null) return rememberTopology(result.contours);
  const exact = safeDifferenceTwo(toClip(base), toClip(mask));
  if (exact === null)
    throw new FroglightError(
      'IO',
      'Precision eraser draft could not be prepared',
    );
  return contoursOf(exact);
}

/** Canonical topology for an already fitted fill, preserving holes. */
export function regionOfContours(
  contours: readonly (readonly Point[])[],
): InkErasure {
  let topology = polygonTopology.get(contours);
  if (topology === undefined) {
    const owned = contours.map((ring) => [...ring]);
    rememberTopology(owned);
    topology = polygonTopology.get(owned)!;
  }
  const region = fromClip(topology);
  return region;
}

/** Worker preparation: normalize overlapping filled cycles and separate only connected fills. */
export function prepareInkRegion(region: InkErasure): InkErasure[] {
  // Subtraction already preserves polygon topology. Only overlapping outer
  // cycles need connectivity tests; never normalize the complete outline.
  const boxes = region.map((poly) => {
    let x = Infinity,
      y = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const p of poly[0]!) {
      x = Math.min(x, p.x);
      y = Math.min(y, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
    return { x, y, right, bottom };
  });
  const parent = region.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i]!;
    return i;
  };
  const sorted = region
    .map((_, i) => i)
    .sort((a, b) => boxes[a]!.x - boxes[b]!.x);
  for (let i = 0; i < sorted.length; i++) {
    const ai = sorted[i]!,
      a = boxes[ai]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const bi = sorted[j]!,
        b = boxes[bi]!;
      if (b.x > a.right) break;
      if (root(ai) === root(bi) || a.y > b.bottom || b.y > a.bottom) continue;
      const ap = region[ai]!,
        bp = region[bi]!;
      const connected =
        pointVisible(ap, bp[0]![0]!) ||
        pointVisible(bp, ap[0]![0]!) ||
        contoursTouch(ap, bp);
      if (connected) parent[root(bi)] = root(ai);
    }
  }
  const groups = new Map<number, InkErasure[number][]>();
  region.forEach((poly, i) => {
    const id = root(i),
      group = groups.get(id) ?? [];
    group.push(poly);
    groups.set(id, group);
  });
  return [...groups.values()];
}
