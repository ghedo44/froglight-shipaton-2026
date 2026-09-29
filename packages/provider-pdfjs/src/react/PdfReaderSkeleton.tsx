import './PdfReaderSkeleton.css';

export interface PdfSkeleton {
  readonly root: HTMLDivElement;
}

export interface PdfReaderSkeletonProps {
  /**
   * Receives the committed skeleton element during the synchronous commit.
   * The provider consumes it immediately after, so no effect round-trip is
   * involved: the callback ref populates this exactly once on mount.
   */
  readonly skeletonRef: { current: PdfSkeleton | null };
}

/**
 * PDF reader skeleton — declarative React over the stable reader wrapper
 * (`div.fl-pdf-reader`, focusable for keyboard navigation). Layout lives in
 * the colocated `PdfReaderSkeleton.css`.
 *
 * The component never re-renders after mount (no state, stable props from
 * the provider), so provider-owned mutations inside the root — mounted
 * PDF.js pages, placeholders — never fight React's reconciler.
 */
export function PdfReaderSkeleton(
  props: PdfReaderSkeletonProps,
): React.ReactElement {
  const { skeletonRef } = props;
  return (
    <div
      ref={(element) => {
        if (element !== null) {
          skeletonRef.current = { root: element };
        }
      }}
      className="fl-pdf-reader"
      tabIndex={0}
    />
  );
}
