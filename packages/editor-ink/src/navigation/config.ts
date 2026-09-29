/**
 * Shared tuning for touch navigation. Linear velocity is always CSS px/ms;
 * rates and angular frequency are per second. Values are ephemeral policy.
 */
export const NAVIGATION_PHYSICS = Object.freeze({
  rubberBandCoefficient: 0.55,
  rubberBandExtentPx: 120,
  elasticZoomLogExtent: Math.log(1.4),
  velocityWindowMs: 100,
  velocityMaxSamples: 8,
  decayRatePerSecond: 5.5,
  decayStopVelocityPxPerMs: 0.01,
  springAngularFrequencyPerSecond: 18,
  springPositionEpsilon: 0.001,
  springVelocityEpsilon: 0.001,
});

export type NavigationPhysicsConfig = typeof NAVIGATION_PHYSICS;
