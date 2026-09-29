import './NotebookChrome.css';
import type { NotebookPagerSkeleton } from '../pager.js';

export type { NotebookPagerSkeleton };

export interface NotebookChromeProps {
  /**
   * Receives the committed pager skeleton elements during the synchronous
   * commit. The engine consumes them immediately after, so no effect
   * round-trip is involved: callback refs populate this exactly once on
   * mount.
   */
  readonly chromeRef: { current: NotebookPagerSkeleton | null };
}

/**
 * Notebook pager chrome — declarative React over the exact DOM the engine
 * used to build imperatively (`fl-nb` with image/PDF inputs, import
 * status, `fl-nb-main` with `fl-nb-scroll`/`fl-nb-stack`).
 *
 * The component never re-renders after mount (no state, stable props from
 * the provider), so engine-owned mutations inside these nodes — page
 * shells, empty notes, PDF bases, ink surfaces — never
 * fight React's reconciler.
 */
export function NotebookChrome(props: NotebookChromeProps): React.ReactElement {
  const { chromeRef } = props;
  const refs: {
    root: HTMLDivElement | null;
    imgInput: HTMLInputElement | null;
    pdfInput: HTMLInputElement | null;
    pdfImportStatus: HTMLDivElement | null;
    main: HTMLDivElement | null;
    scroll: HTMLDivElement | null;
    stack: HTMLDivElement | null;
  } = {
    root: null,
    imgInput: null,
    pdfInput: null,
    pdfImportStatus: null,
    main: null,
    scroll: null,
    stack: null,
  };
  const collect = (): void => {
    if (
      refs.root !== null &&
      refs.imgInput !== null &&
      refs.pdfInput !== null &&
      refs.pdfImportStatus !== null &&
      refs.main !== null &&
      refs.scroll !== null &&
      refs.stack !== null
    ) {
      chromeRef.current = {
        root: refs.root,
        imgInput: refs.imgInput,
        pdfInput: refs.pdfInput,
        pdfImportStatus: refs.pdfImportStatus,
        main: refs.main,
        scroll: refs.scroll,
        stack: refs.stack,
      };
    }
  };
  return (
    <div
      ref={(element) => {
        refs.root = element;
        collect();
      }}
      className="fl-nb"
      tabIndex={0}
    >
      <input
        ref={(element) => {
          refs.imgInput = element;
          collect();
        }}
        type="file"
        accept="image/*"
        hidden
      />
      <input
        ref={(element) => {
          refs.pdfInput = element;
          collect();
        }}
        type="file"
        accept="application/pdf,.pdf"
        hidden
      />
      <div
        ref={(element) => {
          refs.pdfImportStatus = element;
          collect();
        }}
        className="fl-nb-pdf-import-error"
        role="alert"
        hidden
      />
      <div
        ref={(element) => {
          refs.main = element;
          collect();
        }}
        className="fl-nb-main"
      >
        <div
          ref={(element) => {
            refs.scroll = element;
            collect();
          }}
          className="fl-nb-scroll"
        >
          <div
            ref={(element) => {
              refs.stack = element;
              collect();
            }}
            className="fl-nb-stack"
          />
        </div>
      </div>
    </div>
  );
}
