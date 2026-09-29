/**
 * Deterministic force-directed layout for the graph view.
 *
 * A compact spring-embedder: pairwise repulsion, Hooke springs along edges,
 * weak centering, velocity damping with a speed clamp. Pure math — no DOM,
 * no randomness — so it is fully unit-testable and reproducible.
 */

export interface ForceGraphNode {
  readonly id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned nodes (being dragged) never move. */
  fixed?: boolean;
}

export interface ForceGraphEdge {
  readonly source: string;
  readonly target: string;
}

export interface ForceParams {
  width: number;
  height: number;
  repulsion: number;
  springLength: number;
  springStrength: number;
  centerStrength: number;
  damping: number;
  maxSpeed: number;
}

/** Deterministic circular seed layout. */
export function initializeLayout(
  nodes: readonly ForceGraphNode[],
  width: number,
  height: number,
): void {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.32 || 100;
  nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, nodes.length);
    node.x = cx + radius * Math.cos(angle);
    node.y = cy + radius * Math.sin(angle);
    node.vx = 0;
    node.vy = 0;
  });
}

/** Advance the simulation one tick, mutating positions in place. */
export function stepSimulation(
  nodes: readonly ForceGraphNode[],
  edges: readonly ForceGraphEdge[],
  params: ForceParams,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const forcesX = new Map<string, number>();
  const forcesY = new Map<string, number>();
  for (const node of nodes) {
    forcesX.set(node.id, 0);
    forcesY.set(node.id, 0);
  }

  // Pairwise repulsion, O(n²). Fine for note-scale graphs (hundreds).
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      if (b === undefined) continue;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distanceSq = dx * dx + dy * dy;
      if (distanceSq < 1e-6) {
        // Coincident: nudge deterministically apart.
        dx = 1e-3 * ((i % 2 === 0 ? 1 : -1) + j);
        dy = 1e-3 * ((j % 2 === 0 ? 1 : -1) + i);
        distanceSq = dx * dx + dy * dy;
      }
      const distance = Math.sqrt(distanceSq);
      const strength = params.repulsion / distanceSq;
      const fx = (dx / distance) * strength;
      const fy = (dy / distance) * strength;
      forcesX.set(a.id, (forcesX.get(a.id) ?? 0) + fx);
      forcesY.set(a.id, (forcesY.get(a.id) ?? 0) + fy);
      forcesX.set(b.id, (forcesX.get(b.id) ?? 0) - fx);
      forcesY.set(b.id, (forcesY.get(b.id) ?? 0) - fy);
    }
  }

  // Springs along edges.
  for (const edge of edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (a === undefined || b === undefined) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.max(Math.hypot(dx, dy), 1e-6);
    const displacement = distance - params.springLength;
    const strength = params.springStrength * displacement;
    const fx = (dx / distance) * strength;
    const fy = (dy / distance) * strength;
    forcesX.set(a.id, (forcesX.get(a.id) ?? 0) + fx);
    forcesY.set(a.id, (forcesY.get(a.id) ?? 0) + fy);
    forcesX.set(b.id, (forcesX.get(b.id) ?? 0) - fx);
    forcesY.set(b.id, (forcesY.get(b.id) ?? 0) - fy);
  }

  // Weak gravity toward the viewport center.
  const cx = params.width / 2;
  const cy = params.height / 2;
  for (const node of nodes) {
    forcesX.set(node.id, (forcesX.get(node.id) ?? 0) + (cx - node.x) * params.centerStrength);
    forcesY.set(node.id, (forcesY.get(node.id) ?? 0) + (cy - node.y) * params.centerStrength);
  }

  // Integrate with damping + speed clamp.
  for (const node of nodes) {
    if (node.fixed === true) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx = (node.vx + (forcesX.get(node.id) ?? 0)) * params.damping;
    node.vy = (node.vy + (forcesY.get(node.id) ?? 0)) * params.damping;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > params.maxSpeed) {
      node.vx = (node.vx / speed) * params.maxSpeed;
      node.vy = (node.vy / speed) * params.maxSpeed;
    }
    node.x += node.vx;
    node.y += node.vy;
  }
}
