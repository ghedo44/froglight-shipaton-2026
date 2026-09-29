import { segmentSegmentDistance, type Point } from '../geometry.js';

interface Vertex extends Point {
  id: number;
}
interface Cut {
  t: number;
  p: Vertex;
}
interface Edge {
  a: Vertex;
  b: Vertex;
  cuts: Cut[];
  qmark: number;
}

// Spatial indexes below only skip provably non-interacting pairs; every
// candidate still runs the exact predicate. Small inputs keep brute force,
// so short strokes never pay index overhead.
const GRID_MIN_EDGES = 128;
const ROW_MIN_SEGMENTS = 256;
let spatialQueryId = 0;

interface ClipGrid {
  cells: Edge[][];
  minX: number;
  minY: number;
  cellW: number;
  cellH: number;
  nx: number;
  ny: number;
}

function buildClipGrid(
  clips: Edge[],
  left: number,
  top: number,
  right: number,
  bottom: number,
): ClipGrid | null {
  if (clips.length < GRID_MIN_EDGES) return null;
  const width = right - left,
    height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  const perSide = Math.min(
    256,
    Math.max(1, Math.ceil(Math.sqrt(clips.length / 4))),
  );
  const nx = perSide,
    ny = perSide,
    cellW = width / nx,
    cellH = height / ny;
  const cells: Edge[][] = Array.from({ length: nx * ny }, () => []);
  for (const f of clips) {
    const x0 = Math.min(f.a.x, f.b.x),
      x1 = Math.max(f.a.x, f.b.x),
      y0 = Math.min(f.a.y, f.b.y),
      y1 = Math.max(f.a.y, f.b.y);
    const cx0 = Math.max(0, Math.min(nx - 1, Math.floor((x0 - left) / cellW)));
    const cx1 = Math.max(0, Math.min(nx - 1, Math.floor((x1 - left) / cellW)));
    const cy0 = Math.max(0, Math.min(ny - 1, Math.floor((y0 - top) / cellH)));
    const cy1 = Math.max(0, Math.min(ny - 1, Math.floor((y1 - top) / cellH)));
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) cells[cy * nx + cx]!.push(f);
  }
  return { cells, minX: left, minY: top, cellW, cellH, nx, ny };
}

// Every bbox-overlapping pair shares a grid cell (their overlap region holds
// a point whose cell contains both boxes), so the returned set matches brute
// force exactly; the exact bbox test below still filters.
function queryClipGrid(
  grid: ClipGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Edge[],
): Edge[] {
  out.length = 0;
  const qid = ++spatialQueryId;
  const cx0 = Math.max(
    0,
    Math.min(grid.nx - 1, Math.floor((x0 - grid.minX) / grid.cellW)),
  );
  const cx1 = Math.max(
    0,
    Math.min(grid.nx - 1, Math.floor((x1 - grid.minX) / grid.cellW)),
  );
  const cy0 = Math.max(
    0,
    Math.min(grid.ny - 1, Math.floor((y0 - grid.minY) / grid.cellH)),
  );
  const cy1 = Math.max(
    0,
    Math.min(grid.ny - 1, Math.floor((y1 - grid.minY) / grid.cellH)),
  );
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++)
      for (const f of grid.cells[cy * grid.nx + cx]!) {
        if (f.qmark !== qid) {
          f.qmark = qid;
          out.push(f);
        }
      }
  return out;
}

interface RingSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

interface RowIndex {
  rows: RingSeg[][];
  minY: number;
  maxY: number;
  rowH: number;
}

function buildRowIndex(rings: readonly (readonly Point[])[]): RowIndex | null {
  let total = 0;
  for (const ring of rings) total += ring.length;
  if (total < ROW_MIN_SEGMENTS) return null;
  let minY = Infinity,
    maxY = -Infinity;
  for (const ring of rings)
    for (const p of ring) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  // All horizontal: no edge can straddle, winding is always zero.
  if (!(maxY > minY)) return { rows: [], minY, maxY, rowH: 1 };
  const count = Math.min(512, Math.max(1, Math.ceil(Math.sqrt(total))));
  const rowH = (maxY - minY) / count;
  const rows: RingSeg[][] = Array.from({ length: count }, () => []);
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      const y0 = Math.min(a.y, b.y),
        y1 = Math.max(a.y, b.y);
      const r0 = Math.max(
        0,
        Math.min(count - 1, Math.floor((y0 - minY) / rowH)),
      );
      const r1 = Math.max(
        0,
        Math.min(count - 1, Math.floor((y1 - minY) / rowH)),
      );
      const seg = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
      for (let r = r0; r <= r1; r++) rows[r]!.push(seg);
    }
  return { rows, minY, maxY, rowH };
}

