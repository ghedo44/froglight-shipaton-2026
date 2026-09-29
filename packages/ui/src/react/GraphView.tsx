import { useEffect, useRef, useState } from 'react';
import { iconForPath } from '../file-kinds.js';
import { workspaceEvents } from '../ui-events.js';
import {
  initializeLayout,
  stepSimulation,
  type ForceGraphNode,
} from '../graph-force.js';
import type { GraphData, GraphNodeInfo, GraphService } from '../graph-view.js';
import { isMotionReduced } from '../motion.js';
import { Button } from './Button.jsx';
import { Icon } from './Icon.jsx';
import { Slider } from './Slider.jsx';
import styles from './GraphView.module.css';
import surface from './DialogSurface.module.css';

const defaultSettings = {
  repulsion: 100,
  attraction: 70,
  distance: 100,
  size: 100,
};
type GraphSettings = typeof defaultSettings;

export interface GraphViewProps {
  readonly service: GraphService;
  readonly centerDocumentId?: string;
  readonly compact?: boolean;
  /** A surrounding panel may provide the same navigable neighbor list. */
  readonly showNeighbors?: boolean;
}

interface NeighborView {
  readonly id: string;
  readonly info: GraphNodeInfo;
  readonly incoming: number;
  readonly outgoing: number;
  readonly types: readonly string[];
}

interface ViewState {
  data: GraphData;
  positions: ForceGraphNode[];
  labels: Map<string, GraphNodeInfo>;
  degrees: Map<string, number>;
  panX: number;
  panY: number;
  zoom: number;
  hoverId: string | null;
  draggingId: string | null;
  panning: boolean;
  pointerId: number | null;
  lastPointerX: number;
  lastPointerY: number;
  downX: number;
  downY: number;
}

