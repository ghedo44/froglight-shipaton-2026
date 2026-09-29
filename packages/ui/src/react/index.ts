/**
 * Trusted-UI React surface — the single home of the React component
 * contract.
 *
 * First-party views and trusted UI plugins register components from here.
 * The runtime kernel, foundation capability contracts, generic core SDK,
 * and generic plugin-platform container stay framework-free: no React
 * types enter those layers, and the platform container keeps its
 * framework-agnostic `unknown` presentation boundary.
 *
 * The cascade-layer order is declared first through the side-effect import
 * below (the single source is styles/layers.css); every component
 * stylesheet layers itself under it.
 */
import '../styles/layers.css';

export { ViewSlot } from './ViewSlot.jsx';
export { DocumentName } from './DocumentName.jsx';
export type { DocumentNameProps } from './DocumentName.jsx';
export { Button, IconButton } from './Button.jsx';
export { Slider } from './Slider.jsx';
export { Dialog } from './primitives/Dialog.jsx';
export { TextField, SearchField, TextArea, Select, Checkbox, FormField } from './primitives/Fields.jsx';
export type { SliderProps } from './Slider.jsx';
export type {
  ButtonAnchorProps,
  ButtonElementProps,
  ButtonProps,
  ButtonVariant,
  IconButtonProps,
} from './Button.jsx';
export { FileExplorerView } from './FileExplorerView.jsx';
export { SearchView } from './SearchView.jsx';
export { GraphView } from './GraphView.jsx';
export { CommunityPluginsView } from './CommunityPluginsView.jsx';
export { VaultManagerView } from './VaultManagerView.jsx';
export { MarkdownReaderView } from './MarkdownReaderView.jsx';
export { createMarkdownCompositionPresenter } from './MarkdownComposition.jsx';
export {
  OutlinePanel,
  DocumentSettingsPanel,
  DocumentInspectorPanel,
} from './RightSidebarPanels.jsx';
export {
  AppearanceSettingsView,
  EditorSettingsView,
  CommunityPluginsSettingsView,
  AboutSettingsView,
} from './SettingsView.jsx';
export { ProPaywall, purchaseErrorCopy } from './ProPaywall.jsx';
export { PurchasePackageCard, perMonthHint } from './PurchasePackageCard.jsx';
export { PurchaseStatus } from './PurchaseStatus.jsx';
export { Accents } from './Accents.jsx';
export { ProSettingsView } from './ProSettingsView.jsx';
export { usePurchaseSnapshot, useFroglightPro } from './usePurchases.jsx';
export { useServerPro } from './useServerPro.jsx';
export { useAccountSnapshot } from './useAccount.jsx';
export { useVaultSyncSnapshot } from './useVaultSync.jsx';
export {
  AccountSettingsView,
  accountErrorCopy,
} from './AccountSettingsView.jsx';
export {
  VaultSyncSettingsView,
  vaultSyncErrorCopy,
} from './VaultSyncSettingsView.jsx';
export { VaultBackupSettingsView } from './VaultBackupSettingsView.jsx';
export { CloudVaultsView } from './CloudVaultsView.jsx';
export { mountIsolatedReactRoot } from './isolated-react-root.js';
export { useAboveKeyboard } from './useAboveKeyboard.js';
export { useKeyboardInset } from './useKeyboardInset.js';
export type { ViewDef, ViewRegistry } from '../view-registry.js';
export {
  DatabaseView,
  createDatabaseEditorProvider,
  createDatabaseEditorPlugin,
} from './DatabaseView.js';
export { DatabaseContent } from './DatabaseContent.js';
export { createDatabaseCompositionPresenter } from './DatabaseComposition.js';
export {
  activeSuggestion,
  clampActiveIndex,
  copyResourceLink,
  createRecentResourceStore,
  filterSuggestions,
  formatResourceLink,
  isNoMatch,
  moveActiveIndex,
  noMatchCopy,
  parseResourceLink,
  resolveSurfaceEmbedPresentation,
  ResourceEmbedCard,
  ResourcePicker,
  RESOURCE_PICKER_RECENT_LIMIT,
  surfaceEmbedPresentationModeOf,
  type RecentResourceEntry,
  type ResolvedSurfaceEmbedPresentation,
  type ResourceEmbedCardProps,
  type ResourcePickerProps,
  type SurfaceEmbedActivationRecord,
  type SurfaceEmbedPresentationMode,
} from './picker/index.js';
