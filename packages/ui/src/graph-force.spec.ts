import { describe, expect, it } from 'vitest';
import {
  initializeLayout,
  stepSimulation,
  type ForceGraphEdge,
  type ForceGraphNode,
} from './graph-force.js';

function makeNodes(count: number): ForceGraphNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fixed: false,
  }));
}

describe('initializeLayout', () => {
  it('places nodes on a deterministic circle around the center', () => {
    const nodes = makeNodes(4);
    initializeLayout(nodes, 1000, 800);
    for (const node of nodes) {
      expect(node.x).toBeGreaterThanOrEqual(240);
      expect(node.x).toBeLessThanOrEqual(760);
      expect(node.y).toBeGreaterThanOrEqual(140);
      expect(node.y).toBeLessThanOrEqual(660);
    }
    // Same inputs → same layout.
    const again = makeNodes(4);
    initializeLayout(again, 1000, 800);
    expect(again.map((n) => [n.x, n.y])).toEqual(nodes.map((n) => [n.x, n.y]));
  });
});

describe('stepSimulation', () => {
  it('repulsion pushes overlapping nodes apart', () => {
    const nodes: ForceGraphNode[] = [
      { id: 'a', x: 500, y: 400, vx: 0, vy: 0, fixed: false },
      { id: 'b', x: 502, y: 400, vx: 0, vy: 0, fixed: false },
    ];
    const before = Math.abs(nodes[1].x - nodes[0].x);
    for (let i = 0; i < 30; i += 1) stepSimulation(nodes, [], params());
    const after = Math.abs(nodes[1].x - nodes[0].x);
    expect(after).toBeGreaterThan(before * 5);
  });

  it('springs pull connected nodes together relative to unconnected pairs', () => {
    const nodes: ForceGraphNode[] = [
      { id: 'a', x: 100, y: 100, vx: 0, vy: 0, fixed: false },
      { id: 'b', x: 900, y: 100, vx: 0, vy: 0, fixed: false },
      { id: 'c', x: 500, y: 700, vx: 0, vy: 0, fixed: false },
    ];
    const edges: ForceGraphEdge[] = [{ source: 'a', target: 'b' }];
    for (let i = 0; i < 200; i += 1) stepSimulation(nodes, edges, params());
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const connected = dist(byId.get('a'), byId.get('b'));
    const unconnected = Math.min(
      dist(byId.get('a'), byId.get('c')),
      dist(byId.get('b'), byId.get('c')),
    );
    expect(connected).toBeLessThan(unconnected);
    // Springs settle near their rest length rather than collapsing.
    expect(connected).toBeGreaterThan(40);
  });

  it('centering pulls a lone node toward the viewport center', () => {
    const nodes: ForceGraphNode[] = [
      { id: 'lonely', x: 950, y: 750, vx: 0, vy: 0, fixed: false },
    ];
    for (let i = 0; i < 120; i += 1) stepSimulation(nodes, [], params());
    expect(Math.hypot(nodes[0].x - 500, nodes[0].y - 400)).toBeLessThan(60);
  });

  it('never moves pinned nodes', () => {
    const pin: ForceGraphNode = { id: 'pin', x: 10, y: 20, vx: 0, vy: 0, fixed: true };
    const free: ForceGraphNode = { id: 'free', x: 12, y: 22, vx: 0, vy: 0, fixed: false };
    for (let i = 0; i < 25; i += 1) stepSimulation([pin, free], [], params());
    expect(pin.x).toBe(10);
    expect(pin.y).toBe(20);
    expect(free.x).not.toBe(12);
  });

  it('is stable with no energy explosion on long runs', () => {
    const nodes = makeNodes(6);
    initializeLayout(nodes, 1000, 800);
    for (let i = 0; i < 600; i += 1) stepSimulation(nodes, [], params());
    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Math.abs(node.vx)).toBeLessThan(1000);
      expect(Math.abs(node.vy)).toBeLessThan(1000);
    }
  });
});

function dist(a: ForceGraphNode | undefined, b: ForceGraphNode | undefined): number {
  if (a === undefined || b === undefined) throw new Error('missing node');
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function params() {
  return {
    width: 1000,
    height: 800,
    repulsion: 24000,
    springLength: 90,
    springStrength: 0.02,
    centerStrength: 0.03,
    damping: 0.82,
    maxSpeed: 60,
  };
}