/** Canvas graph shared by the full workspace view and the one-hop sidebar. */
export function GraphView(props: GraphViewProps): React.ReactElement {
  const {
    service,
    centerDocumentId,
    compact = false,
    showNeighbors = true,
  } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recenterRef = useRef<HTMLButtonElement | null>(null);
  const rebuildRef = useRef<(() => void) | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [hiddenFormats, setHiddenFormats] = useState<readonly string[]>([]);
  const [formats, setFormats] = useState<
    readonly { name: string; label: string; count: number }[]
  >([]);
  const updateControls = useRef<
    ((settings: GraphSettings, hidden: readonly string[]) => void) | null
  >(null);
  const [empty, setEmpty] = useState(true);
  const [neighbors, setNeighbors] = useState<readonly NeighborView[]>([]);

  const dispatchOpen = (documentId: string): void => {
    rootRef.current?.dispatchEvent(
      new CustomEvent(workspaceEvents.open, {
        detail: { documentId },
        bubbles: true,
      }),
    );
  };

  const openFullGraph = (): void => {
    rootRef.current?.dispatchEvent(
      new CustomEvent(workspaceEvents.openView, {
        detail: { viewId: 'graph' },
        bubbles: true,
      }),
    );
  };

  useEffect(() => {
    const root = rootRef.current;
    const canvasWrap = canvasWrapRef.current;
    const canvas = canvasRef.current;
    const recenterButton = recenterRef.current;
    if (
      root === null ||
      canvasWrap === null ||
      canvas === null ||
      recenterButton === null
    )
      return;

    const ctx2d = canvas.getContext('2d');
    let disposed = false;
    let rafId: number | null = null;
    let buildSequence = 0;
    let visible = true;
    let settleFrames = 0;
    let animationFrames = 0;
    let animationPending = false;
    let spawning: ForceGraphNode[] = [];
    let nextSpawnAt = 0;
    let spawnInterval = 70;
    let controls = defaultSettings;
    let excluded: readonly string[] = [];
    let completeData: GraphData = { nodes: [], edges: [] };
    const state: ViewState = {
      data: { nodes: [], edges: [] },
      positions: [],
      labels: new Map(),
      degrees: new Map(),
      panX: 0,
      panY: 0,
      zoom: 1,
      hoverId: null,
      draggingId: null,
      panning: false,
      pointerId: null,
      lastPointerX: 0,
      lastPointerY: 0,
      downX: 0,
      downY: 0,
    };

    const cssVar = (name: string, fallback: string): string => {
      if (typeof getComputedStyle !== 'function') return fallback;
      return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
    };

    const resizeCanvas = (): void => {
      const rect = canvasWrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const center = state.positions.find(
        (node) => node.id === centerDocumentId,
      );
      if (center !== undefined) {
        center.x = rect.width / 2;
        center.y = rect.height / 2;
      }
      fit();
    };

    const toScreen = (x: number, y: number): [number, number] => {
      const width = canvasRef.current?.clientWidth || 800;
      const height = canvasRef.current?.clientHeight || 600;
      return [
        width / 2 + (x - width / 2) * state.zoom + state.panX,
        height / 2 + (y - height / 2) * state.zoom + state.panY,
      ];
    };

    const toWorld = (sx: number, sy: number): [number, number] => {
      const width = canvas.clientWidth || 800;
      const height = canvas.clientHeight || 600;
      return [
        (sx - state.panX - width / 2) / state.zoom + width / 2,
        (sy - state.panY - height / 2) / state.zoom + height / 2,
      ];
    };

    const neighborSet = (id: string | null): Set<string> => {
      const result = new Set<string>();
      if (id === null) return result;
      result.add(id);
      for (const edge of state.data.edges) {
        if (edge.source === id) result.add(edge.target);
        if (edge.target === id) result.add(edge.source);
      }
      return result;
    };

    const advanceSimulation = (): void => {
      stepSimulation(state.positions, state.data.edges, {
        width: canvas.clientWidth || 800,
        height: canvas.clientHeight || 600,
        repulsion: ((compact ? 14000 : 26000) * controls.repulsion) / 100,
        springLength: ((compact ? 78 : 110) * controls.distance) / 100,
        springStrength: (0.012 * controls.attraction) / 100,
        centerStrength: (0.012 * controls.attraction) / 100,
        damping: 0.6,
        maxSpeed: 4,
      });
    };

    // Resolve the high-energy seed before painting, including reduced motion.
    // Bounded work keeps large vaults from monopolizing the main thread.
    const settleLayout = (): void => {
      const ticks = Math.min(
        240,
        Math.max(24, Math.floor(24000 / Math.max(1, state.positions.length))),
      );
      for (let i = 0; i < ticks; i += 1) advanceSimulation();
      for (const node of state.positions) {
        node.vx = 0;
        node.vy = 0;
      }
    };

    const nodeRadius = (id: string): number =>
      ((id === centerDocumentId
        ? 8
        : 4 + Math.min(12, Math.sqrt(state.degrees.get(id) ?? 0) * 2.6)) *
        controls.size) /
      100;

    function draw(advance: boolean): void {
      if (ctx2d === null || disposed) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvasRef.current?.clientWidth || 800;
      const height = canvasRef.current?.clientHeight || 600;
      if (advance) advanceSimulation();
      const center = state.positions.find(
        (node) => node.id === centerDocumentId,
      );
      if (center !== undefined) {
        center.x = width / 2;
        center.y = height / 2;
        center.vx = 0;
        center.vy = 0;
      }

      ctx2d.save();
      ctx2d.scale(dpr, dpr);
      ctx2d.clearRect(0, 0, width, height);
      ctx2d.fillStyle = cssVar('--fl-surface-editor', '#fff');
      ctx2d.fillRect(0, 0, width, height);
      const accent = cssVar('--fl-accent', '#7c6cf0');
      const text = cssVar('--fl-text-secondary', '#666');
      const edgeColor = cssVar('--fl-border-strong', '#aaa');
      const points = new Map<string, [number, number]>();
      for (const node of state.positions)
        points.set(node.id, toScreen(node.x, node.y));
      const highlighted = neighborSet(state.hoverId);

      ctx2d.lineWidth = 1.25;
      for (const edge of state.data.edges) {
        const a = points.get(edge.source);
        const b = points.get(edge.target);
        if (a === undefined || b === undefined) continue;
        const active =
          state.hoverId !== null &&
          (edge.source === state.hoverId || edge.target === state.hoverId);
        ctx2d.globalAlpha = active
          ? 0.95
          : state.hoverId === null
            ? 0.55
            : 0.16;
        ctx2d.strokeStyle = active ? accent : edgeColor;
        ctx2d.beginPath();
        ctx2d.moveTo(a[0], a[1]);
        ctx2d.lineTo(b[0], b[1]);
        ctx2d.stroke();
      }

      for (const node of state.positions) {
        const point = points.get(node.id);
        if (point === undefined) continue;
        const isCenter = node.id === centerDocumentId;
        const isHover = node.id === state.hoverId;
        const dimmed = state.hoverId !== null && !highlighted.has(node.id);
        const radius = nodeRadius(node.id);
        ctx2d.globalAlpha = dimmed ? 0.2 : 1;
        ctx2d.fillStyle = accent;
        ctx2d.beginPath();
        ctx2d.arc(
          point[0],
          point[1],
          radius + (isHover ? 2 : 0),
          0,
          Math.PI * 2,
        );
        ctx2d.fill();
        if (isCenter) {
          ctx2d.strokeStyle = cssVar('--fl-accent-strong', accent);
          ctx2d.lineWidth = 2;
          ctx2d.stroke();
        }
        const info = state.labels.get(node.id);
        if (
          info !== undefined &&
          (compact ||
            isHover ||
            state.zoom > 1.35 ||
            state.positions.length <= 40)
        ) {
          ctx2d.font = `${isCenter || isHover ? 12.5 : 11.5}px ${cssVar('--fl-font-sans', 'system-ui')}`;
          ctx2d.fillStyle = text;
          ctx2d.textAlign = 'center';
          ctx2d.fillText(info.label, point[0], point[1] + radius + 15);
        }
      }
      ctx2d.globalAlpha = 1;
      ctx2d.restore();
    }

    const stopAnimation = (): void => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    };

    const animate = (): void => {
      rafId = null;
      if (disposed || !visible) return;
      if (isMotionReduced()) {
        state.positions.push(...spawning);
        spawning = [];
        animationPending = false;
        settleLayout();
        draw(false);
        return;
      }
      const now = performance.now();
      while (spawning.length > 0 && now >= nextSpawnAt) {
        const node = spawning.shift();
        if (node !== undefined) state.positions.push(node);
        nextSpawnAt += spawnInterval;
        animationFrames = 0;
      }
      draw(true);
      const speed = state.positions.reduce(
        (sum, node) => sum + Math.abs(node.vx) + Math.abs(node.vy),
        0,
      );
      settleFrames = speed < 0.18 ? settleFrames + 1 : 0;
      animationFrames += 1;
      animationPending =
        spawning.length > 0 ||
        state.draggingId !== null ||
        (settleFrames < 8 && animationFrames < 120);
      if (animationPending) rafId = requestAnimationFrame(animate);
    };

    const startAnimation = (): void => {
      stopAnimation();
      settleFrames = 0;
      animationFrames = 0;
      animationPending = true;
      if (isMotionReduced() || !visible) {
        draw(false);
        return;
      }
      rafId = requestAnimationFrame(animate);
    };

    const fit = (): void => {
      const width = canvas.clientWidth || 800;
      const height = canvas.clientHeight || (compact ? 260 : 600);
      if (state.positions.length === 0) {
        draw(false);
        return;
      }
      const xs = state.positions.map((node) => node.x);
      const ys = state.positions.map((node) => node.y);
      const minX = Math.min(...xs),
        maxX = Math.max(...xs);
      const minY = Math.min(...ys),
        maxY = Math.max(...ys);
      state.zoom = Math.min(
        1.5,
        Math.max(
          0.1,
          Math.min(
            Math.max(1, width - 200) / Math.max(1, maxX - minX),
            Math.max(1, height - 140) / Math.max(1, maxY - minY),
          ),
        ),
      );
      state.panX =
        centerDocumentId === undefined
          ? (width / 2 - (minX + maxX) / 2) * state.zoom
          : 0;
      state.panY =
        centerDocumentId === undefined
          ? (height / 2 - (minY + maxY) / 2) * state.zoom
          : 0;
      draw(false);
    };

    const refreshNeighbors = (): void => {
      if (centerDocumentId === undefined) {
        setNeighbors([]);
        return;
      }
      const rows: NeighborView[] = [];
      for (const node of state.positions) {
        if (node.id === centerDocumentId) continue;
        const info = state.labels.get(node.id);
        if (info === undefined) continue;
        let incoming = 0;
        let outgoing = 0;
        const types = new Set<string>();
        for (const edge of state.data.edges) {
          if (edge.source !== node.id && edge.target !== node.id) continue;
          for (const occurrence of edge.occurrences ?? []) {
            types.add(occurrence.typeLabel);
            if (occurrence.sourceDocumentId === centerDocumentId) outgoing += 1;
            if (occurrence.targetDocumentId === centerDocumentId) incoming += 1;
          }
        }
        rows.push({
          id: node.id,
          info,
          incoming,
          outgoing,
          types: [...types].sort(),
        });
      }
      setNeighbors(
        rows.sort((a, b) => a.info.label.localeCompare(b.info.label)),
      );
    };

    const applyData = (replay = false): void => {
      stopAnimation();
      animationPending = false;
      spawning = [];
      clearPointer();
      state.hoverId = null;
      const previous = new Map(state.positions.map((node) => [node.id, node]));
      const nodes = completeData.nodes.filter(
        (node) =>
          node.id === centerDocumentId ||
          !excluded.includes(state.labels.get(node.id)?.kindId ?? 'Other'),
      );
      const ids = new Set(nodes.map((node) => node.id));
      const edges = completeData.edges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      );
      state.data = { nodes, edges };
      const seeded = nodes.map((node) => ({ ...node }));
      initializeLayout(
        seeded,
        canvas.clientWidth || 800,
        canvas.clientHeight || 600,
      );
      state.positions = seeded.map((node) => {
        const old = replay ? undefined : previous.get(node.id);
        return old === undefined
          ? node
          : { ...node, x: old.x, y: old.y, vx: 0, vy: 0 };
      });
      const center = state.positions.find(
        (node) => node.id === centerDocumentId,
      );
      if (center !== undefined) {
        center.fixed = true;
        center.x = (canvas.clientWidth || 800) / 2;
        center.y = (canvas.clientHeight || 600) / 2;
      }
      state.degrees = new Map();
      for (const edge of edges) {
        // The projection groups all occurrences between a document pair.
        const count = 1;
        state.degrees.set(
          edge.source,
          (state.degrees.get(edge.source) ?? 0) + count,
        );
        state.degrees.set(
          edge.target,
          (state.degrees.get(edge.target) ?? 0) + count,
        );
      }
      setEmpty(compact ? edges.length === 0 : nodes.length === 0);
      refreshNeighbors();
      if (replay && !isMotionReduced() && nodes.length > 0) {
        // Fit the complete seed once; reveal only real, interactive nodes.
        fit();
        spawning = state.positions;
        state.positions = [];
        spawnInterval = Math.min(70, 2500 / nodes.length);
        nextSpawnAt = performance.now();
        draw(false);
        startAnimation();
      } else {
        settleLayout();
        fit();
      }
    };

    const rebuild = async (replay = false): Promise<void> => {
      const sequence = ++buildSequence;
      const data = await service.build(centerDocumentId);
      if (disposed || sequence !== buildSequence) return;
      completeData = data;
      state.labels = new Map(service.labels());
      const counts = new Map<string, number>();
      const labelsByKind = new Map<string, string>();
      for (const node of data.nodes) {
        const info = state.labels.get(node.id);
        const name = info?.kindId ?? 'Other';
        counts.set(name, (counts.get(name) ?? 0) + 1);
        labelsByKind.set(name, info?.kindLabel ?? name);
      }
      setFormats(
        [...counts]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => ({
            name,
            label: labelsByKind.get(name) ?? name,
            count,
          })),
      );
      applyData(replay);
    };

    rebuildRef.current = () => {
      void rebuild(true);
    };

    updateControls.current = (next, hidden): void => {
      const filtersChanged = excluded !== hidden;
      const physicsChanged =
        controls.repulsion !== next.repulsion ||
        controls.attraction !== next.attraction ||
        controls.distance !== next.distance;
      controls = next;
      excluded = hidden;
      if (filtersChanged) applyData();
      else if (physicsChanged) {
        if (isMotionReduced()) {
          settleLayout();
          fit();
        } else startAnimation();
      } else draw(false);
    };

    const nodeAt = (sx: number, sy: number): string | null => {
      let closest: string | null = null;
      let distance = Infinity;
      for (const node of state.positions) {
        const point = toScreen(node.x, node.y);
        const candidate = Math.hypot(point[0] - sx, point[1] - sy);
        if (
          candidate < Math.max(16, nodeRadius(node.id) + 4) &&
          candidate < distance
        ) {
          distance = candidate;
          closest = node.id;
        }
      }
      return closest;
    };

    const pointerPoint = (event: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };

    const touches = new Map<number, [number, number]>();
    let multitouch = false;
    const pinchGeometry = () => {
      const [a, b] = [...touches.values()];
      return a && b
        ? {
            x: (a[0] + b[0]) / 2,
            y: (a[1] + b[1]) / 2,
            distance: Math.hypot(a[0] - b[0], a[1] - b[1]),
          }
        : null;
    };

    const clearPointer = (event?: PointerEvent): void => {
      if (
        event !== undefined &&
        state.pointerId === event.pointerId &&
        canvas.hasPointerCapture?.(event.pointerId)
      )
        canvas.releasePointerCapture(event.pointerId);
      const node = state.positions.find(
        (candidate) => candidate.id === state.draggingId,
      );
      if (node !== undefined) node.fixed = node.id === centerDocumentId;
      state.draggingId = null;
      state.panning = false;
      state.pointerId = null;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        touches.set(event.pointerId, pointerPoint(event));
        canvas.setPointerCapture(event.pointerId);
        if (touches.size > 1) {
          multitouch = true;
          clearPointer();
        }
      }
      if (multitouch || state.pointerId !== null) return;
      canvas.setPointerCapture(event.pointerId);
      state.pointerId = event.pointerId;
      const [sx, sy] = pointerPoint(event);
      state.downX = sx;
      state.downY = sy;
      state.lastPointerX = sx;
      state.lastPointerY = sy;
      const hit = nodeAt(sx, sy);
      if (hit === null) state.panning = true;
      else {
        state.draggingId = hit;
        const node = state.positions.find((candidate) => candidate.id === hit);
        if (node !== undefined) node.fixed = true;
      }
      if (state.draggingId !== null) startAnimation();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const [sx, sy] = pointerPoint(event);
      if (touches.has(event.pointerId)) {
        const before = pinchGeometry();
        touches.set(event.pointerId, [sx, sy]);
        const after = pinchGeometry();
        if (multitouch) {
          if (before && after && before.distance > 0 && after.distance > 0) {
            const [wx, wy] = toWorld(before.x, before.y);
            state.zoom = Math.min(
              3.5,
              Math.max(0.35, (state.zoom * after.distance) / before.distance),
            );
            const [px, py] = toScreen(wx, wy);
            state.panX += after.x - px;
            state.panY += after.y - py;
            draw(false);
          }
          return;
        }
      }
      // An unrelated pointer must not overwrite the active drag's origin.
      if (multitouch) return;
      if (state.pointerId !== null && state.pointerId !== event.pointerId) return;
      if (state.pointerId === event.pointerId && state.draggingId !== null) {
        const node = state.positions.find(
          (candidate) => candidate.id === state.draggingId,
        );
        if (node !== undefined) [node.x, node.y] = toWorld(sx, sy);
      } else if (state.pointerId === event.pointerId && state.panning) {
        state.panX += sx - state.lastPointerX;
        state.panY += sy - state.lastPointerY;
      } else if (state.pointerId === null) {
        state.hoverId = nodeAt(sx, sy);
        canvas.style.cursor = state.hoverId === null ? 'grab' : 'pointer';
      }
      state.lastPointerX = sx;
      state.lastPointerY = sy;
      draw(state.pointerId === event.pointerId && state.draggingId !== null);
    };

    const onPointerUp = (event: PointerEvent): void => {
      touches.delete(event.pointerId);
      if (multitouch) {
        if (canvas.hasPointerCapture?.(event.pointerId))
          canvas.releasePointerCapture(event.pointerId);
        multitouch = touches.size > 0;
        return;
      }
      if (state.pointerId !== event.pointerId) return;
      const [sx, sy] = pointerPoint(event);
      const hit = state.draggingId;
      const moved = Math.hypot(sx - state.downX, sy - state.downY) > 6;
      clearPointer(event);
      if (!moved && hit !== null && hit !== centerDocumentId) {
        root.dispatchEvent(
          new CustomEvent(workspaceEvents.open, {
            detail: { documentId: hit },
            bubbles: true,
          }),
        );
      }
      startAnimation();
    };

    const onPointerCancel = (event: PointerEvent): void => {
      touches.delete(event.pointerId);
      multitouch = multitouch && touches.size > 0;
      if (state.pointerId !== event.pointerId) return;
      clearPointer(event);
      draw(false);
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      state.zoom = Math.min(3.5, Math.max(0.35, state.zoom * factor));
      draw(false);
    };

    const themeObserver = new MutationObserver(() => draw(false));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvasWrap);
    const intersectionObserver =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true;
            if (visible && animationPending) startAnimation();
            else if (!visible) stopAnimation();
          })
        : null;
    intersectionObserver?.observe(root);
    const onVisibility = (): void => {
      visible = document.visibilityState !== 'hidden';
      if (visible && animationPending) startAnimation();
      else if (!visible) stopAnimation();
    };
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('lostpointercapture', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    recenterButton.addEventListener('click', fit);
    const serviceSubscription = service.onDidChange(() => void rebuild());
    resizeCanvas();
    void rebuild();

    return () => {
      disposed = true;
      updateControls.current = null;
      rebuildRef.current = null;
      buildSequence += 1;
      stopAnimation();
      clearPointer();
      serviceSubscription.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onPointerCancel);
      canvas.removeEventListener('wheel', onWheel);
      recenterButton.removeEventListener('click', fit);
    };
  }, [service, centerDocumentId, compact]);

  useEffect(() => {
    updateControls.current?.(settings, hiddenFormats);
  }, [settings, hiddenFormats, service, centerDocumentId, compact]);

  return (
    <div
      ref={rootRef}
      className={`${styles['graph-view']}${compact ? ` ${styles.compact}` : ''}`}
      data-fl-component={compact ? 'local-graph-view' : 'graph-view'}
    >
      {compact ? <h2 className={styles['graph-heading']}>Graph</h2> : null}
      <div className={styles['graph-toolbar']}>
        <Button
          ref={recenterRef}
          type="button"
          variant="secondary"
          className={compact ? undefined : surface.surface}
        >
          Recenter
        </Button>
        {!compact ? (
          <details className={`${styles['graph-settings']} ${surface.surface}`}>
            <summary>
              <Icon name="settings" size={16} />
              <span>Graph settings</span>
              <Icon name="chevron-down" size={14} />
            </summary>
            <div className={styles['graph-settings-body']}>
              <fieldset>
                <legend>Layout</legend>
                {(
                  [
                    ['repulsion', 'Repulsion', 25, 200],
                    ['attraction', 'Attraction', 10, 150],
                    ['distance', 'Link distance', 50, 200],
                    ['size', 'Node size', 50, 200],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <label className={styles['graph-slider']} key={key}>
                    <span>
                      {label}
                      <output>{settings[key]}%</output>
                    </span>
                    <Slider
                      min={min}
                      max={max}
                      step={5}
                      value={settings[key]}
                      aria-label={label}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          [key]: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Document types</legend>
                {formats.map(({ name, label, count }) => (
                  <label className={styles['graph-format']} key={name}>
                    <input
                      type="checkbox"
                      checked={!hiddenFormats.includes(name)}
                      onChange={(event) =>
                        setHiddenFormats((current) =>
                          event.target.checked
                            ? current.filter((format) => format !== name)
                            : [...current, name],
                        )
                      }
                    />
                    <span>{label}</span>
                    <small>{count}</small>
                  </label>
                ))}
              </fieldset>
              <div className={styles['graph-settings-actions']}>
                <Button
                  variant="secondary"
                  onClick={() => rebuildRef.current?.()}
                >
                  Rebuild graph
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSettings(defaultSettings);
                    setHiddenFormats([]);
                  }}
                >
                  Reset settings
                </Button>
              </div>
            </div>
          </details>
        ) : null}
        {compact ? (
          <Button type="button" variant="ghost" onClick={openFullGraph}>
            Open full graph
          </Button>
        ) : null}
      </div>
      <div ref={canvasWrapRef} className={styles['graph-canvas-wrap']}>
        <canvas
          ref={canvasRef}
          className={styles['graph-canvas']}
          role="img"
          aria-label={
            compact ? 'Direct document connections' : 'Workspace document graph'
          }
        />
        <div
          className={`${styles['graph-empty']}${empty ? '' : ` ${styles.hidden}`}`}
        >
          {compact
            ? 'No direct connections yet. This note stays at the center.'
            : hiddenFormats.length > 0
              ? 'No documents match these filters. Enable a document type in Graph settings.'
              : 'No notes yet — create a few and connect them.'}
        </div>
      </div>
      {compact && showNeighbors && neighbors.length > 0 ? (
        <nav className={styles['graph-neighbors']} aria-label="Connected notes">
          {neighbors.map((neighbor) => (
            <button
              key={neighbor.id}
              type="button"
              onClick={() => dispatchOpen(neighbor.id)}
            >
              <Icon name={neighbor.info.kindIcon ?? iconForPath(neighbor.info.path)} size={16} />
              <span className={styles['graph-neighbor-copy']}>
                <strong>{neighbor.info.label}</strong>
                <small>
                  {neighbor.outgoing} outgoing · {neighbor.incoming} incoming
                  {neighbor.types.length > 0
                    ? ` · ${neighbor.types.join(', ')}`
                    : ''}
                </small>
              </span>
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
