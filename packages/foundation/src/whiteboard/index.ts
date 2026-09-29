export {
  SURFACE_MAX_COORDINATE,
  SURFACE_MAX_STROKE_POINTS,
  SURFACE_MAX_TEXT_LENGTH,
  boundedFrame,
  infiniteFrame,
  emptyWhiteboard,
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
  WHITEBOARD_OBJECT_TYPES,
  type WhiteboardModel,
  type WhiteboardObjectRecord,
  type WhiteboardObjectId,
  type WhiteboardFrame,
  type CardGeometry,
  type ResourceEmbedGeometry,
} from './model.js';
export {
  WHITEBOARD_FORMAT_VERSION,
  WHITEBOARD_LIMITS,
  decodeWhiteboard,
  encodeWhiteboard,
  canonicalWhiteboardJson,
  type DecodeWhiteboardResult,
  type WhiteboardWarning,
} from './codec.js';
export { extractWhiteboardMetadata } from './metadata.js';
export { extractWhiteboardRelationships, type ExtractWhiteboardRelationshipsInput } from './relationships.js';
export { projectWhiteboardForSearch, type WhiteboardSearchProjection } from './search.js';
export { whiteboardKind, whiteboardKindId } from './kind.js';
