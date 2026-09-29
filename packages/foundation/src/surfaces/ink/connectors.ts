/**
 * True connectors (slice 9, whiteboard): deterministic endpoint routing
 * plus binding reconciliation against live object bounds. Bindings name
 * an object and an envelope anchor; endpoint coordinates stay the
 * rendered truth and are rewritten when bound objects move. Dangling
 * bindings resolve as free (last coords win) and round-trip verbatim —
 * deletion never cascades. Headless and deterministic.
 */

import {
  SURFACE_OBJECT_TYPES,
  type ConnectorAnchor,
  type ConnectorPath,
  type SurfaceModel,
  type SurfaceObjectId,
  type SurfaceObjectRecord,
} from '../model.js';
import type { Bounds, Point } from '../geometry.js';
import type { SurfaceObjectTypeRegistry } from '../registry.js';

/** Resolve a named anchor on envelope bounds. */
export function anchorPoint(bounds: Bounds, anchor: ConnectorAnchor): Point {
  switch (anchor) {
    case 'n':
      return { x: bounds.x + bounds.width / 2, y: bounds.y };
    case 's':
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height,
      };
    case 'e':
      return {
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height / 2,
      };
    case 'w':
      return { x: bounds.x, y: bounds.y + bounds.height / 2 };
    case 'center':
    default:
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
  }
}

const CURVE_SEGMENTS = 16;
/** Quadratic bulge as a fraction of endpoint distance. */
const CURVE_BULGE = 0.2;

/**
 * Route a connector between endpoints: straight passthrough, an
 * orthogonal elbow with a horizontal lead, or a quadratic curve bulging
 * perpendicular. Coincident endpoints degrade to a doubled point.
 */
export function routeConnector(
  a: Point,
  b: Point,
  path: ConnectorPath,
): Point[] {
  if (
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y)
  ) {
    return [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
  }
  if (path === 'straight') return [{ ...a }, { ...b }];
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1e-9) return [{ ...a }, { ...b }];
  if (path === 'orthogonal') {
    const midX = (a.x + b.x) / 2;
    return [{ ...a }, { x: midX, y: a.y }, { x: midX, y: b.y }, { ...b }];
  }
  // Curved: quadratic Bézier, control pushed perpendicular to travel.
  const dx = (b.x - a.x) / length;
  const dy = (b.y - a.y) / length;
  const cx = (a.x + b.x) / 2 - dy * length * CURVE_BULGE;
  const cy = (a.y + b.y) / 2 + dx * length * CURVE_BULGE;
  const route: Point[] = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const u = 1 - t;
    route.push({
      x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
      y: u * u * a.y + 2 * u * t * cy + t * t * b.y,
    });
  }
  return route;
}

function readBinding(
  record: SurfaceObjectRecord,
  key: 'source' | 'target',
): { objectId: SurfaceObjectId; anchor: ConnectorAnchor } | null {
  const raw = record[key];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const binding = raw as Record<string, unknown>;
  if (
    typeof binding.objectId !== 'string' ||
    binding.objectId === '' ||
    (binding.anchor !== 'center' &&
      binding.anchor !== 'n' &&
      binding.anchor !== 's' &&
      binding.anchor !== 'e' &&
      binding.anchor !== 'w')
  ) {
    return null;
  }
  return {
    objectId: binding.objectId,
    anchor: binding.anchor as ConnectorAnchor,
  };
}
/**
 * Resolve one bound anchor to a surface-space point: the target type's
 * `connectorAnchor` hook when present (rotation-aware, repair pass item
 * 10), else the unrotated envelope anchor. Null when the target is
 * missing or has no anchorable geometry (dangling bindings resolve as
 * free elsewhere — never here).
 */
export function resolveConnectorAnchor(
  target: SurfaceObjectRecord,
  anchor: ConnectorAnchor,
  registry: SurfaceObjectTypeRegistry,
): Point | null {
  const hook = registry.get(target.type)?.connectorAnchor;
  if (hook !== undefined) {
    try {
      return hook(target, anchor) ?? null;
    } catch {
      return null;
    }
  }
  // Legacy fallback for types without the hook: unrotated envelope.
  const bounds = registry.get(target.type)?.boundsOf?.(target);
  if (bounds === undefined || bounds === null) return null;
  return anchorPoint(bounds, anchor);
}
/**
 * Rewrite bound connector endpoints from live bounds after the given
 * objects moved. Returns reconciled connector ids. Free endpoints,
 * dangling bindings, and non-line records are untouched.
 */
export function reconcileConnectorEndpoints(
  model: SurfaceModel,
  registry: SurfaceObjectTypeRegistry,
  movedIds: readonly SurfaceObjectId[],
): SurfaceObjectId[] {
  if (movedIds.length === 0) return [];
  const moved = new Set(movedIds);
  const reconciled: SurfaceObjectId[] = [];
  for (const id of model.order) {
    const record = model.objects[id];
    if (record === undefined || record.type !== SURFACE_OBJECT_TYPES.line) {
      continue;
    }
    let changed = false;
    for (const key of ['source', 'target'] as const) {
      const binding = readBinding(record, key);
      if (binding === null || !moved.has(binding.objectId)) continue;
      const target = model.objects[binding.objectId];
      if (target === undefined) continue;
      const point = resolveConnectorAnchor(target, binding.anchor, registry);
      if (point === null) continue;
      const px = key === 'source' ? 'x' : 'x2';
      const py = key === 'source' ? 'y' : 'y2';
      if (record[px] !== point.x || record[py] !== point.y) {
        (record as Record<string, unknown>)[px] = point.x;
        (record as Record<string, unknown>)[py] = point.y;
        changed = true;
      }
    }
    if (changed) reconciled.push(id);
  }
  return reconciled;
}
