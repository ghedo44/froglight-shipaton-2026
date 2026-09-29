/**
 * Connector routing and endpoint reconciliation (slice 9, whiteboard):
 * deterministic elbow/curve routing between endpoints plus binding
 * resolution against live object bounds. Headless and deterministic.
 */

import { describe, expect, it } from 'vitest';
import {
  anchorPoint,
  reconcileConnectorEndpoints,
  resolveConnectorAnchor,
  routeConnector,
} from './connectors.js';
import {
  ellipseObject,
  infiniteFrame,
  lineObject,
  rectangleObject,
  type SurfaceModel,
} from '../model.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  sizedConnectorAnchor,
} from '../objects.js';

function board(): SurfaceModel {
  return { formatVersion: 1, frame: infiniteFrame(), order: [], objects: {} };
}

describe('routeConnector', () => {
  it('routes straight lines endpoint to endpoint', () => {
    expect(
      routeConnector({ x: 0, y: 0 }, { x: 100, y: 50 }, 'straight'),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ]);
  });

  it('routes orthogonal elbows through the mid-x with a horizontal lead', () => {
    expect(
      routeConnector({ x: 0, y: 0 }, { x: 100, y: 50 }, 'orthogonal'),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 50 },
    ]);
  });

  it('routes curves bulging off the straight segment', () => {
    const route = routeConnector({ x: 0, y: 0 }, { x: 100, y: 0 }, 'curved');
    expect(route.length).toBeGreaterThan(2);
    expect(route[0]).toEqual({ x: 0, y: 0 });
    expect(route[route.length - 1]).toEqual({ x: 100, y: 0 });
    const mid = route[Math.floor(route.length / 2)]!;
    // Quadratic control at 20% of length perpendicular: apex at 10% .
    expect(mid.x).toBeCloseTo(50, 6);
    expect(mid.y).toBeCloseTo(10, 6);
    for (const p of route) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it('degenerates gracefully on coincident endpoints', () => {
    const at = { x: 5, y: 5 };
    expect(routeConnector(at, at, 'orthogonal')).toEqual([at, at]);
    expect(routeConnector(at, at, 'curved')).toEqual([at, at]);
  });
});

describe('anchorPoint', () => {
  const bounds = { x: 10, y: 20, width: 40, height: 30 };

  it('resolves named anchors on envelope bounds', () => {
    expect(anchorPoint(bounds, 'center')).toEqual({ x: 30, y: 35 });
    expect(anchorPoint(bounds, 'n')).toEqual({ x: 30, y: 20 });
    expect(anchorPoint(bounds, 's')).toEqual({ x: 30, y: 50 });
    expect(anchorPoint(bounds, 'e')).toEqual({ x: 50, y: 35 });
    expect(anchorPoint(bounds, 'w')).toEqual({ x: 10, y: 35 });
  });
});

