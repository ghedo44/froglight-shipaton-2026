import { useEffect, useRef, useState } from 'react';
import type {
  CompositionRegistry,
  CompositionSnapshot,
  ResourceTarget,
} from '@froglight/foundation';
import { Icon } from './Icon.jsx';
import styles from './DatabaseView.module.css';

/** A bounded gallery consumer of the same provider previews used by embeds. */
export function DatabaseCardPreview({
  registry,
  target,
  kind,
}: {
  registry?: CompositionRegistry;
  target?: ResourceTarget | null;
  kind: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  const [snapshot, setSnapshot] = useState<CompositionSnapshot | null>(null);
  useEffect(() => {
    if (!registry || !target || !host.current) {
      setNearby(false);
      setSnapshot(null);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setNearby(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setNearby(visible);
        if (!visible) setSnapshot(null);
      },
      { rootMargin: '120px' },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [registry, target?.resourceId]);
  useEffect(() => {
    if (!nearby || !registry || !target) return;
    setSnapshot(null);
    let active = true;
    let handle: ReturnType<CompositionRegistry['open']>;
    try {
      handle = registry.open({ role: 'preview', target });
    } catch {
      return;
    }
    setSnapshot(handle.snapshot());
    const subscription = handle.onDidChange(() => {
      if (active) setSnapshot(handle.snapshot());
    });
    return () => {
      active = false;
      subscription.dispose();
      handle.dispose();
    };
  }, [
    nearby,
    registry,
    target?.documentId,
    target?.kindId,
    target?.resourceId,
  ]);
  return (
    <div ref={host} className={styles.galleryPreview}>
      {snapshot?.state === 'ready' && snapshot.image ? (
        <img src={snapshot.image.dataUrl} alt={snapshot.image.alt} />
      ) : snapshot?.state === 'ready' && snapshot.summary ? (
        <p>{snapshot.summary.slice(0, 180)}</p>
      ) : (
        <>
          <Icon name="file" size={32} />
          <span>{kind}</span>
        </>
      )}
    </div>
  );
}
