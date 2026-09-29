/**
 * @froglight/editor-ink — replaceable ink editor providers.
 *
 * Each document kind keeps its own `<Kind>DocumentEditorProvider` behind
 * this barrel. The document-agnostic surface engine (`surface.ts`) is
 * shared with whiteboard/notebook consumers; no canvas types cross the
 * document seams.
 */

export {
  InkDocumentEditorProvider,
  HeadlessInkEditorHandle,
  renderInkPreviewImage,
} from './editor.js';
export {
  mountInkSurface,
  seedBoundsFromSession,
  resolveMountSeeds,
  resolveMountReopen,
  INK_TOOL_IDS,
  MIN_ERASER_RADIUS,
  MAX_ERASER_RADIUS,
  twoPointShapeTool,
  type InkSkeleton,
  type InkSurfaceHandle,
  type InkSurfaceOptions,
  type MountReopen,
  type SurfaceLiveStyles,
} from './surface.js';
export {
  InkSurfaceSkeleton,
  type InkSurfaceSkeletonProps,
} from './react/InkSurfaceSkeleton.jsx';
export { createDerivedCachePackWorker } from './surface/derived-cache-packer.js';
export {
  surfacePaper,
  surfacePaperControls,
  executeSurfacePaperControl,
} from './paper.js';
export {
  createSurfaceImageCache,
  decodeImageBytes,
  fitImageBox,
  type DecodedImage,
  type ImageBox,
  type SurfaceImageCache,
  type SurfaceImageCacheOptions,
} from './images.js';
export { classifyPenButton, type PenButtonKind } from './surface/pointer.js';
export {
  PREDICTION_MAX_LOOKAHEAD_MS,
  PREDICTION_MAX_SCREEN_PX,
  clipPredictedToHorizon,
  shouldPredictForPointerType,
  type PredictionClipResult,
  type PredictionPolicyOptions,
} from './surface/prediction-policy.js';
export type { PointerTransportStats } from './surface/pointer-controller.js';
export {
  NAVIGATION_PHYSICS,
  VelocityTracker,
  cancelMotion,
  elasticZoom,
  inverseRubberBand,
  primaryTouchPair,
  rubberBand,
  startSpringMotion,
  stepDecay,
  stepMotion,
  stepSpring,
  type DecayStep,
  type ElasticZoomResult,
  type MotionState,
  type NavigationPhysicsConfig,
  type PrimaryTouchIds,
  type PrimaryTouchPair,
  type SpringStep,
  type TouchContact,
  type VelocityTrackerOptions,
} from './navigation/index.js';
export {
  RecentStylusActions,
  collectStylusDiagnostics,
  type StylusDiagnosticsSnapshot,
  type StylusPointerSample,
} from './surface/stylus-diagnostics.js';

export { createErasurePreparation } from './surface/erasure-preparation.js';
