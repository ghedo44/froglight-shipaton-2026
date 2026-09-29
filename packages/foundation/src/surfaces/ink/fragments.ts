import { observeSurfaceTransactions } from '../transactions.js';
import { inkSourceOutline } from './source-geometry.js';
import { cloneTemplateValue } from '../../documents.js';
import type { SurfaceObjectRecord, SurfaceModel } from '../model.js';
import { type Bounds, type Point } from '../geometry.js';
import { snapInkBoundaryPoint, type InkErasure } from './erasure.js';

import { INK_SOURCE_TYPE } from './fragment-validation.js';
export {
  INK_SOURCE_TYPE,
  validInkVisible,
  validInkRegionRecord,
} from './fragment-validation.js';
/** A source-outline run, or an intersection/cut vertex owned by this fragment. */
export type InkBoundary =
  | Point
  | readonly [
      start: number,
      count: number,
      step: 1 | -1,
      clippedBasis?: 1 | InkRegionTransform,
    ];
export type InkVisibleRegion = readonly (readonly (readonly InkBoundary[])[])[];
export interface PreparedInkRegion {
  readonly visible: InkVisibleRegion;
  readonly contours?: InkErasure;
  readonly polygonIndices?: readonly number[];
}
export type InkRegionTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];
const identity: InkRegionTransform = [1, 0, 0, 1, 0, 0];
const sourceByRecord = new WeakMap<SurfaceObjectRecord, SurfaceObjectRecord>();
const resolved = new WeakMap<
  SurfaceObjectRecord,
  { visible: unknown; transform: unknown; region: InkErasure }
>();

const sourceBytes = new WeakMap<object, number>();
/** Computed once when a source freezes; includes unknown sample/chunk metadata. */
export function inkSourceRetainedBytes(source: object): number {
  const cached = sourceBytes.get(source);
  if (cached !== undefined) return cached;
  const seen = new Set<object>();
  const size = (value: unknown): number => {
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value !== 'object' || value === null || seen.has(value))
      return 0;
    seen.add(value);
    return Object.entries(value).reduce(
      (n, [key, child]) => n + key.length * 2 + 8 + size(child),
      32,
    );
  };
  const bytes = size(source);
  sourceBytes.set(source, bytes);
  return bytes;
}