describe('reconcileConnectorEndpoints', () => {
  function connectedBoard() {
    const model = board();
    model.objects.a = rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 });
    model.objects.b = rectangleObject('b', { x: 100, y: 0, width: 20, height: 20 });
    model.objects.c = lineObject('c', {
      x: 20,
      y: 10,
      x2: 100,
      y2: 10,
      source: { objectId: 'a', anchor: 'e' },
      target: { objectId: 'b', anchor: 'w' },
    });
    model.objects.free = lineObject('free', { x: 0, y: 60, x2: 50, y2: 60 });
    model.order.push('a', 'b', 'c', 'free');
    return model;
  }

  it('rewrites bound endpoints when their objects move', () => {
    const model = connectedBoard();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    // Move `a` right by 10 (as a translate would).
    const a = model.objects.a!;
    (a as Record<string, unknown>).x = 10;
    const reconciled = reconcileConnectorEndpoints(model, registry, ['a']);
    expect(reconciled).toEqual(['c']);
    expect(model.objects.c!.x).toBe(30);
    expect(model.objects.c!.y).toBe(10);
    // Untouched bindings and free lines keep their coords.
    expect(model.objects.c!.x2).toBe(100);
    const free = model.objects.free!;
    expect([free.x, free.y]).toEqual([0, 60]);
  });

  it('resolves dangling bindings as free without dropping them', () => {
    const model = connectedBoard();
    delete model.objects.b;
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const reconciled = reconcileConnectorEndpoints(model, registry, ['a']);
    expect(reconciled).toEqual([]);
    // Coords kept, binding preserved verbatim for a later rebind.
    expect(model.objects.c!.x2).toBe(100);
    expect(model.objects.c!.target).toEqual({ objectId: 'b', anchor: 'w' });
  });

  it('ignores unbound lines and unknown records', () => {
    const model = board();
    model.objects.free = lineObject('free', { x: 0, y: 0, x2: 5, y2: 5 });
    model.order.push('free');
    const registry = createDefaultSurfaceObjectTypeRegistry();
    expect(reconcileConnectorEndpoints(model, registry, ['free'])).toEqual([]);
  });
});

describe('rotated connector anchors (repair pass item 10)', () => {
  const registry = createDefaultSurfaceObjectTypeRegistry();

  it('resolves local anchors rotated around the canonical pivot', () => {
    // 20×20 rect at origin rotated 90° clockwise (y-down): the local
    // east edge midpoint (20,10) rotates around the center (10,10) to
    // the south edge midpoint (10,20).
    const record = rectangleObject('a', {
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      rotation: Math.PI / 2,
    });
    expect(sizedConnectorAnchor(record, 'e', (r) => ({
      x: r.x as number,
      y: r.y as number,
      width: r.width as number,
      height: r.height as number,
    }))).toEqual({ x: 10, y: 20 });
    // Unrotated records degrade to the plain envelope anchor.
    const flat = rectangleObject('b', { x: 0, y: 0, width: 20, height: 20 });
    expect(
      registry.get(flat.type)?.connectorAnchor?.(flat, 'e'),
    ).toEqual({ x: 20, y: 10 });
    expect(registry.get(flat.type)?.connectorAnchor?.(flat, 'n')).toEqual({
      x: 10,
      y: 0,
    });
  });

  it('keeps connectors attached after rotate via reconcile', () => {
    const model = board();
    model.objects.a = rectangleObject('a', {
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      rotation: Math.PI / 2,
    });
    model.objects.c = lineObject('c', {
      x: 0,
      y: 0,
      x2: 50,
      y2: 50,
      source: { objectId: 'a', anchor: 'e' },
    });
    model.order.push('a', 'c');
    const reconciled = reconcileConnectorEndpoints(model, registry, ['a']);
    expect(reconciled).toEqual(['c']);
    // Local east anchor (40,10) rotated 90° about the center (20,10).
    const expected = resolveConnectorAnchor(
      model.objects.a!,
      'e',
      registry,
    )!;
    expect(model.objects.c!.x).toBeCloseTo(expected.x, 9);
    expect(model.objects.c!.y).toBeCloseTo(expected.y, 9);
    expect(expected.x).toBeCloseTo(20, 9);
    expect(expected.y).toBeCloseTo(30, 9);
  });

  it('resolves ellipse anchors through the same rotation seam', () => {
    const record = ellipseObject('e', {
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      rotation: Math.PI,
    });
    const point = resolveConnectorAnchor(record, 'n', registry)!;
    // Local north (20,0) rotated 180° about (20,10) → (20,20).
    expect(point.x).toBeCloseTo(20, 9);
    expect(point.y).toBeCloseTo(20, 9);
  });

  it('returns null for anchorless geometry instead of throwing', () => {
    const ghost = { id: 'g', type: 'acme.ghost' };
    expect(resolveConnectorAnchor(ghost, 'e', registry)).toBeNull();
  });
});
