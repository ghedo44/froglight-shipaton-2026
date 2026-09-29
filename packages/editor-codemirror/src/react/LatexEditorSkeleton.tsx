import './LatexEditorSkeleton.css';
import type { LatexEditorSkeleton } from '../latex.js';

export interface LatexEditorSkeletonProps {
  /**
   * Receives the committed skeleton elements during the synchronous commit.
   * The engine consumes them immediately after, so no effect round-trip is
   * involved: callback refs populate this exactly once on mount.
   */
  readonly skeletonRef: { current: LatexEditorSkeleton | null };
}

/**
 * LaTeX source-editor skeleton — declarative React over the editor chrome
 * (editor wrapper with a single source pane). Diagnostics and status live
 * in the unified toolbar as semantic controls; edit mode keeps no permanent
 * provider-owned status strip so floating islands never regain extra
 * vertical chrome. Layout lives in the colocated
 * `LatexEditorSkeleton.css`.
 *
 * The component never re-renders after mount (no state, stable props from
 * the provider), so CodeMirror-owned mutations inside the source pane never
 * fight React's reconciler.
 */
export function LatexEditorSkeleton(
  props: LatexEditorSkeletonProps,
): React.ReactElement {
  const { skeletonRef } = props;
  const refs: {
    root: HTMLDivElement | null;
    source: HTMLDivElement | null;
  } = { root: null, source: null };
  const collect = (): void => {
    if (refs.root !== null && refs.source !== null) {
      skeletonRef.current = {
        root: refs.root,
        source: refs.source,
      };
    }
  };
  return (
    <div
      ref={(element) => {
        refs.root = element;
        collect();
      }}
      className="froglight-latex-editor"
    >
      <div
        ref={(element) => {
          refs.source = element;
          collect();
        }}
        className="froglight-latex-source"
      />
    </div>
  );
}