// Identical predicate to windingAt on the same rings: a straddling edge
// always lands in the queried row, and the exact test below decides.
function windingIndexed(index: RowIndex, p: Point): number {
  if (p.y < index.minY || p.y > index.maxY) return 0;
  const count = index.rows.length;
  if (count === 0) return 0;
  const row = Math.max(
    0,
    Math.min(count - 1, Math.floor((p.y - index.minY) / index.rowH)),
  );
  let winding = 0;
  for (const { ax, ay, bx, by } of index.rows[row]!) {
    if ((ay <= p.y && by <= p.y) || (ay > p.y && by > p.y)) continue;
    const cross = (bx - ax) * (p.y - ay) - (p.x - ax) * (by - ay);
    if (ay <= p.y && by > p.y && cross > 0) winding++;
    else if (ay > p.y && by <= p.y && cross < 0) winding--;
  }
  return winding;
}

/** Signed nonzero winding, with no boundary expansion. */
function windingAt(rings: readonly (readonly Point[])[], p: Point): number {
  let winding = 0;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      if ((a.y <= p.y && b.y <= p.y) || (a.y > p.y && b.y > p.y)) continue;
      const cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (a.y <= p.y && b.y > p.y && cross > 0) winding++;
      else if (a.y > p.y && b.y <= p.y && cross < 0) winding--;
    }
  return winding;
}

/** Subtract normalized mask rings from a nonzero source path. Only source/mask
 * crossings need arranging: distant source self-intersections and retraced
 * brush joins retain their original winding and coordinates verbatim.
 * Numerically ambiguous junctions return null for the exact boolean fallback;
 * never close an unbalanced graph with an invented chord.
 */
