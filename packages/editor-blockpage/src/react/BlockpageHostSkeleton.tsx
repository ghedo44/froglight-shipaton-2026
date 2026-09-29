import styles from './BlockpageHost.module.css';
import '../styles/prose-mirror.css';

/** Visible skeleton element: owned by React, consumed by the engine. */
export interface BlockpageSkeleton {
  readonly host: HTMLDivElement;
}

export interface BlockpageHostSkeletonProps {
  /**
   * Receives the committed host element during the synchronous commit.
   * The engine consumes it immediately after, so no effect round-trip is
   * involved: the callback ref populates this exactly once on mount.
   */
  readonly skeletonRef: { current: BlockpageSkeleton | null };
}

/**
 * Blockpage host skeleton — declarative React over the exact DOM the engine
 * used to build imperatively (the colocated host module plus the `flbp-host`
 * sizing contract; the module gives the host flex sizing, height, scroll,
 * and the shared writing column).
 *
 * The component never re-renders after mount (no state, stable props from
 * the provider), so engine-owned mutations inside this node — the
 * ProseMirror surface, slash/resource menus, drag handle, drop line —
 * never fight React's reconciler.
 *
 * Host-owned media picker slot: the hidden
 * `input[data-flbp-media-picker]` below is the ONLY file chooser in the
 * provider. Engine media figures never create an `<input type=file>`
 * (that would be provider toolbar DOM); empty cards' Add/Capture buttons and
 * the shared contextual toolbar's Replace action dispatch a bubbling
 * `flbp:pick-media` event the host answers by clicking this input in the same
 * task (gesture-preserving). The picked files are
 * re-dispatched as `flbp:media-picked`, which the engine handle answers
 * by routing the first file into the existing
 * `uploadMedia(blockId, bytes)` primitive — the skeleton never
 * touches the vault directly, so grid refusal and single-undo hold.
 */
export function BlockpageHostSkeleton(
  props: BlockpageHostSkeletonProps,
): React.ReactElement {
  const { skeletonRef } = props;
  return (
    <div
      ref={(element) => {
        if (element === null) {
          skeletonRef.current = null;
          return;
        }
        skeletonRef.current = { host: element };
        wireMediaPicker(element);
      }}
      className={`${styles['froglight-blockpage']} flbp-host`}
    >
      <div data-fl-document-title-slot="editor" />
      <input
        type="file"
        data-flbp-media-picker=""
        hidden
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

/** Media kind → file-chooser accept filter (file kinds accept anything). */
function acceptForKind(kind: string): string | null {
  if (kind === 'image') return 'image/*';
  if (kind === 'video') return 'video/*';
  if (kind === 'audio') return 'audio/*';
  return null;
}

interface MediaPickDetail {
  readonly blockId?: unknown;
  readonly kind?: unknown;
  readonly capture?: unknown;
}

/** Wire once per host element; unmount drops the whole subtree (no leak). */
function wireMediaPicker(host: HTMLDivElement): void {
  if (host.dataset.flbpPickerWired === 'true') return;
  host.dataset.flbpPickerWired = 'true';
  const picker = (): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>('input[data-flbp-media-picker]');
  const onPick = (event: Event): void => {
    const detail = (event as CustomEvent<MediaPickDetail>).detail ?? {};
    const blockId = typeof detail.blockId === 'string' ? detail.blockId : '';
    const kind = typeof detail.kind === 'string' ? detail.kind : '';
    const capture = detail.capture === true;
    if (blockId === '') return;
    const input = picker();
    if (input === null) return;
    const accept = acceptForKind(kind);
    if (accept !== null) input.accept = accept;
    else input.removeAttribute('accept');
    if (capture) input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    input.dataset.flbpBlockId = blockId;
    input.dataset.flbpKind = kind;
    input.dataset.flbpCapture = capture ? 'true' : 'false';
    try {
      input.click();
    } catch {
      // jsdom and headless harnesses: click is a no-op, never a throw.
    }
  };
  const onPicked = (): void => {
    const input = picker();
    if (input === null) return;
    const blockId = input.dataset.flbpBlockId ?? '';
    const files = input.files;
    // Cancel (no files) or a stale change without a pending pick: clear the
    // value so the same file can be chosen next time, no event, no mutation.
    if (blockId === '' || files === null || files.length === 0) {
      try {
        input.value = '';
      } catch {
        // Best-effort (jsdom value setter quirks).
      }
      delete input.dataset.flbpBlockId;
      delete input.dataset.flbpKind;
      delete input.dataset.flbpCapture;
      return;
    }
    const kind = input.dataset.flbpKind ?? '';
    const capture = input.dataset.flbpCapture === 'true';
    const snapshot: File[] = [...files];
    try {
      host.dispatchEvent(
        new CustomEvent('flbp:media-picked', {
          detail: { blockId, kind, capture, files: snapshot },
          bubbles: true,
          cancelable: false,
        }),
      );
    } catch {
      // Best-effort answer event; the app harness may be absent in tests.
    }
    try {
      input.value = '';
    } catch {
      // Best-effort reset.
    }
    delete input.dataset.flbpBlockId;
    delete input.dataset.flbpKind;
    delete input.dataset.flbpCapture;
  };
  host.addEventListener('flbp:pick-media', onPick as EventListener);
  const input = picker();
  input?.addEventListener('change', onPicked);
  input?.addEventListener('cancel', onPicked);
}
