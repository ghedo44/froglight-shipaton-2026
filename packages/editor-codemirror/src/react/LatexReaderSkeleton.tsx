import './LatexReaderSkeleton.css';
import { PREVIEW_SANDBOX, latexPlaceholderDocument } from '../latex-shared.js';
import type { LatexReaderSkeleton } from '../latex-reader.js';

export interface LatexReaderSkeletonProps {
  /**
   * Receives the committed skeleton elements during the synchronous commit.
   * The engine consumes them immediately after, so no effect round-trip is
   * involved: callback refs populate this exactly once on mount.
   */
  readonly skeletonRef: { current: LatexReaderSkeleton | null };
}

/**
 * LaTeX reader skeleton — declarative React over the reader chrome
 * (`froglight-latex-reader` wrapper with a sandboxed preview iframe).
 * Layout lives in the colocated `LatexReaderSkeleton.css`; the
 * component never re-renders after mount (no state, stable props from
 * the provider), so engine-owned `srcdoc` swaps inside the iframe never
 * fight React's reconciler. The iframe content is provider-derived
 * content, not React-owned application DOM.
 */
export function LatexReaderSkeleton(
  props: LatexReaderSkeletonProps,
): React.ReactElement {
  const { skeletonRef } = props;
  const refs: {
    root: HTMLDivElement | null;
    frame: HTMLIFrameElement | null;
  } = { root: null, frame: null };
  const collect = (): void => {
    if (refs.root !== null && refs.frame !== null) {
      skeletonRef.current = { root: refs.root, frame: refs.frame };
    }
  };
  return (
    <div
      ref={(element) => {
        refs.root = element;
        collect();
      }}
      className="froglight-latex-reader"
    >
      <iframe
        ref={(element) => {
          refs.frame = element;
          collect();
        }}
        sandbox={PREVIEW_SANDBOX}
        title="LaTeX preview"
        className="froglight-latex-frame"
        srcDoc={latexPlaceholderDocument('LaTeX preview', 'Rendering…')}
      />
    </div>
  );
}