export function subtractContours(
  source: readonly (readonly Point[])[],
  mask: readonly (readonly Point[])[],
): { contours: Point[][]; changed: boolean } | null {
  if (mask.length === 0)
    return { contours: source.map((r) => [...r]), changed: false };
  if (
    !source.some((ring) => {
      const a = ring[0];
      if (a === undefined) return false;
      const b = ring.find((p) => p.x !== a.x || p.y !== a.y);
      return (
        b !== undefined &&
        ring.some(
          (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) !== 0,
        )
      );
    })
  )
    return { contours: [], changed: false };
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const ring of mask)
    for (const p of ring) {
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
  const outside = (a: Point, b: Point) =>
    Math.max(a.x, b.x) < left ||
    Math.min(a.x, b.x) > right ||
    Math.max(a.y, b.y) < top ||
    Math.min(a.y, b.y) > bottom;
  // Runs away from mask edges have constant winding: discard covered runs,
  // and carry visible ones through the graph without arranging every point.
  // Two unique waypoints keep distinct paths apart and prevent a closed run
  // from becoming two opposite links that cancel. Restore all points below.
  let removedRun = false;
  const preserved = new Map<number, readonly Point[]>();
  const untouched = new Set<Edge>();
  const vertices = new Map<string, Vertex>();
  let serial = 0;
  const vertex = (p: Point): Vertex => {
    // A crossing computed along a retraced edge can differ by a few ulps.
    // Weld at a billionth of a surface unit, retaining the first exact point.
    const key = `${Math.round(p.x * 1e9)},${Math.round(p.y * 1e9)}`;
    let v = vertices.get(key);
    if (v === undefined) {
      v = { ...p, id: serial++ };
      vertices.set(key, v);
    }
    return v;
  };
  const edgesOf = (
    rings: readonly (readonly Point[])[],
    compact = false,
  ): Edge[] => {
    const edges: Edge[] = [];
    const push = (a: Vertex, b: Vertex, distant = false) => {
      if (a.id === b.id) return;
      const edge: Edge = {
        a,
        b,
        cuts: [
          { t: 0, p: a },
          { t: 1, p: b },
        ],
        qmark: 0,
      };
      edges.push(edge);
      if (distant) untouched.add(edge);
    };
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        let end = i;
        if (compact) {
          while (
            end < ring.length &&
            awayFromBoundary(ring[end]!, ring[(end + 1) % ring.length]!)
          )
            end++;
        }
        if (end - i > 2) {
          const a = ring[i]!,
            b = ring[i + 1]!;
          if (windingMask({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) !== 0) {
            removedRun = true;
            i = end - 1;
            continue;
          }
          const waypoint: Vertex = { ...ring[i + 1]!, id: serial++ };
          vertices.set(`run:${waypoint.id}`, waypoint);
          const last: Vertex = { ...ring[end - 1]!, id: serial++ };
          vertices.set(`run:${last.id}`, last);
          preserved.set(waypoint.id, ring.slice(i + 1, end - 1));
          push(vertex(ring[i]!), waypoint, true);
          push(waypoint, last, true);
          push(last, vertex(ring[end % ring.length]!), true);
          i = end - 1;
        } else {
          push(vertex(ring[i]!), vertex(ring[(i + 1) % ring.length]!));
        }
      }
    }
    return edges;
  };
  const clips = edgesOf(mask);
  const cross = (ax: number, ay: number, bx: number, by: number) =>
    ax * by - ay * bx;
  const grid = buildClipGrid(clips, left, top, right, bottom);
  const scratch: Edge[] = [];
  // Indexed winding over the same rings: identical results, local cost.
  const maskRows = buildRowIndex(mask);
  const sourceRows = buildRowIndex(source);
  const windingMask = (p: Point): number =>
    maskRows !== null ? windingIndexed(maskRows, p) : windingAt(mask, p);
  const windingSource = (p: Point): number =>
    sourceRows !== null ? windingIndexed(sourceRows, p) : windingAt(source, p);
  const awayFromBoundary = (a: Point, b: Point): boolean => {
    if (outside(a, b)) return true;
    const x0 = Math.min(a.x, b.x),
      x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y),
      y1 = Math.max(a.y, b.y);
    const candidates =
      grid === null ? clips : queryClipGrid(grid, x0, y0, x1, y1, scratch);
    return !candidates.some(
      (edge) =>
        x1 >= Math.min(edge.a.x, edge.b.x) &&
        x0 <= Math.max(edge.a.x, edge.b.x) &&
        y1 >= Math.min(edge.a.y, edge.b.y) &&
        y0 <= Math.max(edge.a.y, edge.b.y),
    );
  };
  const subject = edgesOf(source, true);
  for (const e of subject.filter(
    (e) => !untouched.has(e) && !outside(e.a, e.b),
  )) {
    const candidates =
      grid !== null
        ? queryClipGrid(
            grid,
            Math.min(e.a.x, e.b.x),
            Math.min(e.a.y, e.b.y),
            Math.max(e.a.x, e.b.x),
            Math.max(e.a.y, e.b.y),
            scratch,
          )
        : clips;
    for (const f of candidates) {
      if (
        Math.max(e.a.x, e.b.x) < Math.min(f.a.x, f.b.x) ||
        Math.min(e.a.x, e.b.x) > Math.max(f.a.x, f.b.x) ||
        Math.max(e.a.y, e.b.y) < Math.min(f.a.y, f.b.y) ||
        Math.min(e.a.y, e.b.y) > Math.max(f.a.y, f.b.y)
      )
        continue;
      const dx = e.b.x - e.a.x,
        dy = e.b.y - e.a.y,
        ex = f.b.x - f.a.x,
        ey = f.b.y - f.a.y;
      const denominator = cross(dx, dy, ex, ey);
      if (denominator === 0) {
        if (cross(f.a.x - e.a.x, f.a.y - e.a.y, dx, dy) !== 0) continue;
        const add = (edge: Edge, p: Vertex) => {
          const x = edge.b.x - edge.a.x,
            y = edge.b.y - edge.a.y;
          const t =
            Math.abs(x) >= Math.abs(y)
              ? (p.x - edge.a.x) / x
              : (p.y - edge.a.y) / y;
          if (t > 0 && t < 1) edge.cuts.push({ t, p });
        };
        add(e, f.a);
        add(e, f.b);
        add(f, e.a);
        add(f, e.b);
        continue;
      }
      const rx = f.a.x - e.a.x,
        ry = f.a.y - e.a.y;
      const t = cross(rx, ry, ex, ey) / denominator,
        u = cross(rx, ry, dx, dy) / denominator;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const p =
        t === 0
          ? e.a
          : t === 1
            ? e.b
            : u === 0
              ? f.a
              : u === 1
                ? f.b
                : vertex({ x: e.a.x + t * dx, y: e.a.y + t * dy });
      e.cuts.push({ t, p });
      f.cuts.push({ t: u, p });
    }
  }
  const links = new Map<
    number,
    Map<number, { point: Vertex; count: number }>
  >();
  const append = (a: Vertex, b: Vertex) => {
    if (a.id === b.id) return;
    const reverse = links.get(b.id)?.get(a.id);
    if (reverse !== undefined && reverse.count > 0) {
      reverse.count--;
      return;
    }
    let list = links.get(a.id);
    if (list === undefined) {
      list = new Map();
      links.set(a.id, list);
    }
    const old = list.get(b.id);
    if (old === undefined) list.set(b.id, { point: b, count: 1 });
    else old.count++;
  };
  const onBoundary = (p: Point) => {
    const candidates =
      grid !== null ? queryClipGrid(grid, p.x, p.y, p.x, p.y, scratch) : clips;
    return candidates.some(({ a, b }) => {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        px = p.x - a.x,
        py = p.y - a.y;
      return (
        Math.abs(dx * py - dy * px) <=
          32 * Number.EPSILON * (Math.abs(dx * py) + Math.abs(dy * px)) &&
        p.x >= Math.min(a.x, b.x) &&
        p.x <= Math.max(a.x, b.x) &&
        p.y >= Math.min(a.y, b.y) &&
        p.y <= Math.max(a.y, b.y)
      );
    });
  };
  let changed = removedRun;
  const eachPart = (
    edges: Edge[],
    visit: (a: Vertex, b: Vertex, edge: Edge) => void,
  ) => {
    for (const edge of edges) {
      edge.cuts.sort((a, b) => a.t - b.t);
      for (let i = 1; i < edge.cuts.length; i++) {
        const a = edge.cuts[i - 1]!,
          b = edge.cuts[i]!;
        if (b.t <= a.t || a.p.id === b.p.id) continue;
        visit(a.p, b.p, edge);
      }
    }
  };
  eachPart(subject, (a, b, edge) => {
    if (untouched.has(edge) || outside(a, b)) {
      append(a, b);
      return;
    }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (onBoundary(mid) || windingMask(mid) === 0) append(a, b);
    else changed = true;
  });
  eachPart(clips, (a, b) => {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      length = Math.hypot(dx, dy);
    const epsilon = Math.min(
      length * 1e-6,
      Math.max(1, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) *
        Number.EPSILON *
        64,
    );
    const mid = {
      x: (a.x + b.x) / 2 - (dy / length) * epsilon,
      y: (a.y + b.y) / 2 + (dx / length) * epsilon,
    };
    const winding = windingSource(mid);
    if (winding !== 0) {
      changed = true;
      for (let i = 0; i < Math.abs(winding); i++) {
        if (winding > 0) append(b, a);
        else append(a, b);
      }
    }
  });
  if (!changed) return { contours: source.map((r) => [...r]), changed: false };
  const outgoing = new Map<number, Vertex[]>();
  for (const [id, edges] of links) {
    const points: Vertex[] = [];
    for (const edge of edges.values())
      for (let i = 0; i < edge.count; i++) points.push(edge.point);
    outgoing.set(id, points);
  }
  const balance = new Map<number, number>();
  for (const [id, points] of outgoing) {
    balance.set(id, (balance.get(id) ?? 0) + points.length);
    for (const p of points) balance.set(p.id, (balance.get(p.id) ?? 0) - 1);
  }
  if ([...balance.values()].some((n) => n !== 0)) return null;
  const contours: Point[][] = [];
  for (const start of vertices.values()) {
    if (!outgoing.get(start.id)?.length) continue;
    const stack = [start],
      path: Vertex[] = [];
    while (stack.length) {
      const current = stack[stack.length - 1]!;
      const next = outgoing.get(current.id)?.pop();
      if (next !== undefined) stack.push(next);
      else path.push(stack.pop()!);
    }
    path.reverse();
    if (path.length >= 3) {
      const ring: Point[] = [];
      // Exclude the closing graph vertex before expanding a preserved run.
      for (let i = 0; i < path.length - 1; i++) {
        const point = path[i]!;
        for (const { x, y } of preserved.get(point.id) ?? [point]) {
          const last = ring[ring.length - 1];
          if (last === undefined || last.x !== x || last.y !== y)
            ring.push({ x, y });
        }
      }
      if (
        ring[ring.length - 1]!.x !== ring[0]!.x ||
        ring[ring.length - 1]!.y !== ring[0]!.y
      )
        ring.push(ring[0]!);
      const a = ring[0]!,
        b = ring.find((p) => p.x !== a.x || p.y !== a.y);
      if (
        b !== undefined &&
        ring.some(
          (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) !== 0,
        )
      )
        contours.push(ring);
    }
  }
  // Canonical starting vertices/order keep rebuilt and incremental paths stable.
  const ordered = contours
    .map((ring) => {
      if (
        ring[0]!.x === ring[ring.length - 1]!.x &&
        ring[0]!.y === ring[ring.length - 1]!.y
      )
        ring.pop();
      let first = 0;
      for (let i = 1; i < ring.length; i++)
        if (
          ring[i]!.x < ring[first]!.x ||
          (ring[i]!.x === ring[first]!.x && ring[i]!.y < ring[first]!.y)
        )
          first = i;
      const out = [...ring.slice(first), ...ring.slice(0, first)];
      out.push(out[0]!);
      return out;
    })
    .sort((a, b) => a[0]!.x - b[0]!.x || a[0]!.y - b[0]!.y);
  return { contours: ordered, changed: true };
}

