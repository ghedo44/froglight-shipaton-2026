import type { MarkdownSkeleton } from '../markdown.js';
import styles from './CodemirrorHost.module.css';

export interface CodemirrorMarkdownSkeletonProps {
  /**
   * Receives the committed skeleton element during the synchronous commit.
   * The engine consumes it immediately after, so no effect round-trip is
   * involved: the callback ref populates this exactly once on mount.
   */
  readonly skeletonRef: { current: MarkdownSkeleton | null };
}

/**
 * Markdown editor skeleton — declarative React over the exact DOM the engine
 * used to build imperatively (`froglight-markdown-editor` plus the colocated
 * host module, height 100%).
 *
 * The component never re-renders after mount (no state, stable props from
 * the provider), so CodeMirror-owned mutations inside — `.cm-editor`,
 * selection, decorations — never fight React's reconciler.
 */
export function CodemirrorMarkdownSkeleton(
  props: CodemirrorMarkdownSkeletonProps,
): React.ReactElement {
  const { skeletonRef } = props;
  return (
    <div
      ref={(element) => {
        if (element !== null) skeletonRef.current = { root: element };
      }}
      className={`froglight-markdown-editor ${styles['froglight-cm-host']}`}
    />
  );
}
