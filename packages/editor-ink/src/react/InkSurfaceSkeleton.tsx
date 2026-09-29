import './InkSurfaceSkeleton.css';
import type { InkSkeleton } from '../surface.js';

export type { InkSkeleton };

export interface InkSurfaceSkeletonProps {
  readonly presentation: 'paint-stage' | 'embedded-paper' | 'embedded-overlay';
  readonly navigationMode: 'standalone' | 'embedded' | 'locked';
  /**
   * Receives the committed skeleton elements during the synchronous commit.
   * The engine consumes them immediately after, so no effect round-trip is
   * involved: callback refs populate this exactly once on mount.
   */
  readonly skeletonRef: { current: InkSkeleton | null };
}

/**
 * Ink surface skeleton — declarative React over the exact DOM the engine
 * used to build imperatively (`fl-ink-root` with presentation/navigation
 * datasets, `fl-ink-page` with `fl-ink-canvas` and `fl-ink-badge`).
 *
 * The component never re-renders after mount (no state, stable props from
 * the provider), so engine-owned mutations inside these nodes — text
 * overlay, image picker, canvas frames — never fight React's reconciler.
 * The text-overlay container (`fl-ink-text-overlay-root`) is React-owned
 * chrome: the ephemeral editor mounts inside it and is
 * the only engine mutation allowed there.
 */
export function InkSurfaceSkeleton(
  props: InkSurfaceSkeletonProps,
): React.ReactElement {
  const { presentation, navigationMode, skeletonRef } = props;
  const refs: {
    root: HTMLDivElement | null;
    page: HTMLDivElement | null;
    canvas: HTMLCanvasElement | null;
    badge: HTMLDivElement | null;
    pointerIndicator: HTMLDivElement | null;
    overlayRoot: HTMLDivElement | null;
  } = { root: null, page: null, canvas: null, badge: null, pointerIndicator: null, overlayRoot: null };
  const collect = (): void => {
    if (
      refs.root !== null &&
      refs.page !== null &&
      refs.canvas !== null &&
      refs.badge !== null
      && refs.pointerIndicator !== null
      && refs.overlayRoot !== null
    ) {
      skeletonRef.current = {
        root: refs.root,
        page: refs.page,
        canvas: refs.canvas,
        badge: refs.badge,
        pointerIndicator: refs.pointerIndicator,
        overlayRoot: refs.overlayRoot,
      };
    }
  };
  return (
    <div
      ref={(element) => {
        refs.root = element;
        collect();
      }}
      className="fl-ink-root"
      data-presentation={presentation}
      data-navigation={navigationMode}
      tabIndex={0}
    >
      <div
        ref={(element) => {
          refs.page = element;
          collect();
        }}
        className="fl-ink-page"
      >
        <canvas
          ref={(element) => {
            refs.canvas = element;
            collect();
          }}
          className="fl-ink-canvas"
        />
        <div
          ref={(element) => {
            refs.badge = element;
            collect();
          }}
          className="fl-ink-badge"
        />
        <div
          ref={(element) => {
            refs.pointerIndicator = element;
            collect();
          }}
          className="fl-ink-pointer-indicator"
          aria-hidden="true"
        />
        <div
          ref={(element) => {
            refs.overlayRoot = element;
            collect();
          }}
          className="fl-ink-text-overlay-root"
        />
      </div>
    </div>
  );
}
