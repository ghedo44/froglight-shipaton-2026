import { useEffect, useRef, useState } from 'react';
import { useObjectUrl } from './shared.js';
import { IconButton } from '../Button.jsx';
import styles from './FilePreview.module.css';

const ZOOM_STEP = 1.25;
const MAX_SCALE = 8;
const TAP_SLOP_PX = 8;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP_PX = 40;
const KEY_PAN_PX = 48;

interface Point {
  readonly x: number;
  readonly y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Zoomable image surface. Wheel zooms at the cursor (trackpad pinch arrives
 * as ctrl+wheel and is owned, never leaking into browser page zoom),
 * two-finger touch pinches around its midpoint, dragging pans while zoomed,
 * double-click/double-tap toggles fit versus actual pixels, and the toolbar
 * plus keyboard cover the rest. The image lays out at natural size with a
 * translate/scale transform, so the zoom math never fights CSS sizing.
 */
export function ImagePreview(props: {
  blob: Blob;
  name: string;
}): React.ReactElement {
  const url = useObjectUrl(props.blob);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Point>({ x: 0, y: 0 });
  const [natural, setNatural] = useState<Point | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [animated, setAnimated] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const pinchDist = useRef<number | null>(null);
  const down = useRef<{
    point: Point;
    pan: Point;
    time: number;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef<{ time: number; point: Point } | null>(null);
  const manual = useRef(false);

  const fit =
    natural === null || box.x <= 0 || box.y <= 0
      ? 1
      : Math.min(box.x / natural.x, box.y / natural.y, 1);
  const zoomed = natural !== null && scale > fit + 1e-6;

  const clampPan = (next: Point, nextScale: number): Point => {
    if (natural === null) return { x: 0, y: 0 };
    const drawnWidth = natural.x * nextScale;
    const drawnHeight = natural.y * nextScale;
    const centerX = (box.x - drawnWidth) / 2;
    const centerY = (box.y - drawnHeight) / 2;
    return {
      x: drawnWidth > box.x ? clamp(next.x, centerX, -centerX) : 0,
      y: drawnHeight > box.y ? clamp(next.y, centerY, -centerY) : 0,
    };
  };

  const zoomAt = (point: Point, factor: number, animate: boolean): void => {
    if (natural === null) return;
    const next = clamp(scale * factor, fit, MAX_SCALE);
    if (next === scale) return;
    const centerX = (box.x - natural.x * scale) / 2;
    const centerY = (box.y - natural.y * scale) / 2;
    const nextCenterX = (box.x - natural.x * next) / 2;
    const nextCenterY = (box.y - natural.y * next) / 2;
    const imageX = (point.x - centerX - pan.x) / scale;
    const imageY = (point.y - centerY - pan.y) / scale;
    manual.current = true;
    setAnimated(animate);
    setScale(next);
    setPan(
      clampPan(
        {
          x: point.x - nextCenterX - imageX * next,
          y: point.y - nextCenterY - imageY * next,
        },
        next,
      ),
    );
  };
  // The native wheel listener below cannot see fresh render-scope closures,
  // so it reads the latest zoom through this ref instead.
  const zoomAtRef = useRef(zoomAt);

  // A fresh blob (every activation refetches) resets the camera.
  useEffect(() => {
    manual.current = false;
    setScale(1);
    setPan({ x: 0, y: 0 });
    setNatural(null);
  }, [props.blob]);

  // Measure the stage; environments without ResizeObserver keep a zero box
  // and the image simply renders unfitted until one exists. Re-runs when the
  // blob resolves because the viewer div only mounts once `url` is ready.
  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setBox({ x: rect.width, y: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [url]);

  // Until the user takes over, track the fit scale across loads and resizes.
  useEffect(() => {
    if (manual.current) return;
    setScale(fit);
    setPan({ x: 0, y: 0 });
  }, [fit]);

  // Native listener: wheel must be non-passive to own ctrl+wheel (browser
  // page zoom) instead of letting it through.
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015));
      zoomAtRef.current(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        factor,
        false,
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [url]);

    if (url === null)
      return (
        <div className={styles['file-preview-loading']} aria-hidden="true" />
      );
  zoomAtRef.current = zoomAt;

  const reset = (animate: boolean): void => {
    manual.current = false;
    setAnimated(animate);
    setScale(fit);
    setPan({ x: 0, y: 0 });
  };

  const toggle = (point: Point): void => {
    if (natural === null) return;
    if (!zoomed) {
      const target = fit >= 1 ? 2 : 1;
      zoomAt(point, target / scale, true);
    } else {
      reset(true);
    }
  };

  const toLocal = (clientX: number, clientY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const center: Point = { x: box.x / 2, y: box.y / 2 };
  const drawnWidth = natural === null ? 0 : natural.x * scale;
  const drawnHeight = natural === null ? 0 : natural.y * scale;
  const originX = (box.x - drawnWidth) / 2;
  const originY = (box.y - drawnHeight) / 2;

  const onPointerDown = (event: React.PointerEvent): void => {
    if (
      (event.target as HTMLElement).closest('.image-zoom-controls') !== null
    ) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone; tracking it would strand the gesture.
      return;
    }
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size === 2) {
      const [first, second] = [...pointers.current.values()] as [
        Point,
        Point,
      ];
      pinchDist.current = Math.hypot(first.x - second.x, first.y - second.y);
      down.current = null;
      setDragging(false);
    } else if (pointers.current.size === 1) {
      down.current = {
        point: { x: event.clientX, y: event.clientY },
        pan,
        time: performance.now(),
        moved: false,
      };
    }
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    if (pointers.current.get(event.pointerId) === undefined) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      const [first, second] = [...pointers.current.values()] as [
        Point,
        Point,
      ];
      const dist = Math.hypot(first.x - second.x, first.y - second.y);
      const previous = pinchDist.current;
      pinchDist.current = dist;
      if (previous !== null && previous > 0 && dist > 0) {
        zoomAt(
          toLocal((first.x + second.x) / 2, (first.y + second.y) / 2),
          dist / previous,
          false,
        );
      }
      return;
    }
    const gesture = down.current;
    if (gesture === null) return;
    const dx = point.x - gesture.point.x;
    const dy = point.y - gesture.point.y;
    if (!gesture.moved && Math.hypot(dx, dy) > TAP_SLOP_PX) {
      gesture.moved = true;
    }
    if (gesture.moved && zoomed) {
      manual.current = true;
      setAnimated(false);
      setPan(
        clampPan({ x: gesture.pan.x + dx, y: gesture.pan.y + dy }, scale),
      );
      setDragging(true);
    }
  };

  const finishPointer = (event: React.PointerEvent, tapped: boolean): void => {
    const gesture = pointers.current.size === 1 ? down.current : null;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchDist.current = null;
    if (pointers.current.size === 0) {
      setDragging(false);
      down.current = null;
    }
    if (tapped && gesture !== null && !gesture.moved) {
      const now = performance.now();
      const local = toLocal(gesture.point.x, gesture.point.y);
      const previous = lastTap.current;
      if (
        previous !== null &&
        now - previous.time < DOUBLE_TAP_MS &&
        Math.hypot(local.x - previous.point.x, local.y - previous.point.y) <
          DOUBLE_TAP_SLOP_PX
      ) {
        lastTap.current = null;
        toggle(local);
      } else {
        lastTap.current = { time: now, point: local };
      }
    }
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAt(center, ZOOM_STEP, true);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomAt(center, 1 / ZOOM_STEP, true);
    } else if (event.key === '0') {
      event.preventDefault();
      reset(true);
    } else if (event.key.startsWith('Arrow')) {
      if (!zoomed) return;
      event.preventDefault();
      const delta =
        event.key === 'ArrowLeft'
          ? { x: KEY_PAN_PX, y: 0 }
          : event.key === 'ArrowRight'
            ? { x: -KEY_PAN_PX, y: 0 }
            : event.key === 'ArrowUp'
              ? { x: 0, y: KEY_PAN_PX }
              : { x: 0, y: -KEY_PAN_PX };
      manual.current = true;
      setAnimated(false);
      setPan(clampPan({ x: pan.x + delta.x, y: pan.y + delta.y }, scale));
    }
  };

  return (
    <div
      ref={containerRef}
      className={styles['image-viewer']}
      tabIndex={0}
      role="group"
      aria-roledescription="image viewer"
      aria-label={`${props.name}. Plus zooms in, minus zooms out, 0 resets.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishPointer(event, true)}
      onPointerCancel={(event) => finishPointer(event, false)}
      onKeyDown={onKeyDown}
    >
      <img
        src={url}
        alt={props.name}
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            setNatural({ x: image.naturalWidth, y: image.naturalHeight });
          }
        }}
        style={{
          left: originX,
          top: originY,
          ...(natural === null
            ? {}
            : {
                width: natural.x,
                height: natural.y,
                maxWidth: 'none',
                maxHeight: 'none',
              }),
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: '0 0',
          transition: animated ? 'transform 120ms ease-out' : 'none',
          cursor: dragging ? 'grabbing' : zoomed ? 'grab' : 'default',
          position: 'absolute',
        }}
      />
      {natural === null ? null : (
        <div
          className={styles['image-zoom-controls']}
          role="toolbar"
          aria-label="Image zoom"
        >
          <IconButton
            icon="minus"
            size={15}
            label="Zoom out"
            title="Zoom out (−)"
            onClick={() => zoomAt(center, 1 / ZOOM_STEP, true)}
          />
          <button
            type="button"
            className={styles['image-zoom-level']}
            title="Reset zoom"
            aria-label={`Reset zoom, currently ${Math.round(scale * 100)} percent`}
            onClick={() => reset(true)}
          >
            {`${Math.round(scale * 100)}%`}
          </button>
          <IconButton
            icon="plus"
            size={15}
            label="Zoom in"
            title="Zoom in (+)"
            onClick={() => zoomAt(center, ZOOM_STEP, true)}
          />
        </div>
      )}
    </div>
  );
}
