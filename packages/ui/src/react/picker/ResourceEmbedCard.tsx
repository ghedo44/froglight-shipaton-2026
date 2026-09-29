/**
 * Surface reference activation card.
 *
 * Operates on one `froglight.resource-embed` surface record by pointer,
 * touch, and keyboard. Reuses `CompositionRegistry` with the `preview`
 * role (lazy mount via visibility, depth/cycle/placeholder policy and the
 * `open-source` none-authority action owned by the registry); the `link`
 * presentation renders a chip with no composition handle and a single
 * reveal/open action. Navigation goes through the existing
 * `openResource`/`openSource` → `navigation.push` seam (application
 * layer); this component invents no URI scheme and never stores browser
 * URLs as identity — stable `DocumentRef`/`ResourceTarget` only.
 *
 * Dangling targets render a distinct dashed placeholder with
 * replace/remove (the component never auto-deletes). Remove deletes only
 * the reference record; copy-link writes `formatResourceLink(target)` and
 * `parseResourceLink` resolves it back to the same location.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  CompositionHandle,
  CompositionRegistry,
  CompositionSnapshot,
  ResourceTarget,
} from '@froglight/foundation';
import { resolveSurfaceEmbedPresentation } from './embed-presentation.js';
import { copyResourceLink, formatResourceLink } from './resource-link.js';
import styles from './picker.module.css';

export interface SurfaceEmbedActivationRecord {
  readonly id: string;
  readonly type: string;
  readonly target?: unknown;
  readonly cachedTitle?: unknown;
  readonly cachedKind?: unknown;
  readonly [key: string]: unknown;
}

export interface ResourceEmbedCardProps {
  /** The live surface record (`froglight.resource-embed`). */
  readonly record: SurfaceEmbedActivationRecord;
  /** Composition registry for `preview` mounts (absent keeps link/placeholder). */
  readonly compositionRegistry?: CompositionRegistry;
  /** Ancestry for cycle/depth policy (outermost-first target keys). */
  readonly ancestry?: readonly string[];
  /** True when the host already knows the target is dangling. */
  readonly dangling?: boolean;
  /** Open the target in place (application `navigation.push`). */
  readonly openResource: (target: ResourceTarget) => void;
  /** Open the target beside the current pane (split). Falls back to open. */
  readonly openBeside?: (target: ResourceTarget) => void;
  /** Replace the reference target (host reopens the picker). */
  readonly onReplace: (id: string) => void;
  /** Remove only the reference record (never target content). */
  readonly onRemove: (id: string) => void;
  /** Optional host override for clipboard writes (tests/host telemetry). */
  readonly copyLink?: (target: ResourceTarget) => Promise<boolean> | boolean;
}

function readTarget(record: SurfaceEmbedActivationRecord): ResourceTarget | null {
  const target = record.target as Record<string, unknown> | null | undefined;
  if (typeof target !== 'object' || target === null || Array.isArray(target))
    return null;
  const { documentId, kindId, resourceId, address } = target;
  if (
    typeof documentId !== 'string' ||
    documentId === '' ||
    typeof kindId !== 'string' ||
    kindId === '' ||
    typeof resourceId !== 'string' ||
    resourceId === ''
  ) {
    return null;
  }
  return {
    documentId,
    kindId,
    resourceId,
    ...(typeof address === 'string' && address !== '' ? { address } : {}),
  };
}

function titleOf(record: SurfaceEmbedActivationRecord): string {
  if (typeof record.cachedTitle === 'string' && record.cachedTitle.trim() !== '')
    return record.cachedTitle;
  const target = readTarget(record);
  if (target === null) return 'Reference';
  return target.resourceId;
}

function kindOf(record: SurfaceEmbedActivationRecord): string | null {
  return typeof record.cachedKind === 'string' &&
    record.cachedKind.trim() !== ''
    ? record.cachedKind
    : null;
}

