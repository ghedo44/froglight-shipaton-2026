/**
 * FLIP glide animator (keyboard coordinator split).
 *
 * Compositor-glide duration policy lives here and the ShellController in
 * `../keyboard-inset.js` calls it; per-node travel measurement stays with
 * the controller until the animator owns the full glide lifecycle.
 */

export const ANDROID_MAX_GLIDE_MS = 220;

/** Clamp the native duration to the compositor glide budget. */
export function glideDurationFor(input: {
  readonly durationMs: number;
  readonly isAndroid: boolean;
  readonly reduceMotion: boolean;
}): number {
  if (input.reduceMotion) return 0;
  return input.isAndroid
    ? Math.min(input.durationMs, ANDROID_MAX_GLIDE_MS)
    : input.durationMs;
}
