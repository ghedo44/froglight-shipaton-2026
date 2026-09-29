/** App motion preference. CSS and scripted effects read the same root policy. */
export type MotionPreference = 'system' | 'on' | 'off';
export const MOTION_KEY = 'appearance.motion';

export function applyMotionPreference(value: unknown): { dispose(): void } {
  if (typeof document === 'undefined') return { dispose: () => undefined };
  const root = document.documentElement;
  const preference = value === 'on' || value === 'off' ? value : 'system';
  const previous = root.getAttribute('data-fl-motion');
  root.dataset.flMotion = preference;
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (root.dataset.flMotion !== preference) return;
      if (previous === null) delete root.dataset.flMotion;
      else root.setAttribute('data-fl-motion', previous);
    },
  };
}

/** Read at effect time so settings and OS changes apply without remounting. */
export function isMotionReduced(
  doc: Document | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): boolean {
  const preference = doc?.documentElement.dataset.flMotion;
  if (preference === 'on') return false;
  if (preference === 'off') return true;
  return (
    doc?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')
      .matches ?? false
  );
}