export function ResourceEmbedCard(props: ResourceEmbedCardProps): React.ReactElement {
  const {
    record,
    compositionRegistry,
    ancestry = [],
    dangling = false,
    openResource,
    openBeside,
    onReplace,
    onRemove,
    copyLink,
  } = props;
  const presentation = resolveSurfaceEmbedPresentation(record);
  const target = readTarget(record);
  const [visible, setVisible] = useState(false);
  const [snapshot, setSnapshot] = useState<CompositionSnapshot | null>(null);
  const [copied, setCopied] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CompositionHandle | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== undefined) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const title = titleOf(record);
  const kind = kindOf(record);
  const targetKey =
    target === null
      ? ''
      : `${target.documentId}${target.kindId}${target.resourceId}${target.address ?? ''}`;
  const ancestryKey = ancestry.join('');

  // Lazy mount via visibility: the preview handle opens only while the
  // card is near the viewport; off-screen release is disposal.
  useEffect(() => {
    const element = hostRef.current;
    if (element === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setVisible(true);
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    if (presentation.mode !== 'preview') return;
    if (targetKey === '') return;
    if (compositionRegistry === undefined) return;
    // Re-derive the stable target from the key so the effect subscribes to
    // identity, not per-render object allocation.
    const live = readTarget(record);
    if (live === null) return;
    const liveAncestry = ancestryKey === '' ? [] : ancestryKey.split('');
    let disposed = false;
    let handle: CompositionHandle | null = null;
    try {
      handle = compositionRegistry.open({
        role: 'preview',
        target: live,
        ancestry: liveAncestry,
      });
    } catch {
      setSnapshot({
        state: 'placeholder',
        reason: 'provider-error',
        message: 'Preview unavailable. Open the source or replace this reference.',
        recoverable: true,
        actions: [{ id: 'open-source', label: 'Open source', authority: 'none' }],
      });
      return;
    }
    handleRef.current = handle;
    setSnapshot(handle.snapshot());
    const subscription = handle.onDidChange(() => {
      if (!disposed && handle !== null) setSnapshot(handle.snapshot());
    });
    return () => {
      disposed = true;
      subscription.dispose();
      handle?.dispose();
      handleRef.current = null;
    };
    // `record` carries the live target/ancestry via the stable keys above.
  }, [visible, presentation.mode, compositionRegistry, targetKey, ancestryKey]);

  const isDangling =
    dangling ||
    target === null ||
    (snapshot !== null &&
      snapshot.state === 'placeholder' &&
      (snapshot.reason === 'missing-target' ||
        snapshot.reason === 'missing-provider' ||
        snapshot.reason === 'unsupported-address' ||
        snapshot.reason === 'corrupt' ||
        snapshot.reason === 'permission-denied'));

  const open = (): void => {
    if (target === null) return;
    openResource(target);
  };

  const openAside = (): void => {
    if (target === null) return;
    if (openBeside !== undefined) openBeside(target);
    else openResource(target);
  };

  const copy = async (): Promise<void> => {
    if (target === null) return;
    const ok =
      copyLink !== undefined
        ? await copyLink(target)
        : await copyResourceLink(target);
    if (ok) {
      setCopied(true);
      if (copyTimerRef.current !== undefined) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    }
  };

  // Link presentation: compact chip, no composition handle, single
  // reveal/open action plus the standard reference operations.
  if (presentation.mode === 'link') {
    return (
      <div
        ref={hostRef}
        className={styles['embed-card']}
        data-fl-component="resource-embed-card"
        data-presentation="link"
        data-dangling={isDangling}
      >
        <button
          type="button"
          className={styles['embed-chip']}
          aria-label={isDangling ? `Unavailable reference ${title}, activate to open` : `Open reference ${title}`}
          disabled={target === null}
          onClick={open}
        >
          <span aria-hidden="true">🔗</span>
          <span className={styles['embed-title']}>{title}</span>
        </button>
        {isDangling && (
          <div role="status" className={styles['embed-placeholder']}>
            Reference unavailable. The link is kept; replace it or remove only
            this reference.
          </div>
        )}
        <div className={styles['embed-actions']}>
          <button
            type="button"
            className={styles['embed-action']}
            aria-label={`Open reference ${title} beside`}
            disabled={target === null}
            onClick={openAside}
          >
            Open beside
          </button>
          <button
            type="button"
            className={styles['embed-action']}
            aria-label={`Copy link for ${title}`}
            disabled={target === null}
            onClick={() => void copy()}
            title={target === null ? undefined : formatResourceLink(target)}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <button
            type="button"
            className={styles['embed-action']}
            aria-label={`Replace reference ${title}`}
            onClick={() => onReplace(record.id)}
          >
            Replace
          </button>
          <button
            type="button"
            className={styles['embed-action']}
            data-danger="true"
            aria-label={`Remove reference ${title}`}
            onClick={() => onRemove(record.id)}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className={styles['embed-card']}
      data-fl-component="resource-embed-card"
      data-presentation="preview"
      data-dangling={isDangling}
    >
      <div className={styles['embed-title']}>{title}</div>
      {kind !== null && <div className={styles['embed-kind']}>{kind}</div>}
      {presentation.unknown && (
        <div role="note" className={styles['embed-kind']}>
          Unknown presentation preserved.
        </div>
      )}
      {isDangling ? (
        <div role="status" className={styles['embed-placeholder']}>
          Reference unavailable. The frame is kept; replace it or remove only
          this reference.
        </div>
      ) : snapshot === null || snapshot.state === 'loading' ? (
        <div className={styles['embed-preview']} aria-busy="true">
          Loading preview…
        </div>
      ) : snapshot.state === 'placeholder' ? (
        <div role="status" className={styles['embed-placeholder']}>
          {snapshot.message}
          {snapshot.actions?.some((action) => action.id === 'open-source') && (
            <div className={styles['embed-actions']}>
              <button
                type="button"
                className={styles['embed-action']}
                onClick={() => void handleRef.current?.invoke?.('open-source')}
              >
                Open source
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className={styles['embed-preview']}>
          {snapshot.title !== undefined && <div>{snapshot.title}</div>}
          {snapshot.summary !== undefined && <div>{snapshot.summary}</div>}
          {snapshot.actions?.some((action) => action.id === 'open-source') && (
            <div className={styles['embed-actions']}>
              <button
                type="button"
                className={styles['embed-action']}
                onClick={() => void handleRef.current?.invoke?.('open-source')}
              >
                Open source
              </button>
            </div>
          )}
        </div>
      )}
      <div className={styles['embed-actions']}>
        <button
          type="button"
          className={styles['embed-action']}
          aria-label={`Open ${title}`}
          disabled={target === null}
          onClick={open}
        >
          Open
        </button>
        <button
          type="button"
          className={styles['embed-action']}
          aria-label={`Open ${title} beside`}
          disabled={target === null}
          onClick={openAside}
        >
          Open beside
        </button>
        <button
          type="button"
          className={styles['embed-action']}
          aria-label={`Copy link for ${title}`}
          disabled={target === null}
          onClick={() => void copy()}
          title={target === null ? undefined : formatResourceLink(target)}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button
          type="button"
          className={styles['embed-action']}
          aria-label={`Replace ${title}`}
          onClick={() => onReplace(record.id)}
        >
          Replace
        </button>
        <button
          type="button"
          className={styles['embed-action']}
          data-danger="true"
          aria-label={`Remove ${title}`}
          onClick={() => onRemove(record.id)}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
