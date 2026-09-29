import { stepSpring } from './physics.js';
import { NAVIGATION_PHYSICS } from './config.js';

export type MotionState =
  | { readonly kind: 'idle'; readonly value: number }
  | {
      readonly kind: 'spring';
      readonly value: number;
      readonly velocity: number;
      readonly target: number;
    };

export function startSpringMotion(
  value: number,
  target: number,
  velocity = 0,
  reducedMotion = false,
): MotionState {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const safeValue = Number.isFinite(value) ? value : safeTarget;
  const safeVelocity = Number.isFinite(velocity) ? velocity : 0;
  if (
    reducedMotion ||
    (safeValue === safeTarget &&
      Math.abs(safeVelocity) <= NAVIGATION_PHYSICS.springVelocityEpsilon)
  )
    return { kind: 'idle', value: safeTarget };
  return {
    kind: 'spring',
    value: safeValue,
    velocity: safeVelocity,
    target: safeTarget,
  };
}

export function cancelMotion(state: MotionState): MotionState {
  return { kind: 'idle', value: state.value };
}

export function stepMotion(
  state: MotionState,
  deltaTimeMs: number,
): MotionState {
  if (state.kind === 'idle') {
    return {
      kind: 'idle',
      value: Number.isFinite(state.value) ? state.value : 0,
    };
  }
  const target = Number.isFinite(state.target) ? state.target : 0;
  const value = Number.isFinite(state.value) ? state.value : target;
  const velocity = Number.isFinite(state.velocity) ? state.velocity : 0;
  const next = stepSpring(value, velocity, target, deltaTimeMs);
  return next.active
    ? {
        kind: 'spring',
        value: next.value,
        velocity: next.velocity,
        target,
      }
    : { kind: 'idle', value: target };
}
