import { useEffect, useRef } from 'react';

/** Runs a trusted vault plugin's DOM mount inside the shell-owned window. */
export function CommunityActivityContent(props: {
  mount: (container: HTMLElement) => void | (() => void);
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const dispose = props.mount(container);
    return () => {
      if (typeof dispose === 'function') dispose();
      container.replaceChildren();
    };
  }, [props.mount]);
  return <div ref={ref} />;
}
