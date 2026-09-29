/**
 * Whiteboard model helpers — infinite surface document.
 * Reuses the shared surface payload model; adds whiteboard-specific
 * constructors for `froglight.card` and `froglight.resource-embed`
 * (stable `DocumentRef` semantics, placement owned by board).
 */

export {
  SURFACE_MAX_COORDINATE,
  SURFACE_MAX_STROKE_POINTS,
  SURFACE_MAX_TEXT_LENGTH,
  boundedFrame,
  infiniteFrame,
  emptySurface as emptyWhiteboard,
  textObject,
  rectangleObject,
  ellipseObject,
  imageObject,
  inkStrokeObject,
  lineObject,
  cardObject,
  resourceEmbedObject,
  isCoreSurfaceObjectType,
  isValidCoreSurfaceObject,
  findGeometryLimitViolation,
  frameBounds,
  type SurfaceModel as WhiteboardModel,
  type SurfaceObjectRecord as WhiteboardObjectRecord,
  type SurfaceObjectId as WhiteboardObjectId,
  type SurfaceFrame as WhiteboardFrame,
  type CardGeometry,
  type ResourceEmbedGeometry,
  SURFACE_OBJECT_TYPES as WHITEBOARD_OBJECT_TYPES,
} from '../surfaces/model.js';