export function freezeInkValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeInkValue(child);
    Object.freeze(value);
    if ('type' in value && value.type === INK_SOURCE_TYPE)
      inkSourceRetainedBytes(value);
  }
  return value;
}
export function bindInkSource(
  record: SurfaceObjectRecord,
  source: SurfaceObjectRecord,
  contours?: InkErasure,
): void {
  sourceByRecord.set(record, source);
  if (contours !== undefined)
    resolved.set(record, {
      visible: record.visible,
      transform: record.regionTransform,
      region: contours,
    });
}
export function transformInkPoint(
  p: Point,
  transform: InkRegionTransform = identity,
): Point {
  if (transform === identity) return p;
  const [a, b, c, d, x, y] = transform;
  return { x: a * p.x + c * p.y + x, y: b * p.x + d * p.y + y };
}
export function inkRegion(record: SurfaceObjectRecord): InkErasure | null {
  if (record.region !== undefined) return record.region as InkErasure;
  if (record.visible === undefined) return null;
  const cached = resolved.get(record);
  if (
    cached?.visible === record.visible &&
    cached.transform === record.regionTransform
  )
    return cached.region;
  const source = sourceByRecord.get(record);
  if (source === undefined) throw new Error('Ink fragment source is not bound');
  const outline = inkSourceOutline(source);
  const transform = record.regionTransform as InkRegionTransform | undefined;
  const region = (record.visible as InkVisibleRegion).map((poly) =>
    poly.map((ring) =>
      ring.flatMap((boundary) => {
        if (!Array.isArray(boundary))
          return [transformInkPoint(boundary as Point, transform)];
        const [start, count, step, basis] = boundary as Extract<
          InkBoundary,
          readonly unknown[]
        >;
        return Array.from({ length: count }, (_, i) => {
          const point =
            outline[(start + i * step + outline.length) % outline.length]!;
          if (
            Array.isArray(basis) &&
            transform !== undefined &&
            basis.every((n, j) => n === transform[j])
          )
            return snapInkBoundaryPoint(
              transformInkPoint(point, basis as InkRegionTransform),
            );
          const local =
            basis === undefined
              ? point
              : basis === 1
                ? snapInkBoundaryPoint(point)
                : inverseInkPoint(
                    snapInkBoundaryPoint(transformInkPoint(point, basis)),
                    basis,
                  );
          return transformInkPoint(local, transform);
        });
      }),
    ),
  );
  freezeInkValue(region);
  resolved.set(record, {
    visible: record.visible,
    transform: record.regionTransform,
    region,
  });
  return region;
}
export function regionBounds(region: InkErasure): Bounds | null {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const polygon of region)
    for (const ring of polygon)
      for (const p of ring) {
        left = Math.min(left, p.x);
        top = Math.min(top, p.y);
        right = Math.max(right, p.x);
        bottom = Math.max(bottom, p.y);
      }
  return left === Infinity
    ? null
    : { x: left, y: top, width: right - left, height: bottom - top };
}
export function mapInkRegion(
  record: SurfaceObjectRecord,
  map: (p: Point) => Point,
): void {
  if (record.sourceId !== undefined) {
    const zero = map({ x: 0, y: 0 }),
      ex = map({ x: 1, y: 0 }),
      ey = map({ x: 0, y: 1 });
    const [a, b, c, d, x, y] =
      (record.regionTransform as InkRegionTransform | undefined) ?? identity;
    const ma = ex.x - zero.x,
      mb = ex.y - zero.y,
      mc = ey.x - zero.x,
      md = ey.y - zero.y;
    record.regionTransform = freezeInkValue([
      ma * a + mc * b,
      mb * a + md * b,
      ma * c + mc * d,
      mb * c + md * d,
      ma * x + mc * y + zero.x,
      mb * x + md * y + zero.y,
    ]);
    if (record.visible !== undefined) return;
  }
  const region = inkRegion(record);
  if (region !== null)
    record.region = freezeInkValue(
      region.map((poly) => poly.map((ring) => ring.map(map))),
    );
}
function inverseInkPoint(
  p: Point,
  transform: InkRegionTransform = identity,
): Point {
  const [a, b, c, d, x, y] = transform,
    determinant = a * d - b * c;
  return {
    x: (d * (p.x - x) - c * (p.y - y)) / determinant,
    y: (a * (p.y - y) - b * (p.x - x)) / determinant,
  };
}
/** Match exact source coordinates; consecutive indices become constant-size runs. Worker-only. */
export function packInkRegion(
  region: InkErasure,
  outline: readonly Point[],
  transform?: InkRegionTransform,
): InkVisibleRegion {
  const indices = new Map<
    number,
    Map<number, { index: number; basis?: 1 | InkRegionTransform }>
  >();
  outline.forEach((raw, index) => {
    const p = transformInkPoint(raw, transform);
    const ys =
      indices.get(p.x) ??
      new Map<number, { index: number; basis?: 1 | InkRegionTransform }>();
    ys.set(p.y, { index });
    indices.set(p.x, ys);
    const clipped = snapInkBoundaryPoint(p);
    const snapped = indices.get(clipped.x) ?? new Map();
    if (!snapped.has(clipped.y))
      snapped.set(clipped.y, { index, basis: transform ?? 1 });
    indices.set(clipped.x, snapped);
  });
  return freezeInkValue(
    region.map((poly) =>
      poly.map((ring) => {
        const tokens: InkBoundary[] = [];
        for (const p of ring) {
          const previous = tokens.at(-1);
          if (Array.isArray(previous)) {
            const [start, count, step, oldBasis] = previous as Extract<
              InkBoundary,
              readonly unknown[]
            >;
            const last =
              (start + (count - 1) * step + outline.length) % outline.length;
            const bases: Array<1 | InkRegionTransform | undefined> = [oldBasis];
            const clippedBasis = transform ?? 1;
            if (count === 1 && oldBasis === undefined) {
              const lastPoint = transformInkPoint(outline[last]!, transform);
              const clipped = snapInkBoundaryPoint(lastPoint);
              if (lastPoint.x === clipped.x && lastPoint.y === clipped.y)
                bases.push(clippedBasis);
            }
            let appended = false;
            for (const basis of bases) {
              for (const direction of count === 1 ? [step, -step] : [step]) {
                const index =
                  (last + direction + outline.length) % outline.length;
                const raw = transformInkPoint(outline[index]!, transform);
                const match =
                  basis === undefined ? raw : snapInkBoundaryPoint(raw);
                if (
                  count < outline.length &&
                  match.x === p.x &&
                  match.y === p.y
                ) {
                  const nextStep = direction as 1 | -1;
                  tokens[tokens.length - 1] =
                    basis === undefined
                      ? [start, count + 1, nextStep]
                      : [start, count + 1, nextStep, basis];
                  appended = true;
                  break;
                }
              }
              if (appended) break;
            }
            if (appended) continue;
          }
          const match = indices.get(p.x)?.get(p.y);
          if (match === undefined) {
            tokens.push(inverseInkPoint(p, transform));
            continue;
          }
          const { index, basis } = match;
          if (Array.isArray(previous) && previous[3] === basis) {
            const [start, count, step] = previous as readonly [
              number,
              number,
              1 | -1,
            ];
            const last =
              (start + (count - 1) * step + outline.length) % outline.length;
            const next = (last + step + outline.length) % outline.length;
            const reversed = (last - step + outline.length) % outline.length;
            if (
              count < outline.length &&
              (index === next || (count === 1 && index === reversed))
            ) {
              tokens[tokens.length - 1] =
                basis === undefined
                  ? [
                      start,
                      count + 1,
                      index === next ? step : step === 1 ? -1 : 1,
                    ]
                  : [
                      start,
                      count + 1,
                      index === next ? step : step === 1 ? -1 : 1,
                      basis,
                    ];
              continue;
            }
          }
          tokens.push(
            basis === undefined ? [index, 1, 1] : [index, 1, 1, basis],
          );
        }
        return tokens;
      }),
    ),
  );
}
export function cloneInkRecord(
  record: SurfaceObjectRecord,
): SurfaceObjectRecord {
  if (record.type !== INK_SOURCE_TYPE && record.type !== 'froglight.ink.stroke')
    return cloneTemplateValue(record);
  if (record.type === INK_SOURCE_TYPE && Object.isFrozen(record)) return record;
  const { region, visible, regionTransform, ...shell } = record;
  const copy = cloneTemplateValue(shell) as SurfaceObjectRecord;
  if (region !== undefined) copy.region = freezeInkValue(region);
  if (visible !== undefined) copy.visible = freezeInkValue(visible);
  if (regionTransform !== undefined)
    copy.regionTransform = freezeInkValue(regionTransform);
  const source = sourceByRecord.get(record);
  if (source !== undefined) bindInkSource(copy, source);
  return copy;
}
interface SourceOwnership {
  byObject: Map<string, string>;
  users: Map<string, Set<string>>;
}
const ownership = new WeakMap<object, SourceOwnership>();
export function seedInkSourceOwnership(model: SurfaceModel): void {
  if (ownership.has(model)) return;
  const state: SourceOwnership = { byObject: new Map(), users: new Map() };
  ownership.set(model, state);
  observeSurfaceTransactions(model, {
    order: () => undefined,
    objects: (ids) => {
      unusedInkSources(model, ids);
    },
  });
  for (const record of Object.values(model.objects))
    if (
      record.type === 'froglight.ink.stroke' &&
      typeof record.sourceId === 'string'
    ) {
      state.byObject.set(record.id, record.sourceId);
      const users = state.users.get(record.sourceId) ?? new Set();
      users.add(record.id);
      state.users.set(record.sourceId, users);
      const source = model.objects[record.sourceId];
      if (source !== undefined) bindInkSource(record, source);
    }
}
export function unusedInkSources(
  model: SurfaceModel,
  ids: readonly string[],
): string[] {
  seedInkSourceOwnership(model);
  const state = ownership.get(model)!;
  const candidates = new Set<string>();
  for (const id of ids) {
    const previous = state.byObject.get(id),
      record = model.objects[id],
      source =
        record?.type === 'froglight.ink.stroke' ? record.sourceId : undefined;
    if (previous !== undefined && previous !== source) {
      state.users.get(previous)?.delete(id);
      state.byObject.delete(id);
      candidates.add(previous);
    }
    if (typeof source === 'string') {
      const users = state.users.get(source) ?? new Set();
      users.add(id);
      state.users.set(source, users);
      state.byObject.set(id, source);
      if (model.objects[source] !== undefined)
        bindInkSource(record!, model.objects[source]!);
    }
    if (record?.type === INK_SOURCE_TYPE) candidates.add(id);
  }
  return [...candidates].filter(
    (id) =>
      (state.users.get(id)?.size ?? 0) === 0 &&
      model.objects[id]?.type === INK_SOURCE_TYPE,
  );
}
