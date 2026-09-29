/**
 * Shared surface reference picker barrel.
 *
 * Whiteboard and Notebook hosts consume the picker model, dialog, stable
 * link codec, tolerant presentation read, and activation card from here so
 * both surfaces share one search/recent/keyboard/empty-state contract and
 * one open/open-beside/copy-link/replace/remove activation contract.
 */

export {
  activeSuggestion,
  clampActiveIndex,
  createRecentResourceStore,
  filterSuggestions,
  isNoMatch,
  moveActiveIndex,
  noMatchCopy,
  RESOURCE_PICKER_RECENT_LIMIT,
  type RecentResourceEntry,
} from './resource-picker-model.js';
export {
  copyResourceLink,
  formatResourceLink,
  parseResourceLink,
} from './resource-link.js';
export {
  resolveSurfaceEmbedPresentation,
  surfaceEmbedPresentationModeOf,
  type ResolvedSurfaceEmbedPresentation,
  type SurfaceEmbedPresentationMode,
} from './embed-presentation.js';
export { ResourcePicker, type ResourcePickerProps } from './ResourcePicker.jsx';
export {
  ResourceEmbedCard,
  type ResourceEmbedCardProps,
  type SurfaceEmbedActivationRecord,
} from './ResourceEmbedCard.jsx';

/*
 * INTEGRATION-: mounting `ResourcePicker` inside an
 * app-layer dialog overlay (portal root, focus trap, Escape/backdrop close,
 * initial-focus + return-focus, `aria-modal` labelling) is owned by the app
 * host integration phase, not by this barrel. Hosts consume the dialog,
 * model, link codec, presentation helper, and activation card through
 * `@froglight/ui/react` (no deep imports); the picker itself stays
 * overlay-agnostic and closes only via `onPick`/`onClose`. No overlay code
 * belongs here.
 */
