/**
 * Dense source evidence for intentional C0 corners.
 *
 * The fitted curve works on a brush-sized control grid (up to 3 surface
 * units). A smooth, tight bend can collapse to one large turn on that grid
 * and look exactly like a hard corner. This independent 0.5-unit arc grid
 * retains the captured turn distribution. A real corner keeps the same
 * angle when measured at 1 and 2 units; smooth curvature accumulates more
 * angle as the measurement radius grows.
 */

import type { Point } from '../geometry.js';

/** Fixed, brush-independent source grid (four screen pixels at 8x zoom). */
export const CORNER_EVIDENCE_SPACING = 0.5;
const INNER_RADIUS = 1;
const OUTER_RADIUS = 2;
const MIN_TURN = (60 * Math.PI) / 180;
const MAX_SCALE_EXPANSION = (11 * Math.PI) / 180;
const MAX_ARM_BEND = (25 * Math.PI) / 180;
const EPS = 1e-9;

function angleBetween(a: Point, b: Point): number {
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la < EPS || lb < EPS) return 0;
  const dot = Math.min(Math.max((a.x * b.x + a.y * b.y) / (la * lb), -1), 1);
  return Math.acos(dot);
}

function pointAtArc(
  grid: readonly Point[],
  totalArc: number,
  arc: number,
  startArc: number,
): Point | null {
  if (grid.length === 0 || arc < startArc - EPS || arc > totalArc + EPS) {
    return null;
  }
  if (grid.length === 1 || totalArc <= startArc + EPS) return grid[0] ?? null;
  const lastRegular = grid.length - 2;
  const regularEnd = startArc + lastRegular * CORNER_EVIDENCE_SPACING;
  if (arc <= regularEnd + EPS) {
    const local = Math.max(0, (arc - startArc) / CORNER_EVIDENCE_SPACING);
    const i = Math.min(Math.floor(local), lastRegular);
    if (i >= lastRegular) return grid[lastRegular] ?? null;
    const t = local - i;
    const a = grid[i]!;
    const b = grid[i + 1]!;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  const a = grid[lastRegular]!;
  const b = grid[grid.length - 1]!;
  const span = totalArc - regularEnd;
  const t =
    span > EPS ? Math.min(Math.max((arc - regularEnd) / span, 0), 1) : 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function stableCornerAt(
  grid: readonly Point[],
  totalArc: number,
  arc: number,
  startArc: number,
): boolean {
  const beforeOuter = pointAtArc(grid, totalArc, arc - OUTER_RADIUS, startArc);
  const beforeInner = pointAtArc(grid, totalArc, arc - INNER_RADIUS, startArc);
  const center = pointAtArc(grid, totalArc, arc, startArc);
  const afterInner = pointAtArc(grid, totalArc, arc + INNER_RADIUS, startArc);
  const afterOuter = pointAtArc(grid, totalArc, arc + OUTER_RADIUS, startArc);
  if (
    beforeOuter === null ||
    beforeInner === null ||
    center === null ||
    afterInner === null ||
    afterOuter === null
  ) {
    return false;
  }
  const incoming = {
    x: center.x - beforeInner.x,
    y: center.y - beforeInner.y,
  };
  const outgoing = {
    x: afterInner.x - center.x,
    y: afterInner.y - center.y,
  };
  const innerTurn = angleBetween(incoming, outgoing);
  if (innerTurn < MIN_TURN) return false;
  const outerTurn = angleBetween(
    { x: center.x - beforeOuter.x, y: center.y - beforeOuter.y },
    { x: afterOuter.x - center.x, y: afterOuter.y - center.y },
  );
  if (outerTurn - innerTurn > MAX_SCALE_EXPANSION) return false;
  const incomingArm = {
    x: beforeInner.x - beforeOuter.x,
    y: beforeInner.y - beforeOuter.y,
  };
  const outgoingArm = {
    x: afterOuter.x - afterInner.x,
    y: afterOuter.y - afterInner.y,
  };
  return (
    angleBetween(incomingArm, incoming) <= MAX_ARM_BEND &&
    angleBetween(outgoing, outgoingArm) <= MAX_ARM_BEND
  );
}

/**
 * Validate one coarse control-grid corner against dense source geometry.
 * Searches one coarse spacing around the control because an arc grid does
 * not generally land exactly on the captured apex. Work is bounded by the
 * maximum production control spacing (3 units) and the fixed 0.5-unit grid.
 */
export function hasSourceCornerEvidence(
  grid: readonly Point[],
  totalArc: number,
  controlIndex: number,
  controlSpacing: number,
  startArc = 0,
): boolean {
  if (grid.length < 5 || !Number.isFinite(totalArc) || totalArc <= 0) {
    return false;
  }
  const spacing =
    Number.isFinite(controlSpacing) && controlSpacing > 0 ? controlSpacing : 3;
  const target = Math.min(Math.max(controlIndex * spacing, startArc), totalArc);
  const first = Math.ceil(
    (Math.max(startArc + OUTER_RADIUS, target - spacing) - startArc) /
      CORNER_EVIDENCE_SPACING,
  );
  const last = Math.floor(
    (Math.min(totalArc - OUTER_RADIUS, target + spacing) - startArc) /
      CORNER_EVIDENCE_SPACING,
  );
  for (let i = first; i <= last; i++) {
    const arc = startArc + i * CORNER_EVIDENCE_SPACING;
    if (stableCornerAt(grid, totalArc, arc, startArc)) return true;
  }
  return false;
}

/** Arc length of a source observation polyline. */
export function sourceArcLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    );
  }
  return total;
}