/** Exact boundary connectivity using the same edge grid as contour subtraction. */
export function contoursTouch(
  a: readonly (readonly Point[])[],
  b: readonly (readonly Point[])[],
): boolean {
  const edges = (rings: readonly (readonly Point[])[]): Edge[] =>
    rings.flatMap((ring) =>
      ring.map((p, i) => ({
        a: { ...p, id: i },
        b: { ...ring[(i + 1) % ring.length]!, id: i + 1 },
        cuts: [],
        qmark: 0,
      })),
    );
  const clips = edges(b);
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const edge of clips) {
    left = Math.min(left, edge.a.x);
    top = Math.min(top, edge.a.y);
    right = Math.max(right, edge.a.x);
    bottom = Math.max(bottom, edge.a.y);
  }
  const grid = buildClipGrid(clips, left, top, right, bottom);
  const candidates: Edge[] = [];
  for (const edge of edges(a)) {
    const x0 = Math.min(edge.a.x, edge.b.x),
      x1 = Math.max(edge.a.x, edge.b.x),
      y0 = Math.min(edge.a.y, edge.b.y),
      y1 = Math.max(edge.a.y, edge.b.y);
    if (x1 < left || x0 > right || y1 < top || y0 > bottom) continue;
    const possible =
      grid === null ? clips : queryClipGrid(grid, x0, y0, x1, y1, candidates);
    for (const clip of possible) {
      if (
        x1 < Math.min(clip.a.x, clip.b.x) ||
        Math.max(clip.a.x, clip.b.x) < x0 ||
        y1 < Math.min(clip.a.y, clip.b.y) ||
        Math.max(clip.a.y, clip.b.y) < y0
      )
        continue;
      if (segmentSegmentDistance(edge.a, edge.b, clip.a, clip.b) <= 1e-9)
        return true;
    }
  }
  return false;
}
