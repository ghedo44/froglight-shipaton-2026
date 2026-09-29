/**
 * Semantic control renderer shared by the unified document toolbar.
 *
 * Controls arrive as plain data from editor snapshots and toolbar
 * contributions; this module is the only place that turns them into DOM.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DocumentToolControl, InkSlotFamily } from '@froglight/foundation';
import {
  SURFACE_HIGHLIGHTER_GLYPH_OPACITY,
  SURFACE_SHARED_SWATCHES,
} from '@froglight/foundation';
import {
  slotIdForItem,
  stripGroupIdForCategory,
} from '../toolbar/composition-registry.js';
import { Icon } from './Icon.jsx';
import { Slider } from './Slider.jsx';
import { toolbarControlIcon } from './toolbar-control-icon.js';
import {
  focusFirstFocusable,
  ToolbarPopoverPortal,
  useFocusFirstOnOpen,
  useToolbarPopoverPosition,
} from './toolbar-popover.jsx';
import styles from './UnifiedToolbar.module.css';

export type ControlExecute = (id: string, value?: string) => void;

/**
 * Unplaced active-tool settings for one surface-tool button. The
 * provider snapshot carries them (group `settings`); placements leave
 * them unclaimed and the toolbar reunites them with the active tool
 * button here. Empty when the active tool has no settings schema.
 * `execute` routes by settings control id through the resolved provider
 * owner (settings controls are never placed, so the button's own
 * placement owner cannot serve them).
 */
export interface SurfaceToolSettingsSource {
  readonly controls: readonly DocumentToolControl[];
  readonly execute: ControlExecute;
}

const NO_SETTINGS: SurfaceToolSettingsSource = {
  controls: [],
  execute: () => undefined,
};

/**
 * Pane-scoped disclosure coordination.
 *
 * Global exclusive-open + resetKey-clear-all across every toolbar
 * disclosure (pen-slot editors, non-pen `SurfaceToolButton`/`ShelfSlotCell`
 * popovers, category/shelf/island More menus). The pane provider
 * (`ToolbarDisclosureProvider`, mounted once per pane in
 * `UnifiedToolbarProvider`) holds the single claimed disclosure id; each
 * disclosure claims it on open and closes on a foreign claim, so at most
 * one dialog/menu is ever open per pane. Every disclosure additionally
 * closes on its own `resetKey` (pane:document) change, so tab/document
 * switches never inherit a stale open disclosure — with or without the
 * provider (standalone mounts keep independent disclosures plus the
 * resetKey clear).
 *
 * Keys are per-instance `useId` values (never labels, icons, or id
 * substrings; never scope `slotKey` vs owner `control.id` confusion):
 * identity only, no semantics. Lifecycle-clean by construction (React
 * state + effect cleanups only, mirroring the existing controls). Portaled
 * More menus, Esc/outside dismissal, and focus return are untouched —
 * this only adds claim/close effects.
 */
interface ToolbarDisclosureScopeValue {
  readonly claimedKey: string | null;
  readonly claimedSurface: ToolbarDisclosureSurface | null;
  readonly claim: (
    key: string | null,
    surface?: ToolbarDisclosureSurface,
  ) => void;
  /** Release only this owner; a stale close must not clear a newer claim. */
  readonly release: (key: string) => void;
}

/** A disclosure surface with cross-surface presentation consequences. */
type ToolbarDisclosureSurface = 'topbar-category-menu';

const ToolbarDisclosureContext =
  createContext<ToolbarDisclosureScopeValue | null>(null);

export function ToolbarDisclosureProvider(props: {
  readonly resetKey?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const { resetKey, children } = props;
  const [claimed, setClaimed] = useState<{
    readonly key: string;
    readonly surface: ToolbarDisclosureSurface | null;
  } | null>(null);
  useEffect(() => {
    setClaimed(null);
  }, [resetKey]);
  const claim = useCallback(
    (key: string | null, surface?: ToolbarDisclosureSurface): void => {
      setClaimed(key === null ? null : { key, surface: surface ?? null });
    },
    [],
  );
  const release = useCallback((key: string): void => {
    setClaimed((current) => (current?.key === key ? null : current));
  }, []);
  const value = useMemo(
    () => ({
      claimedKey: claimed?.key ?? null,
      claimedSurface: claimed?.surface ?? null,
      claim,
      release,
    }),
    [claimed, claim, release],
  );
  return (
    <ToolbarDisclosureContext.Provider value={value}>
      {children}
    </ToolbarDisclosureContext.Provider>
  );
}

/**
 * One disclosure's share of the pane coordination. Call unconditionally
 * before any early return (hook count stability). `setOpen` must be the
 * stable `useState` setter.
 */
export function useToolbarDisclosure(input: {
  readonly resetKey?: string;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly surface?: ToolbarDisclosureSurface;
}): {
  readonly disclosureId: string;
  readonly claimOpen: () => void;
  readonly release: () => void;
  /** The pane's top-bar category menu is open. */
  readonly hasTopbarCategoryClaim: boolean;
} {
  const { resetKey, open, setOpen, surface } = input;
  const scope = useContext(ToolbarDisclosureContext);
  const disclosureId = useId();
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  // resetKey-clear-all: every disclosure closes on
  // pane:document change, provider or standalone. No-op when already
  // closed (React bails out on identical state).
  useEffect(() => {
    setOpen(false);
    scopeRef.current?.release(disclosureId);
  }, [resetKey, setOpen, disclosureId]);
  useEffect(
    () => () => {
      scopeRef.current?.release(disclosureId);
    },
    [disclosureId],
  );
  const claimedKey = scope?.claimedKey ?? null;
  // Global exclusive-open: a foreign claim closes this one.
  // Null means "nothing claimed" — never closes.
  useEffect(() => {
    if (scope === null) return;
    if (claimedKey !== null && claimedKey !== disclosureId && open)
      setOpen(false);
  }, [scope, claimedKey, disclosureId, open, setOpen]);
  const claimOpen = useCallback((): void => {
    scope?.claim(disclosureId, surface);
  }, [scope, disclosureId, surface]);
  const release = useCallback((): void => {
    scope?.release(disclosureId);
  }, [scope, disclosureId]);
  const hasTopbarCategoryClaim =
    scope?.claimedSurface === 'topbar-category-menu';
  return useMemo(
    () => ({ disclosureId, claimOpen, release, hasTopbarCategoryClaim }),
    [disclosureId, claimOpen, release, hasTopbarCategoryClaim],
  );
}

export interface SurfaceToolExtras {
  /**
   * Slot-scoped editor sections (shelf slots). When present,
   * the second-tap popover renders only these `SurfaceSettingsPopoverBody`
   * sections for the owning slot (size slots pass `['size']`, color slots
   * `['color']`); absent means the current tool's own properties.
   */
  readonly editorSections?: readonly ShelfSlotEditorSection[];
}

export function groupControls(
  controls: readonly DocumentToolControl[],
): [string, DocumentToolControl[]][] {
  const groups = new Map<string, DocumentToolControl[]>();
  for (const control of controls) {
    const entries = groups.get(control.group) ?? [];
    entries.push(control);
    groups.set(control.group, entries);
  }
  return [...groups.entries()];
}

export function renderControl(
  control: DocumentToolControl,
  execute: ControlExecute,
  resetKey?: string,
  settings?: SurfaceToolSettingsSource,
  surface?: SurfaceToolExtras,
): React.ReactElement {
  if (control.kind === 'status') {
    return (
      <span className={styles['fl-document-tool-status']} key={control.id}>
        {control.label}
      </span>
    );
  }
  if (control.kind === 'diagnostics') {
    return (
      <DiagnosticsToolControl
        key={resetKey === undefined ? control.id : `${resetKey}:${control.id}`}
        control={control}
        execute={execute}
      />
    );
  }
  if (control.kind === 'choice') {
    const icon = toolbarControlIcon(control);
    if (icon !== undefined) {
      return (
        <label
          className={`${styles['fl-document-tool']} ${styles['fl-document-tool-choice-icon']}`}
          key={control.id}
          title={control.label}
        >
          <Icon name={icon} size={16} />
          <select
            aria-label={control.label}
            value={control.value}
            disabled={control.disabled}
            onChange={(event) => execute(control.id, event.currentTarget.value)}
          >
            {control.options.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    return (
      <label className={styles['fl-document-tool-choice']} key={control.id}>
        <span className="visually-hidden">{control.label}</span>
        <select
          aria-label={control.label}
          title={control.label}
          value={control.value}
          disabled={control.disabled}
          onChange={(event) => execute(control.id, event.currentTarget.value)}
        >
          {control.options.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (control.kind === 'color') {
    return (
      <div
        className={styles['fl-document-colors']}
        aria-label={control.label}
        key={control.id}
      >
        {control.options.map((color) => (
          <button
            type="button"
            className={styles['fl-document-color']}
            aria-label={`${control.label}: ${color}`}
            aria-pressed={control.value.toLowerCase() === color.toLowerCase()}
            title={color}
            disabled={control.disabled}
            style={{ backgroundColor: color }}
            onClick={() => execute(control.id, color)}
            key={color}
          />
        ))}
      </div>
    );
  }
  if (control.kind === 'input') {
    return (
      <InputToolControl
        key={resetKey === undefined ? control.id : `${resetKey}:${control.id}`}
        control={control}
        execute={execute}
      />
    );
  }
  if (control.kind === 'number') {
    return (
      <NumberToolControl key={control.id} control={control} execute={execute} />
    );
  }
  if (control.kind === 'table') {
    return (
      <TableToolControl
        key={resetKey === undefined ? control.id : `${resetKey}:${control.id}`}
        control={control}
        execute={execute}
        resetKey={resetKey}
      />
    );
  }
  if (control.kind === 'range') {
    return (
      <RangeToolControl key={control.id} control={control} execute={execute} />
    );
  }
  if (control.kind === 'button' && control.role === 'surface-tool') {
    return (
      <SurfaceToolButton
        key={control.id}
        control={control}
        execute={execute}
        settings={settings ?? NO_SETTINGS}
        resetKey={resetKey}
        surface={surface}
      />
    );
  }
  const buttonIcon = toolbarControlIcon(control);
  return (
    <button
      type="button"
      className={styles['fl-document-tool']}
      aria-label={control.label}
      aria-pressed={control.mixed === true ? 'mixed' : control.active}
      title={control.label}
      disabled={control.disabled}
      onClick={() => execute(control.id)}
      key={control.id}
    >
      {buttonIcon !== undefined ? (
        <span className={styles['fl-document-tool-iconwrap']}>
          <Icon name={buttonIcon} size={16} />
          {control.swatch !== undefined ? (
            <span
              aria-hidden="true"
              className={styles['fl-document-tool-badge']}
              style={{ backgroundColor: control.swatch }}
            />
          ) : null}
        </span>
      ) : control.swatch !== undefined ? (
        <span
          aria-hidden="true"
          className={styles['fl-document-tool-swatch']}
          style={{ backgroundColor: control.swatch }}
        />
      ) : (
        <span aria-hidden="true">{control.shortLabel ?? control.label}</span>
      )}
    </button>
  );
}

/**
 * Saved-style controls live in the contextual shelf, outside the active
 * tool's settings dialog.
 */
const SAVED_STYLE_FIELDS = new Set([
  'saved-style',
  'save-style',
  'rename-style',
  'favorite-style',
  'move-style-earlier',
  'move-style-later',
  'update-style',
  'delete-style',
  'reset-style',
]);

function hasStructuredSavedStyles(
  controls: readonly DocumentToolControl[],
): boolean {
  return controls.some(
    (entry) =>
      entry.kind === 'choice' &&
      entry.semanticRole === 'surface.style.saved' &&
      entry.savedStyles !== undefined,
  );
}

function isSavedStyleFieldControl(
  control: DocumentToolControl,
  prefix: string,
  tool: string,
): boolean {
  const head = `${prefix}.settings.${tool}.`;
  if (!control.id.startsWith(head)) return false;
  return SAVED_STYLE_FIELDS.has(control.id.slice(head.length));
}

function inferSavedStyleScope(
  controls: readonly DocumentToolControl[],
): { prefix: string; tool: string } | null {
  for (const entry of controls) {
    if (
      entry.kind === 'choice' &&
      entry.semanticRole === 'surface.style.saved' &&
      entry.savedStyles !== undefined
    ) {
      const rest = entry.id.slice(0, entry.id.lastIndexOf('.saved-style'));
      const sep = rest.lastIndexOf('.settings.');
      if (sep < 0) return null;
      const prefix = rest.slice(0, sep);
      const tool = rest.slice(sep + '.settings.'.length);
      if (prefix !== '' && tool !== '') return { prefix, tool };
    }
  }
  return null;
}

/**
 * Settings for the active tool. Pen dialogs expose brush behavior;
 * highlighter dialogs expose opacity. Size and color have their own slot
 * editors. Other tools retain their provider controls.
 */
function SurfaceSettingsPopoverBody(props: {
  control: { readonly label: string };
  settings: SurfaceToolSettingsSource;
  /**
   * Slot-scoped section filter (shelf slots). `undefined`
   * renders the active tool's properties; a list limits an editor to its
   * owning slot. Brush fields follow the provider's supported vocabulary.
   */
  sections?: readonly ShelfSlotEditorSection[];
}): React.ReactElement {
  const { control, settings, sections } = props;
  const showSection = (section: ShelfSlotEditorSection): boolean =>
    sections === undefined || sections.includes(section);
  if (!hasStructuredSettings(settings.controls)) {
    return (
      <>
        {settings.controls.map((entry) => (
          <div
            className={styles['fl-tool-settings-group']}
            data-group={entry.group}
            key={entry.id}
          >
            <span
              className={styles['fl-tool-settings-label']}
              aria-hidden="true"
            >
              {entry.label}
            </span>
            {renderControl(entry, settings.execute)}
          </div>
        ))}
      </>
    );
  }
  const scope = inferSavedStyleScope(settings.controls);
  const restControls =
    scope === null
      ? settings.controls
      : settings.controls.filter(
          (entry) => !isSavedStyleFieldControl(entry, scope.prefix, scope.tool),
        );
  const byRole = new Map<string, DocumentToolControl>();
  for (const entry of restControls) {
    if (entry.semanticRole !== undefined && !byRole.has(entry.semanticRole))
      byRole.set(entry.semanticRole, entry);
  }
  const typeControl = roleChoiceControl(byRole, 'surface.settings.pen-type');
  const colorControl = roleColorControl(byRole, 'surface.settings.color');
  const sizeControl = roleChoiceControl(byRole, 'surface.settings.size');
  const isPen = typeControl !== null;
  const isHighlighter = restControls.some((entry) =>
    entry.id.endsWith('.highlighter.opacity'),
  );
  const propertyControls = restControls.filter((entry) => {
    if (isPen) return isAdvancedSettingsField(entry);
    if (isHighlighter) return entry.id.endsWith('.highlighter.opacity');
    return (
      entry !== typeControl && entry !== colorControl && entry !== sizeControl
    );
  });
  return (
    <>
      <p className={styles['fl-tool-settings-title']} aria-hidden="true">
        {control.label}
      </p>
      {showSection('color') &&
      (sections !== undefined || (!isPen && !isHighlighter)) &&
      colorControl !== null ? (
        <ColorSection control={colorControl} execute={settings.execute} />
      ) : null}
      {showSection('size') &&
      (sections !== undefined || (!isPen && !isHighlighter)) &&
      sizeControl !== null ? (
        <SizeSection control={sizeControl} execute={settings.execute} />
      ) : null}
      {showSection('core') || (isPen && showSection('advanced'))
        ? propertyControls.map((entry) => (
            <div
              className={styles['fl-tool-settings-group']}
              data-group={entry.group}
              key={entry.id}
            >
              <span
                className={styles['fl-tool-settings-label']}
                aria-hidden="true"
              >
                {entry.label}
              </span>
              {entry.kind === 'choice' && entry.options.length <= 4 ? (
                <SegmentedChoice control={entry} execute={settings.execute} />
              ) : (
                renderControl(entry, settings.execute)
              )}
            </div>
          ))
        : null}
    </>
  );
}

/** Explicit-role lookup with kind narrowing (no id-shape inference). */
function roleChoiceControl(
  byRole: ReadonlyMap<string, DocumentToolControl>,
  role: string,
): Extract<DocumentToolControl, { kind: 'choice' }> | null {
  const found = byRole.get(role);
  return found !== undefined && found.kind === 'choice' ? found : null;
}

function roleColorControl(
  byRole: ReadonlyMap<string, DocumentToolControl>,
  role: string,
): Extract<DocumentToolControl, { kind: 'color' }> | null {
  const found = byRole.get(role);
  return found !== undefined && found.kind === 'color' ? found : null;
}

/**
 * Structured-schema detection: the popover uses the Goodnotes hierarchy
 * when the provider emits explicit `surface.settings.*` roles or the
 * structured saved-styles payload. Role-less legacy snapshots keep the
 * generic form.
 */
function hasStructuredSettings(
  controls: readonly DocumentToolControl[],
): boolean {
  if (hasStructuredSavedStyles(controls)) return true;
  // Any explicit surface settings/style role opts into the hierarchy
  // (pen type/color/size, eraser mode/size/filter/auto-return, lasso
  // mode/filter). Role-less legacy snapshots keep the generic form.
  return controls.some(
    (entry) =>
      entry.semanticRole !== undefined &&
      (entry.semanticRole.startsWith('surface.settings.') ||
        entry.semanticRole.startsWith('surface.style.')),
  );
}

/**
 * Advanced-disclosure membership by control-id field suffix. Matches the
 * `BRUSH_ADVANCED_SUPPORT` emission vocabulary in
 * `surface-tool-settings.ts` (pressure/stabilization/tilt/tip/taper/cap/
 * gestures); core rows (color/size/type/opacity/straight/eraser/lasso/
 * arrows/saved-styles) never enter the disclosure.
 */
const ADVANCED_SETTINGS_FIELDS = new Set([
  'pressure',
  'pressure-min',
  'pressure-max',
  'stabilization',
  'streamline',
  'velocity-pressure',
  'tilt-effect',
  'tip-flatness',
  'tip-angle',
  'taper-start',
  'taper-end',
  'tip',
  'cap',
  'gesture-draw-hold',
  'gesture-scribble',
  'gesture-circle',
]);

function isAdvancedSettingsField(control: DocumentToolControl): boolean {
  return ADVANCED_SETTINGS_FIELDS.has(
    control.id.slice(control.id.lastIndexOf('.') + 1),
  );
}

/**
 * Segmented choice shared by short option lists in the settings popover
 * (pen family, eraser/lasso mode, arrowheads, tip, cap): one 44pt-capable
 * button per option with `aria-pressed`, no hover-dependent select.
 */
function SegmentedChoice(props: {
  control: Extract<DocumentToolControl, { kind: 'choice' }>;
  execute: ControlExecute;
}): React.ReactElement {
  const { control, execute } = props;
  return (
    <div
      className={styles['fl-segmented-row']}
      role="group"
      aria-label={control.label}
    >
      {control.options.map((option) => (
        <button
          type="button"
          className={styles['fl-document-tool']}
          aria-label={`${control.label}: ${option.label}`}
          aria-pressed={control.value === option.value}
          title={option.label}
          disabled={control.disabled}
          key={option.value}
          onClick={() => execute(control.id, option.value)}
        >
          <span aria-hidden="true">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Color section: quick swatches with an explicit More disclosure. */
function ColorSection(props: {
  control: Extract<DocumentToolControl, { kind: 'color' }>;
  execute: ControlExecute;
}): React.ReactElement {
  const { control, execute } = props;
  const [showAll, setShowAll] = useState(false);
  const QUICK_COLORS = 5;
  const visible = showAll
    ? control.options
    : control.options.slice(0, QUICK_COLORS);
  const hidden = control.options.length - visible.length;
  return (
    <section className={styles['fl-tool-settings-section']} aria-label="Color">
      <span className={styles['fl-tool-settings-label']} aria-hidden="true">
        Color
      </span>
      <div className={styles['fl-document-colors']}>
        {visible.map((color) => (
          <button
            type="button"
            className={styles['fl-document-color']}
            aria-label={`Color: ${color}`}
            aria-pressed={control.value.toLowerCase() === color.toLowerCase()}
            title={color}
            disabled={control.disabled}
            style={{ backgroundColor: color }}
            onClick={() => execute(control.id, color)}
            key={color}
          />
        ))}
      </div>
      {hidden > 0 && !showAll ? (
        <button
          type="button"
          className={`${styles['fl-document-tool']} ${styles['fl-color-more']}`}
          aria-expanded={showAll}
          onClick={() => setShowAll(true)}
        >
          More ({hidden} more)
        </button>
      ) : null}
      {showAll ? (
        <button
          type="button"
          className={`${styles['fl-document-tool']} ${styles['fl-color-more']}`}
          aria-expanded={showAll}
          onClick={() => setShowAll(false)}
        >
          Fewer
        </button>
      ) : null}
    </section>
  );
}

/** Size section: segmented widths with a live pt readout. */
function SizeSection(props: {
  control: Extract<DocumentToolControl, { kind: 'choice' }>;
  execute: ControlExecute;
}): React.ReactElement {
  const { control, execute } = props;
  return (
    <section className={styles['fl-tool-settings-section']} aria-label="Size">
      <span className={styles['fl-tool-settings-label']} aria-hidden="true">
        Size{' '}
        <span className={styles['fl-size-readout']}>{control.value} pt</span>
      </span>
      <SegmentedChoice control={control} execute={execute} />
    </section>
  );
}

/**
 * Shared outside-dismissal for second-tap slot disclosures.
 * `SurfaceToolButton` and `ShelfSlotCell` share it so the
 * trigger/popover containment rule cannot diverge between the button and
 * generalized cell paths. (`usePopoverLifecycle` keeps its own
 * editor-focus-preserving variant for submitted inputs/diagnostics.)
 */
function useDismissOpenOnOutside(input: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly popoverRef: React.RefObject<HTMLDivElement | null>;
}): void {
  const { open, onClose, triggerRef, popoverRef } = input;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        (triggerRef.current?.contains(target) ?? false) ||
        (popoverRef.current?.contains(target) ?? false)
      )
        return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onClose, triggerRef, popoverRef]);
}
/**
 * Surface draw-tool button with second-tap settings (slice 8).
 *
 * The first tap activates the tool through the normal command channel;
 * tapping the already-active tool toggles its settings popover instead
 * of re-executing. The popover renders the unplaced `settings`-group
 * controls from the provider snapshot through the Goodnotes-inspired
 * hierarchy (`SurfaceSettingsPopoverBody`), so every property keeps the
 * existing command channel and live snapshot values. Deactivation (any
 * tool switch, including a pen-family change inside the popover) closes
 * a stale popover; at most one tool is active, so at most one settings
 * popover is ever open.
 *
 */
/**
 * Shelf-level exclusive-open coordination. The owning
 * `ShelfSlotShelf` holds the single claimed slot key; a cell claims it
 * when its editor opens and closes whenever another slot holds the claim,
 * so at most one slot editor is ever open. Omitted on legacy paths, where
 * each button keeps its independent disclosure.
 */
export interface SlotOpenCoordination {
  readonly slotKey: string;
  readonly claimedOpenKey: string | null;
  readonly onClaimOpen: (slotKey: string | null) => void;
}

function SurfaceToolButton(props: {
  control: Extract<DocumentToolControl, { kind: 'button' }>;
  execute: ControlExecute;
  settings: SurfaceToolSettingsSource;
  resetKey?: string;
  surface?: SurfaceToolExtras;
  openCoordination?: SlotOpenCoordination;
}): React.ReactElement {
  const { control, execute, settings, resetKey, surface, openCoordination } =
    props;
  const [open, setOpen] = useState(false);
  // Pane-global exclusive-open + resetKey-clear-all: claims the
  // pane scope on open, closes on foreign claims and on pane:document
  // change. Runs alongside the shelf-local `openCoordination` below (kept
  // for standalone mounts without the pane provider).
  const disclosure = useToolbarDisclosure({ resetKey, open, setOpen });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const position = useToolbarPopoverPosition({
    triggerRef,
    popoverRef,
    enabled: open,
  });
  // Second-tap disclosure is a dialog: land keyboard focus inside it on
  // open (portaled content sits after the trigger in tab order). Pointer
  // users are unaffected (`:focus-visible` stays off for pointer focus).
  useFocusFirstOnOpen(open, popoverRef);
  useEffect(() => {
    if (control.active !== true) setOpen(false);
  }, [control.active]);
  const closePopover = useCallback((): void => setOpen(false), []);
  useDismissOpenOnOutside({
    open,
    onClose: closePopover,
    triggerRef,
    popoverRef,
  });
  // Shelf exclusive-open: another slot's claim closes this one.
  useEffect(() => {
    if (!open || openCoordination === undefined) return;
    if (
      openCoordination.claimedOpenKey !== null &&
      openCoordination.claimedOpenKey !== openCoordination.slotKey
    )
      setOpen(false);
  }, [openCoordination, open]);
  const hasSettings = settings.controls.length > 0;
  const dialogued = hasSettings && control.active === true;
  const icon = toolbarControlIcon(control);
  return (
    <div className={styles['fl-document-tool-popover-wrap']}>
      <button
        type="button"
        className={styles['fl-document-tool']}
        aria-label={control.label}
        aria-pressed={control.mixed === true ? 'mixed' : control.active}
        aria-haspopup={dialogued ? 'dialog' : undefined}
        aria-expanded={dialogued ? open : undefined}
        title={control.label}
        disabled={control.disabled}
        ref={triggerRef}
        onClick={() => {
          if (control.active === true && hasSettings) {
            const next = !open;
            if (next) {
              openCoordination?.onClaimOpen(openCoordination.slotKey);
              disclosure.claimOpen();
            } else {
              openCoordination?.onClaimOpen(null);
              disclosure.release();
            }
            setOpen(next);
          } else {
            disclosure.release();
            setOpen(false);
            execute(control.id);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }
        }}
      >
        {icon !== undefined ? (
          <span className={styles['fl-document-tool-iconwrap']}>
            <Icon name={icon} size={16} />
            {control.swatch !== undefined ? (
              <span
                aria-hidden="true"
                className={styles['fl-document-tool-badge']}
                style={{ backgroundColor: control.swatch }}
              />
            ) : null}
          </span>
        ) : control.swatch !== undefined ? (
          <span
            aria-hidden="true"
            className={styles['fl-document-tool-swatch']}
            style={{ backgroundColor: control.swatch }}
          />
        ) : (
          <span aria-hidden="true">{control.shortLabel ?? control.label}</span>
        )}
      </button>
      {open && hasSettings ? (
        <ToolbarPopoverPortal>
          <div
            className={`${styles['fl-document-tool-popover']} ${styles['fl-tool-settings-popover']}`}
            role="dialog"
            aria-label={`${control.label} settings`}
            ref={popoverRef}
            data-popover-placement={position?.placement ?? 'below'}
            key={resetKey}
            style={
              position !== null
                ? {
                    position: 'fixed',
                    left: position.left,
                    top: position.top,
                    maxWidth: position.maxWidth,
                    maxHeight: Math.min(position.maxHeight, 420),
                    overflow: 'auto',
                    transform: 'none',
                  }
                : { position: 'fixed' }
            }
            onKeyDown={(event) => {
              // Popover-level Escape: cards/inputs inside the
              // dialog close it and return focus to the trigger. Trigger-
              // level Escape above covers focus already on the trigger.
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus();
              }
            }}
          >
            <SurfaceSettingsPopoverBody
              control={control}
              settings={settings}
              sections={surface?.editorSections}
            />
          </div>
        </ToolbarPopoverPortal>
      ) : null}
    </div>
  );
}

/**
 * Shared focus-preserving popover lifecycle for toolbar triggers that open
 * a floating dialog without destroying the editor selection (submitted
 * inputs like Markdown/LaTeX links and citations, diagnostics lists, and
 * any future popover control).
 *
 * The provider remains the sole interpreter of selection/source syntax;
 * React owns generic popover lifecycle only and never inspects editor
 * selections, syntax nodes, or DOM.
 *
 * - Opening preserves the provider selection (CodeMirror/ProseMirror keep
 *   ranges while blurred; we never clear them and restore focus predictably).
 * - Commit closes the popover, returns focus toward the editor (captured
 *   return target), then runs the effect — so a provider focus() during
 *   execute wins over the trigger fallback.
 * - Cancel / Escape returns to the trigger; outside dismissal leaves the
 *   click target.
 * - Per-pane isolation comes from the parent keying by pane+document
 *   (`resetKey` in `renderControl`), so tab switches unmount open popovers.
 */
function usePopoverLifecycle(): {
  readonly open: boolean;
  readonly setOpen: (open: boolean | ((was: boolean) => boolean)) => void;
  readonly wrapRef: React.RefObject<HTMLDivElement | null>;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly popoverRef: React.RefObject<HTMLDivElement | null>;
  readonly captureReturnFocus: () => void;
  readonly onTriggerFocus: (event: { readonly relatedTarget: unknown }) => void;
  readonly commit: (run: () => void) => void;
  readonly cancel: () => void;
} {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Outside dismissal (cancel path without stealing the click target).
  // With pane-scoped portals the popover lives outside `wrapRef`, so both
  // the trigger wrap and the portaled popover keep the popover open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const captureReturnFocus = (): void => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== triggerRef.current &&
      wrapRef.current?.contains(active) !== true
    ) {
      returnFocusRef.current = active;
    }
  };

  const onTriggerFocus = (event: { readonly relatedTarget: unknown }): void => {
    const related = event.relatedTarget;
    if (
      related instanceof HTMLElement &&
      wrapRef.current?.contains(related) !== true
    ) {
      returnFocusRef.current = related;
    }
  };

  const commit = (run: () => void): void => {
    setOpen(false);
    // Restore editor-ward focus before the provider effect runs, so a
    // provider focus() during execute wins over the trigger fallback.
    const target = returnFocusRef.current;
    if (target !== null && target.isConnected) target.focus();
    else triggerRef.current?.focus();
    run();
  };

  const cancel = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return {
    open,
    setOpen,
    wrapRef,
    triggerRef,
    popoverRef,
    captureReturnFocus,
    onTriggerFocus,
    commit,
    cancel,
  };
}

/**
 * Focus-preserving submitted-input popover shared by all `input` semantic
 * controls (Markdown link, Block Page link, LaTeX label/reference/citation).
 *
 * The provider owns whether selected text is wrapped, an existing target is
 * edited, or insertion is rejected; see `usePopoverLifecycle` for the
 * shared open/focus/dismissal contract.
 *
 * - Compact trigger (icon or action label) instead of a permanent field.
 */
function InputToolControl(props: {
  control: Extract<DocumentToolControl, { kind: 'input' }>;
  execute: ControlExecute;
}): React.ReactElement {
  const { control, execute } = props;
  const icon = toolbarControlIcon(control);
  const {
    open,
    setOpen,
    wrapRef,
    triggerRef,
    popoverRef,
    captureReturnFocus,
    onTriggerFocus,
    commit,
    cancel,
  } = usePopoverLifecycle();
  const [draft, setDraft] = useState(control.value ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const position = useToolbarPopoverPosition({
    triggerRef,
    popoverRef,
    enabled: open,
  });

  // Prefill from the provider when the popover opens (existing link target).
  useEffect(() => {
    if (open) setDraft(control.value ?? '');
  }, [open, control.value]);

  // Autofocus the popover input on open.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = (): void => {
    const value = draft;
    commit(() => execute(control.id, value));
  };

  return (
    <div className={styles['fl-document-tool-popover-wrap']} ref={wrapRef}>
      <button
        type="button"
        className={styles['fl-document-tool']}
        aria-label={control.label}
        title={control.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={control.active}
        disabled={control.disabled}
        ref={triggerRef}
        onPointerDown={captureReturnFocus}
        onFocus={onTriggerFocus}
        onClick={() => {
          if (control.disabled === true) return;
          captureReturnFocus();
          setOpen((was) => !was);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            cancel();
          }
        }}
      >
        {icon !== undefined ? (
          <Icon name={icon} size={16} />
        ) : (
          <span aria-hidden="true">{control.actionLabel}</span>
        )}
      </button>
      {open ? (
        <ToolbarPopoverPortal>
          <div
            className={styles['fl-document-tool-popover']}
            role="dialog"
            aria-label={control.label}
            ref={popoverRef}
            data-popover-placement={position?.placement ?? 'below'}
            style={
              position !== null
                ? {
                    position: 'fixed',
                    left: position.left,
                    top: position.top,
                    maxWidth: position.maxWidth,
                    maxHeight: position.maxHeight,
                    overflow: 'auto',
                    transform: 'none',
                  }
                : { position: 'fixed' }
            }
          >
            <form
              className={styles['fl-document-tool-input']}
              aria-label={control.label}
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <input
                name="value"
                ref={inputRef}
                type="text"
                aria-label={control.label}
                placeholder={control.placeholder}
                value={draft}
                disabled={control.disabled}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancel();
                  }
                }}
              />
              <button
                type="submit"
                className={styles['fl-document-tool']}
                disabled={control.disabled}
              >
                {control.actionLabel}
              </button>
              <button
                type="button"
                className={styles['fl-document-tool']}
                aria-label="Cancel"
                onClick={cancel}
              >
                Cancel
              </button>
            </form>
          </div>
        </ToolbarPopoverPortal>
      ) : null}
    </div>
  );
}

/**
 * Frame-throttled provider adapter for `range` semantic controls (pen
 * width, eraser radius, zoom sliders). A drag fires `onChange` per pixel;
 * executing the provider command synchronously per event re-rendered the
 * editor once per pixel and was a measurable source of toolbar lag.
 * The thumb tracks the pointer immediately through local state while the
 * provider effect runs at most once per frame with the latest value;
 * release/blur flushes synchronously so keyboard and pointer commits are
 * never stranded in a cancelled frame.
 */
function RangeToolControl(props: {
  control: Extract<DocumentToolControl, { kind: 'range' }>;
  execute: ControlExecute;
}): React.ReactElement {
  const { control, execute } = props;
  const [draft, setDraft] = useState(control.value);
  useEffect(() => setDraft(control.value), [control.value]);
  const pendingRef = useRef<number | null>(null);
  const frameRef = useRef(0);
  const flush = (): void => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null) execute(control.id, String(pending));
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return (
    <Slider
      className={styles['fl-toolbar-slider']}
      aria-label={control.label}
      title={control.label}
      value={draft}
      min={control.min}
      max={control.max}
      step={control.step}
      disabled={control.disabled}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        setDraft(next);
        pendingRef.current = next;
        if (frameRef.current === 0) {
          frameRef.current = requestAnimationFrame(() => {
            frameRef.current = 0;
            const pending = pendingRef.current;
            pendingRef.current = null;
            if (pending !== null) execute(control.id, String(pending));
          });
        }
      }}
      onPointerUp={flush}
      onBlur={flush}
    />
  );
}

function NumberToolControl(props: {
  control: Extract<DocumentToolControl, { kind: 'number' }>;
  execute: ControlExecute;
}): React.ReactElement {
  const { control, execute } = props;
  const icon = toolbarControlIcon(control);
  const [draft, setDraft] = useState(String(control.value));
  useEffect(() => setDraft(String(control.value)), [control.value]);

  const commit = (): void => {
    const parsed = Number(draft);
    if (
      !Number.isFinite(parsed) ||
      (control.min !== undefined && parsed < control.min) ||
      (control.max !== undefined && parsed > control.max) ||
      (control.step === 1 && !Number.isInteger(parsed))
    ) {
      setDraft(String(control.value));
      return;
    }
    if (parsed !== control.value) execute(control.id, draft);
  };

  return (
    <label className={styles['fl-document-tool-number']} title={control.label}>
      {icon === undefined ? (
        <span>{control.label}</span>
      ) : (
        <Icon name={icon} size={16} />
      )}
      <input
        type="number"
        aria-label={control.label}
        value={draft}
        min={control.min}
        max={control.max}
        step={control.step}
        disabled={control.disabled}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setDraft(value);
          if (
            (control.semanticRole === 'surface.text.size' ||
              control.semanticRole === 'surface.selection.text-size' ||
              control.semanticRole === 'surface.shape.radius' ||
              control.semanticRole === 'surface.selection.radius') &&
            value !== '' &&
            event.currentTarget.validity.valid
          ) {
            execute(control.id, value);
          }
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
      />
      {control.suffix === undefined ? null : (
        <span aria-hidden="true">{control.suffix}</span>
      )}
    </label>
  );
}

function TableToolControl(props: {
  control: Extract<DocumentToolControl, { kind: 'table' }>;
  execute: ControlExecute;
  resetKey?: string;
}): React.ReactElement {
  const { control, execute, resetKey } = props;
  const {
    open,
    setOpen,
    wrapRef,
    triggerRef,
    popoverRef,
    captureReturnFocus,
    onTriggerFocus,
    commit,
    cancel,
  } = usePopoverLifecycle();
  const disclosure = useToolbarDisclosure({ resetKey, open, setOpen });
  useEffect(() => {
    if (!open) disclosure.release();
  }, [open, disclosure]);
  const [columns, setColumns] = useState(String(control.columns));
  const [rows, setRows] = useState(String(control.rows));
  const [header, setHeader] = useState(control.header);
  const position = useToolbarPopoverPosition({
    triggerRef,
    popoverRef,
    enabled: open,
  });
  useFocusFirstOnOpen(open, popoverRef);

  const validDimension = (value: string, max: number): boolean =>
    /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max;
  const valid =
    validDimension(columns, control.maxColumns) &&
    validDimension(rows, control.maxRows);

  return (
    <div className={styles['fl-document-tool-popover-wrap']} ref={wrapRef}>
      <button
        type="button"
        className={styles['fl-document-tool']}
        aria-label={control.label}
        title={control.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={control.disabled}
        ref={triggerRef}
        onPointerDown={captureReturnFocus}
        onFocus={onTriggerFocus}
        onClick={() => {
          captureReturnFocus();
          if (!open) disclosure.claimOpen();
          else disclosure.release();
          setOpen(!open);
        }}
      >
        <Icon name="table" size={16} />
      </button>
      {open ? (
        <ToolbarPopoverPortal>
          <div
            className={`${styles['fl-document-tool-popover']} ${styles['fl-table-tool-popover']}`}
            role="dialog"
            aria-label="Insert table"
            ref={popoverRef}
            data-popover-placement={position?.placement ?? 'below'}
            style={
              position !== null
                ? {
                    position: 'fixed',
                    left: position.left,
                    top: position.top,
                    maxWidth: position.maxWidth,
                    maxHeight: position.maxHeight,
                    overflow: 'auto',
                    transform: 'none',
                  }
                : { position: 'fixed' }
            }
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                disclosure.release();
                cancel();
              }
            }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid) return;
                disclosure.release();
                commit(() =>
                  execute(
                    control.id,
                    `${Number(columns)}:${Number(rows)}:${header ? 'named' : 'blank'}`,
                  ),
                );
              }}
            >
              <div className={styles['fl-table-tool-dimensions']}>
                <label className={styles['fl-document-tool-number']}>
                  <span>Columns</span>
                  <input
                    type="number"
                    aria-label="Columns"
                    min={1}
                    max={control.maxColumns}
                    step={1}
                    value={columns}
                    onChange={(event) => setColumns(event.currentTarget.value)}
                  />
                </label>
                <label className={styles['fl-document-tool-number']}>
                  <span>Rows</span>
                  <input
                    type="number"
                    aria-label="Rows"
                    min={1}
                    max={control.maxRows}
                    step={1}
                    value={rows}
                    onChange={(event) => setRows(event.currentTarget.value)}
                  />
                </label>
              </div>
              <label className={styles['fl-table-tool-header']}>
                <input
                  type="checkbox"
                  checked={header}
                  onChange={(event) => setHeader(event.currentTarget.checked)}
                />
                <span>Header labels</span>
              </label>
              <button
                type="submit"
                className={styles['fl-document-tool']}
                disabled={!valid || control.disabled}
              >
                Insert
              </button>
            </form>
          </div>
        </ToolbarPopoverPortal>
      ) : null}
    </div>
  );
}

/**
 * Compact diagnostics indicator shared by all `diagnostics` semantic
 * controls (LaTeX first; any future provider can reuse it).
 *
 * The provider owns availability/count/entry semantics and jump behavior;
 * see `usePopoverLifecycle` for the shared open/focus/dismissal contract.
 *
 * - One compact trigger shows the provider-composed summary label (plain
 *   text with counts/state, never color alone) and exposes it accessibly.
 * - Activating the trigger opens a generic list popover. Navigable entries
 *   execute the same control id with the entry id as the value; the
 *   provider performs source navigation. Non-navigable entries render as
 *   plain text. Empty entry lists render a single "No diagnostics" row.
 */
function DiagnosticsToolControl(props: {
  control: Extract<DocumentToolControl, { kind: 'diagnostics' }>;
  execute: ControlExecute;
}): React.ReactElement {
  const { control, execute } = props;
  const {
    open,
    setOpen,
    wrapRef,
    triggerRef,
    popoverRef,
    captureReturnFocus,
    onTriggerFocus,
    commit,
    cancel,
  } = usePopoverLifecycle();
  const position = useToolbarPopoverPosition({
    triggerRef,
    popoverRef,
    enabled: open,
  });
  // Diagnostics list is a dialog: land keyboard focus on the first entry
  // on open so keyboard users do not tab through the toolbar to reach it.
  useFocusFirstOnOpen(open, popoverRef);

  const jump = (entryId: string): void => {
    commit(() => execute(control.id, entryId));
  };

  return (
    <div className={styles['fl-document-tool-popover-wrap']} ref={wrapRef}>
      <button
        type="button"
        className={styles['fl-document-tool']}
        aria-label={control.label}
        title={control.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-diagnostics-state={control.state}
        ref={triggerRef}
        onPointerDown={captureReturnFocus}
        onFocus={onTriggerFocus}
        onClick={() => {
          captureReturnFocus();
          setOpen((was) => !was);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <Icon name="info" size={16} />
      </button>
      {open ? (
        <ToolbarPopoverPortal>
          <div
            className={styles['fl-document-tool-popover']}
            role="dialog"
            aria-label={control.label}
            ref={popoverRef}
            data-popover-placement={position?.placement ?? 'below'}
            style={
              position !== null
                ? {
                    position: 'fixed',
                    left: position.left,
                    top: position.top,
                    maxWidth: position.maxWidth,
                    maxHeight: position.maxHeight,
                    overflow: 'auto',
                    transform: 'none',
                  }
                : { position: 'fixed' }
            }
          >
            {control.entries.length === 0 ? (
              <p className={styles['fl-document-tool-status']}>
                No diagnostics
              </p>
            ) : (
              <ul className={styles['fl-document-tool-diagnostics']}>
                {control.entries.map((entry) => (
                  <li key={entry.id}>
                    {entry.navigable ? (
                      <button
                        type="button"
                        className={styles['fl-document-tool']}
                        aria-label={
                          entry.line !== undefined
                            ? `${entry.message} (line ${entry.line + 1})`
                            : entry.message
                        }
                        data-diagnostic-entry={entry.id}
                        onClick={() => jump(entry.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            cancel();
                          }
                        }}
                      >
                        {entry.message}
                        {entry.line !== undefined
                          ? ` (line ${entry.line + 1})`
                          : null}
                      </button>
                    ) : (
                      <span data-diagnostic-entry={entry.id}>
                        {entry.message}
                        {entry.line !== undefined
                          ? ` (line ${entry.line + 1})`
                          : null}
                      </span>
                    )}
                  </li>
                ))}
                {control.truncated === true &&
                control.totalCount !== undefined ? (
                  <li key="__truncated">
                    <span data-diagnostic-entry="truncated">
                      {`${control.totalCount - control.entries.length} more diagnostics`}
                    </span>
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </ToolbarPopoverPortal>
      ) : null}
    </div>
  );
}

/**
 * GoodNotes-style fixed slot shelf renderer.
 *
 * Data-driven presentation over caller-partitioned slot entries. The caller
 * chooses which items fill size/color/pen rows and owns order and visibility
 * overrides. The floating shelf wires this renderer, which owns geometry
 * and presentation only:
 *
 * - Fixed counts (3 size / 3 color / 4 pen). `toFixedSlots` keeps
 *   the first `count` entries in verbatim composition order and pads the
 *   rest with empty placeholders that render as fixed-width disabled slots
 *   — empty slots never collapse, never shift siblings. Surplus entries
 *   are never truncated silently: they flow in verbatim order to the
 *   `renderOverflow` outlet for the More menu. The
 *   container carries `data-overflow-count`, and an overflowed live tool
 *   is exposed via `activeOverflowSlots` plus `data-active-overflow`
 *  so its pressed marker survives in the outlet. The shelf
 *   never reorders: active is marked in place via `aria-pressed`, never moved.
 * - Active truth is single-sourced: button entries read the
 *   provider `control.active` (the flag `SurfaceToolButton` itself
 *   renders); other kinds read the explicit `entry.active` derived by the
 *   caller from the same snapshot tool. At most one slot editor opens at
 *   a time through shelf-claimed open ownership, cleared on
 *  `resetKey` (pane:document) change.
 * - Slot identity keys through `slotIdForItem`, using the declared `slotId`
 *   or item id as a shared fallback, never by guessing the id shape. The
 *   strip-group marker keys through `stripGroupIdForCategory`.
 * - Second activation on an active slot toggles its slot-scoped editor
 *  without re-executing (generalized second-tap): button-kind
 *   entries reuse `SurfaceToolButton` verbatim; every other kind gets the
 *   same lifecycle (positioned dialog, focus-first-on-open, Esc at both
 *   levels, outside dismissal, focus return, `resetKey` pane:document
 *   remount). Editors reuse `SurfaceSettingsPopoverBody` sections scoped
 *   to the owning slot — full hierarchy for pen slots (pen-type style,
 *   tip/tip-flatness/tip-angle, pressure %, and whatever else the provider
 *   emitted per `BRUSH_ADVANCED_SUPPORT`), size-only and color-only for
 *   size/color slots — always through the slot's own `execute` channel, so
 *  assigning a slot updates only that slot.
 * - Single-slot value editing: selecting an inactive size/color preset
 *   executes it; tapping the active preset opens its anchored, live editor.
 *   Commits flow through `onEditSlotSize`/`onEditSlotColor` (store-level, one
 *   slot at a time). Pen slots use their tool settings instead. Glyphs reflect the family:
 *   highlighter dots render at marker translucency, width bars thicker.
 * - `isActiveContext === false` (browsed != active) renders tools
 *   only: slot buttons keep executing, but no editor opens and no
 *   quicks/settings leak across categories.
 * - Icon-first triggers reuse `.fl-document-tool`, so the 44px coarse
 *   contract, `:focus-visible` rings, and single-row island geometry apply
 *  unchanged; slot chrome adds token-only fixed geometry.
 *   `disabled` passes through untouched on every trigger.
 *
 * Execution stays owner-routed: `execute` and each slot's settings
 * `execute` arrive pre-bound to `ownedById`/`executeOwned` by the caller.
 * This module performs no registration (lifecycle invariant holds by
 * construction — state plus effect cleanups only, mirroring the existing
 * button/input/diagnostics controls).
 */

export const SHELF_SIZE_SLOT_COUNT = 3;
export const SHELF_COLOR_SLOT_COUNT = 3;
export const SHELF_PEN_SLOT_COUNT = 4;

export type ShelfSlotKind = 'pen' | 'size' | 'color';

/**
 * `SurfaceSettingsPopoverBody` section filter. `undefined` (pen slots,
 * legacy buttons) renders the full hierarchy; size/color slots pass a
 * single section so the editor edits only its own slot.
 */
export type ShelfSlotEditorSection = 'color' | 'size' | 'core' | 'advanced';

/**
 * One fixed slot position. `control` is any provider control rendered
 * through the shared renderer; `value` is the preset committed on first
 * activation (size/color presets).
 *
 * Id domains — never mixed: the executable command owner is
 * always `control.id` (first-tap `execute` and every settings-row
 * `execute` route by control id through the caller-bound owner channel);
 * the stable presentation/scope key is `slotIdForItem(entry)` and is used
 * only for React keys, `settingsForSlot`/`surfaceForSlot` scoping, and
 * `data-slot-editor` markers. `entry.id`/`slotId` carry structure only.
 *
 * Active truth: button entries use `control.active`;
 * `entry.active` on them is ignored. Other kinds use `entry.active`,
 * derived by the caller from the same snapshot tool.
 */
export interface ShelfSlotEntry {
  readonly id: string;
  readonly slotId?: string;
  readonly control: DocumentToolControl;
  readonly value?: string;
  readonly active?: boolean;
}

export function defaultSlotCountForKind(kind: ShelfSlotKind): number {
  switch (kind) {
    case 'size':
      return SHELF_SIZE_SLOT_COUNT;
    case 'color':
      return SHELF_COLOR_SLOT_COUNT;
    case 'pen':
      return SHELF_PEN_SLOT_COUNT;
  }
}

/**
 * Partition entries into exactly `count` fixed inline positions (verbatim
 * order preserved, short rows padded with `null` placeholders) plus the
 * verbatim-ordered surplus for the overflow menu. Pure structure — no DOM.
 */
export function toFixedSlots(
  entries: readonly ShelfSlotEntry[],
  count: number,
): {
  readonly inline: readonly (ShelfSlotEntry | null)[];
  readonly overflow: readonly ShelfSlotEntry[];
} {
  const inline: (ShelfSlotEntry | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    inline.push(
      index < entries.length ? (entries[index] as ShelfSlotEntry) : null,
    );
  }
  return { inline, overflow: entries.slice(count) };
}

function slotControlDisabled(control: DocumentToolControl): boolean {
  switch (control.kind) {
    case 'button':
    case 'choice':
    case 'color':
    case 'input':
    case 'number':
    case 'table':
    case 'range':
      return control.disabled === true;
    case 'status':
    case 'diagnostics':
      return false;
  }
}

/**
 * Single active truth for shelf slots. Button-kind entries
 * read the provider-computed `control.active` — the same flag
 * `SurfaceToolButton` renders and reconciles on, so both cell paths agree
 * by construction and a stale `entry.active` can never fork them.
 * Every other kind reads the explicit `entry.active` flag, which the
 * caller derives from the same snapshot tool (exclusive-tool semantics —
 * toggles never count). `entry.active` on button entries is ignored.
 */
export function isShelfSlotActive(entry: ShelfSlotEntry): boolean {
  if (entry.control.kind === 'button') return entry.control.active === true;
  return entry.active === true;
}

/**
 * Active entries among surplus overflow slots. The shelf keeps
 * verbatim inline order and never promotes overflow entries; uses
 * this to mark its More outlet when the live tool sits beyond `count`.
 */
export function activeOverflowSlots(
  overflow: readonly ShelfSlotEntry[],
): readonly ShelfSlotEntry[] {
  return overflow.filter((entry) => isShelfSlotActive(entry));
}

function editorSectionsForKind(
  kind: ShelfSlotKind,
): readonly ShelfSlotEditorSection[] | undefined {
  // Pen slots keep the full hierarchy (family/style/color/size/core/
  // advanced); size/color editors scope to their own slot only.
  if (kind === 'size') return ['size'];
  if (kind === 'color') return ['color'];
  return undefined;
}

/**
 * Icon-first compact glyph for non-button slot triggers (button entries
 * reuse `SurfaceToolButton` visuals verbatim). Color slots show the live
 * value dot; size slots show a width bar scaled across the control's own
 * numeric options (presentation-only scaling, no semantic inference);
 * anything else falls back to the control's icon/short glyph. Labels
 * survive as accessible names only — never persistent visible text.
 *
 * Family rendering: `family` scopes the glyph to the
 * active slot family — highlighter color dots render at marker
 * translucency (`SURFACE_HIGHLIGHTER_GLYPH_OPACITY`) and highlighter
 * width bars scale 1.5x thicker, so the icons reflect the active family
 * without changing the underlying values. Explicit `sizeValue`/
 * `colorValue` (the family's stored slot value) win over the control
 * snapshot; absent they fall back to the control exactly as before.
 */
function SlotTriggerGlyph(props: {
  control: DocumentToolControl;
  family?: InkSlotFamily;
  sizeValue?: number;
  colorValue?: string;
}): React.ReactElement {
  const { control, family, sizeValue, colorValue } = props;
  const icon = toolbarControlIcon(control);
  if (control.kind === 'color') {
    const dot =
      colorValue ?? (control.kind === 'color' ? control.value : '#37352f');
    return (
      <span
        aria-hidden="true"
        className={styles['fl-document-tool-swatch']}
        style={
          family === 'highlighter'
            ? {
                backgroundColor: dot,
                opacity: SURFACE_HIGHLIGHTER_GLYPH_OPACITY,
              }
            : { backgroundColor: dot }
        }
      />
    );
  }
  if (control.kind === 'choice') {
    const current = sizeValue ?? Number(control.value);
    // The preview is the stored width, not a normalized approximation.
    const height = Number.isFinite(current) && current > 0 ? current : 4;
    return (
      <span
        aria-hidden="true"
        className={styles['fl-width-bar']}
        style={{ height }}
      />
    );
  }
  if (control.kind === 'button' && icon !== undefined) {
    return (
      <span className={styles['fl-document-tool-iconwrap']}>
        <Icon name={icon} size={16} />
        {control.swatch !== undefined ? (
          <span
            aria-hidden="true"
            className={styles['fl-document-tool-badge']}
            style={{ backgroundColor: control.swatch }}
          />
        ) : null}
      </span>
    );
  }
  if (control.kind === 'button' && control.swatch !== undefined) {
    return (
      <span
        aria-hidden="true"
        className={styles['fl-document-tool-swatch']}
        style={{ backgroundColor: control.swatch }}
      />
    );
  }
  if (control.kind === 'input' && icon !== undefined) {
    return <Icon name={icon} size={16} />;
  }
  if (control.kind === 'button') {
    return <Icon name="spark" size={16} />;
  }
  if (control.kind === 'input') {
    return <Icon name="edit" size={16} />;
  }
  return <Icon name="sliders" size={16} />;
}

/**
 * Single-slot edit commit from `ShelfSlotEditPopover`.
 * Exactly one of `sizeValue`/`colorValue` is present, matching `kind`;
 * `family` + `index` scope the edit so only that slot of the active
 * family changes — siblings and the other family are untouched.
 */
export interface ShelfSlotEditCommit {
  readonly kind: 'size' | 'color';
  readonly family: InkSlotFamily | 'eraser';
  readonly index: number;
  readonly sizeValue?: number;
  readonly colorValue?: string;
}

/** Loose `#rrggbb` test for the native color-picker display value only. */
function asPickerColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
}

/**
 * Anchored, live value editor for the active size/color preset.
 */
export function ShelfSlotEditPopover(props: {
  readonly kind: 'size' | 'color';
  readonly family: InkSlotFamily | 'eraser';
  readonly index: number;
  readonly sizeValue: number;
  readonly colorValue: string;
  readonly swatches?: readonly string[];
  readonly sizeMin?: number;
  readonly sizeMax?: number;
  readonly sizeStep?: number;
  readonly anchorRef?: React.RefObject<HTMLElement | null>;
  readonly onCommit: (commit: ShelfSlotEditCommit) => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const {
    kind,
    family,
    index,
    sizeValue,
    colorValue,
    anchorRef,
    onCommit,
    onClose,
  } = props;
  const swatches = props.swatches ?? SURFACE_SHARED_SWATCHES;
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const fallbackAnchorRef = useRef<HTMLElement | null>(null);
  const position = useToolbarPopoverPosition({
    triggerRef: anchorRef ?? fallbackAnchorRef,
    popoverRef,
    enabled: anchorRef !== undefined,
  });
  const [draftSize, setDraftSize] = useState(String(sizeValue));
  const [draftColor, setDraftColor] = useState(colorValue);
  useEffect(() => {
    focusFirstFocusable(popoverRef.current);
  }, []);
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        popoverRef.current?.contains(target) ||
        anchorRef?.current?.contains(target)
      )
        return;
      onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [anchorRef, onClose]);
  const parsedSize = Number(draftSize);
  const sizeMin = props.sizeMin ?? 0.5;
  const sizeMax = props.sizeMax ?? 100;
  const sizeStep = props.sizeStep ?? 0.5;
  const sizeValid =
    draftSize.trim() !== '' &&
    Number.isFinite(parsedSize) &&
    parsedSize >= sizeMin &&
    parsedSize <= sizeMax;
  const title =
    kind === 'size'
      ? `Edit size slot ${index + 1}`
      : `Edit color slot ${index + 1}`;
  const familyLabel =
    family === 'highlighter'
      ? 'Highlighter'
      : family === 'eraser'
        ? 'Precision Eraser'
        : 'Pen';
  const updateSize = (value: string): void => {
    setDraftSize(value);
    const next = Number(value);
    if (
      value.trim() !== '' &&
      Number.isFinite(next) &&
      next >= sizeMin &&
      next <= sizeMax
    )
      onCommit({ kind: 'size', family, index, sizeValue: next });
  };
  const updateColor = (value: string): void => {
    setDraftColor(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value.trim()))
      onCommit({ kind: 'color', family, index, colorValue: value.trim() });
  };
  return (
    <ToolbarPopoverPortal>
      <div
        className={`${styles['fl-document-tool-popover']} ${styles['fl-tool-settings-popover']} ${styles['fl-slot-edit-popover']}`}
        role="dialog"
        aria-label={title}
        data-slot-edit-kind={kind}
        data-slot-edit-index={String(index)}
        data-slot-family={family}
        ref={popoverRef}
        data-popover-placement={position?.placement ?? 'below'}
        style={
          anchorRef !== undefined
            ? position !== null
              ? {
                  position: 'fixed',
                  left: position.left,
                  top: position.top,
                  maxWidth: position.maxWidth,
                  maxHeight: position.maxHeight,
                  overflow: 'auto',
                  transform: 'none',
                }
              : { position: 'fixed' }
            : {
                position: 'relative',
                top: 'auto',
                left: 'auto',
                transform: 'none',
              }
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <p className={styles['fl-tool-settings-title']} aria-hidden="true">
          {title}
        </p>
        <p className={styles['fl-document-tool-status']} aria-hidden="true">
          {familyLabel} slots
        </p>
        {kind === 'size' ? (
          <div className={styles['fl-slot-edit-controls']}>
            <Slider
              aria-label={
                family === 'eraser' ? 'Eraser size slider' : 'Slot width slider'
              }
              min={sizeMin}
              max={sizeMax}
              step={sizeStep}
              value={sizeValid ? parsedSize : sizeMin}
              onChange={(event) => updateSize(event.currentTarget.value)}
            />
            <label className={styles['fl-document-tool-number']}>
              <span>
                {family === 'eraser' ? 'Eraser size' : 'Width in points'}
              </span>
              <input
                type="number"
                aria-label={
                  family === 'eraser'
                    ? 'Eraser size in points'
                    : 'Slot width in points'
                }
                value={draftSize}
                min={sizeMin}
                max={sizeMax}
                step={sizeStep}
                onChange={(event) => updateSize(event.currentTarget.value)}
              />
              <span aria-hidden="true">pt</span>
            </label>
          </div>
        ) : (
          <div className={styles['fl-slot-edit-controls']}>
            <label className={styles['fl-document-tool-number']}>
              <span>Slot color</span>
              <input
                type="color"
                aria-label="Slot color picker"
                value={asPickerColor(draftColor.trim())}
                onChange={(event) => updateColor(event.currentTarget.value)}
              />
              <input
                type="text"
                aria-label="Slot color value"
                value={draftColor}
                placeholder="#rrggbb"
                onChange={(event) => updateColor(event.currentTarget.value)}
              />
            </label>
            <div
              className={styles['fl-document-colors']}
              aria-label="Quick colors"
            >
              {swatches.map((swatch) => (
                <button
                  type="button"
                  className={styles['fl-document-color']}
                  aria-label={`Color: ${swatch}`}
                  aria-pressed={
                    draftColor.trim().toLowerCase() === swatch.toLowerCase()
                  }
                  title={swatch}
                  style={{ backgroundColor: swatch }}
                  key={swatch}
                  onClick={() => updateColor(swatch)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </ToolbarPopoverPortal>
  );
}

/**
 * Generalized second-tap slot cell for non-button entries (button entries
 * delegate to `SurfaceToolButton`, which owns the identical lifecycle).
 * First activation executes through the slot channel; second activation on
 * the active slot toggles the slot-scoped editor without re-executing.
 */
function ShelfSlotCell(props: {
  entry: ShelfSlotEntry;
  slotKey: string;
  kind: ShelfSlotKind;
  /** Position in the shelf `entries` (pre-overflow); scopes modal edits. */
  index: number;
  /** Active slot family scoping values, glyphs, and modal commits. */
  family: InkSlotFamily;
  /** Family slot value overrides for the trigger glyph + modal draft. */
  sizeValue?: number;
  colorValue?: string;
  /** Single-slot live edit channels; absent disables preset editing. */
  onEditSlotSize?: (index: number, value: number) => void;
  onEditSlotColor?: (index: number, color: string) => void;
  onReorderSlotColor?: (from: number, to: number) => void;
  execute: ControlExecute;
  settings: SurfaceToolSettingsSource;
  resetKey?: string;
  openCoordination?: SlotOpenCoordination;
  /**
   * Browsed==active gate. `false` renders tools only:
   * second-tap editors stay closed (settings already arrive as
   * `NO_SETTINGS`).
   */
  isActiveContext?: boolean;
}): React.ReactElement {
  const {
    entry,
    slotKey,
    kind,
    index,
    family,
    sizeValue,
    colorValue,
    onEditSlotSize,
    onEditSlotColor,
    onReorderSlotColor,
    execute,
    settings,
    resetKey,
    openCoordination,
  } = props;
  const isActiveContext = props.isActiveContext ?? true;
  const { control } = entry;
  const isActive = isShelfSlotActive(entry);
  const [open, setOpen] = useState(false);
  // Active size/color presets open their own live value editor.
  const canEditSlot =
    isActiveContext &&
    ((kind === 'size' && onEditSlotSize !== undefined) ||
      (kind === 'color' && onEditSlotColor !== undefined));
  const [editOpen, setEditOpen] = useState(false);
  // Pane-global exclusive-open + resetKey-clear-all: same
  // contract as `SurfaceToolButton` above — claims the pane scope on open,
  // closes on foreign claims and on pane:document change.
  const disclosure = useToolbarDisclosure({ resetKey, open, setOpen });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const reorderingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [reordering, setReordering] = useState(false);
  useEffect(
    () => () => {
      if (longPressRef.current !== null) clearTimeout(longPressRef.current);
    },
    [],
  );
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const position = useToolbarPopoverPosition({
    triggerRef,
    popoverRef,
    enabled: open,
  });
  // Dialog focus contract shared with every toolbar disclosure: keyboard
  // lands inside on open; pointer focus stays visually quiet.
  useFocusFirstOnOpen(open, popoverRef);
  useEffect(() => {
    if (!isActive) setOpen(false);
  }, [isActive]);
  const closePopover = useCallback((): void => setOpen(false), []);
  useDismissOpenOnOutside({
    open,
    onClose: closePopover,
    triggerRef,
    popoverRef,
  });
  // Shelf exclusive-open: another slot's claim closes this one.
  useEffect(() => {
    if (!open || openCoordination === undefined) return;
    if (
      openCoordination.claimedOpenKey !== null &&
      openCoordination.claimedOpenKey !== openCoordination.slotKey
    )
      setOpen(false);
  }, [openCoordination, open]);
  // The value editor shares the shelf + pane exclusivity: a foreign claim
  // or a pane:document change closes it like any other disclosure.
  useEffect(() => {
    setEditOpen(false);
  }, [resetKey]);
  useEffect(() => {
    if (openCoordination === undefined) return;
    if (openCoordination.claimedOpenKey !== openCoordination.slotKey)
      setEditOpen(false);
  }, [openCoordination]);
  const closeEdit = useCallback((): void => {
    setEditOpen(false);
    // Symmetric release with `openEdit`'s claim: the editor
    // holds shelf + pane exclusivity while open, so closing (Cancel, Esc,
    // backdrop) releases both instead of leaving a stale claim.
    openCoordination?.onClaimOpen(null);
    disclosure.release();
    triggerRef.current?.focus();
  }, [openCoordination, disclosure]);
  const openEdit = useCallback((): void => {
    if (!isActiveContext || !canEditSlot || slotControlDisabled(control))
      return;
    // Keep only one editor open in this pane.
    setOpen(false);
    openCoordination?.onClaimOpen(openCoordination.slotKey);
    disclosure.claimOpen();
    setEditOpen(true);
  }, [isActiveContext, canEditSlot, control, openCoordination, disclosure]);
  const hasEditor = settings.controls.length > 0;
  const dialogued = isActive && (canEditSlot || hasEditor);
  const disabled = slotControlDisabled(control);
  const fallbackSize = control.kind === 'choice' ? Number(control.value) : NaN;
  const modalSize =
    sizeValue ??
    (Number.isFinite(fallbackSize) && fallbackSize > 0 ? fallbackSize : 3.5);
  const modalColor =
    colorValue ?? (control.kind === 'color' ? control.value : '#37352f');
  return (
    <div className={styles['fl-document-tool-popover-wrap']}>
      <button
        type="button"
        className={styles['fl-document-tool']}
        aria-label={control.label}
        aria-pressed={isActive}
        aria-haspopup={dialogued ? 'dialog' : undefined}
        aria-expanded={dialogued ? open || editOpen : undefined}
        title={control.label}
        disabled={disabled}
        data-slot-kind={kind}
        data-slot-family={family}
        data-slot-index={String(index)}
        data-reordering={reordering ? 'true' : undefined}
        draggable={kind === 'color' && onReorderSlotColor !== undefined}
        style={
          kind === 'color' && onReorderSlotColor !== undefined
            ? { touchAction: 'none' }
            : undefined
        }
        ref={triggerRef}
        onPointerDown={(event) => {
          if (
            kind !== 'color' ||
            onReorderSlotColor === undefined ||
            event.pointerType === 'mouse'
          )
            return;
          pressStartRef.current = { x: event.clientX, y: event.clientY };
          reorderingRef.current = false;
          longPressRef.current = setTimeout(() => {
            reorderingRef.current = true;
            setReordering(true);
            suppressClickRef.current = true;
            triggerRef.current?.setPointerCapture(event.pointerId);
          }, 420);
        }}
        onPointerMove={(event) => {
          const start = pressStartRef.current;
          if (
            start === null ||
            reorderingRef.current ||
            longPressRef.current === null
          )
            return;
          if (
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
          ) {
            clearTimeout(longPressRef.current);
            longPressRef.current = null;
          }
        }}
        onPointerUp={(event) => {
          if (longPressRef.current !== null) clearTimeout(longPressRef.current);
          longPressRef.current = null;
          pressStartRef.current = null;
          if (!reorderingRef.current || onReorderSlotColor === undefined)
            return;
          reorderingRef.current = false;
          setReordering(false);
          const target = document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLButtonElement>(
              '[data-slot-kind="color"][data-slot-index]',
            );
          if (target?.dataset.slotFamily === family) {
            const destination = Number(target.dataset.slotIndex);
            if (Number.isInteger(destination) && destination !== index)
              onReorderSlotColor(index, destination);
          }
        }}
        onPointerCancel={() => {
          if (longPressRef.current !== null) clearTimeout(longPressRef.current);
          longPressRef.current = null;
          pressStartRef.current = null;
          reorderingRef.current = false;
          setReordering(false);
          suppressClickRef.current = false;
        }}
        onDragStart={(event) => {
          if (kind !== 'color' || onReorderSlotColor === undefined) return;
          event.dataTransfer.setData(
            'text/froglight-color-slot',
            `${family}:${index}`,
          );
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          if (kind === 'color' && onReorderSlotColor !== undefined)
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (kind !== 'color' || onReorderSlotColor === undefined) return;
          event.preventDefault();
          const source = event.dataTransfer.getData(
            'text/froglight-color-slot',
          );
          const [sourceFamily, sourceIndex] = source.split(':');
          if (sourceFamily === family && /^\d+$/.test(sourceIndex ?? ''))
            onReorderSlotColor(Number(sourceIndex), index);
        }}
        onDoubleClick={() => {
          if (canEditSlot && !disabled) openEdit();
        }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (disabled) return;
          if (dialogued) {
            if (canEditSlot) {
              if (editOpen) closeEdit();
              else openEdit();
              return;
            }
            const next = !open;
            if (next) {
              openCoordination?.onClaimOpen(openCoordination.slotKey);
              disclosure.claimOpen();
            } else {
              openCoordination?.onClaimOpen(null);
              disclosure.release();
            }
            setOpen(next);
          } else {
            disclosure.release();
            setOpen(false);
            execute(control.id, entry.value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }
        }}
      >
        <SlotTriggerGlyph
          control={control}
          family={family}
          sizeValue={sizeValue}
          colorValue={colorValue}
        />
      </button>
      {open && hasEditor ? (
        <ToolbarPopoverPortal>
          <div
            className={`${styles['fl-document-tool-popover']} ${styles['fl-tool-settings-popover']}`}
            role="dialog"
            aria-label={`${control.label} settings`}
            ref={popoverRef}
            data-popover-placement={position?.placement ?? 'below'}
            data-slot-editor={slotKey}
            key={resetKey}
            style={
              position !== null
                ? {
                    position: 'fixed',
                    left: position.left,
                    top: position.top,
                    maxWidth: position.maxWidth,
                    maxHeight: Math.min(position.maxHeight, 420),
                    overflow: 'auto',
                    transform: 'none',
                  }
                : { position: 'fixed' }
            }
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus();
              }
            }}
          >
            <SurfaceSettingsPopoverBody
              control={{ label: control.label }}
              settings={settings}
              sections={editorSectionsForKind(kind)}
            />
          </div>
        </ToolbarPopoverPortal>
      ) : null}
      {editOpen && canEditSlot && (kind === 'size' || kind === 'color') ? (
        <ShelfSlotEditPopover
          kind={kind}
          family={family}
          index={index}
          sizeValue={modalSize}
          colorValue={modalColor}
          anchorRef={triggerRef}
          onCommit={(commit) => {
            if (commit.kind === 'size' && commit.sizeValue !== undefined)
              onEditSlotSize?.(index, commit.sizeValue);
            if (commit.kind === 'color' && commit.colorValue !== undefined)
              onEditSlotColor?.(index, commit.colorValue);
          }}
          onClose={closeEdit}
        />
      ) : null}
    </div>
  );
}

export interface ShelfSlotShelfProps {
  /** Slot family driving fixed counts, trigger glyphs, and editor scope. */
  readonly kind: ShelfSlotKind;
  /** Active slot family: `'pen'` is the shared pen-family
   * set, `'highlighter'` the independent set. Defaults to `'pen'`. */
  readonly family?: InkSlotFamily;
  /**
   * Family slot values for trigger glyphs and live editors:
   * resolved triples (`slotSizesForFamily`/`slotColorsForFamily`).
   * Absent falls back to each control's snapshot value exactly as before.
   */
  readonly slotSizes?: readonly number[];
  readonly slotColors?: readonly string[];
  /**
   * Single-slot live edit channels: tapping the active size/color slot
   * opens its anchored editor. Pen slots use tool settings instead.
   */
  readonly onEditSlotSize?: (index: number, value: number) => void;
  readonly onEditSlotColor?: (index: number, color: string) => void;
  readonly onReorderSlotColor?: (from: number, to: number) => void;
  /** Accessible group name (e.g. `"Pen slots"`). No visible label. */
  readonly label: string;
  /**
   * Owning strip group for the `data-strip-group` marker (shared
   * `stripGroupIdForCategory` fallback — declared `groupId` or the id).
   */
  readonly group: { readonly id: string; readonly groupId?: string };
  /** Composition-ordered slot entries (verbatim order is the authority). */
  readonly entries: readonly ShelfSlotEntry[];
  /** Fixed positions; defaults to `defaultSlotCountForKind(kind)`. */
  readonly count?: number;
  /** Owner-routed slot activation channel (pre-bound `executeOwned`). */
  readonly execute: ControlExecute;
  /** Slot-scoped settings per effective slot id (pre-bound owners). */
  readonly settingsForSlot: (slotKey: string) => SurfaceToolSettingsSource;
  /** Slot-scoped shelf extras (pen-family selector passthrough). */
  readonly surfaceForSlot?: (slotKey: string) => SurfaceToolExtras | undefined;
  /** Pane:document key remounting open editors on tab/document switch. */
  readonly resetKey?: string;
  /**
   * Overflow outlet. Invoked with the verbatim-ordered surplus
   * entries whenever `entries` exceeds `count`, so surplus tools stay
   * reachable — the shelf never truncates silently. The shelf wires its More
   * menu here (rendering each surplus entry through the shared renderer
   * with `aria-pressed` from `isShelfSlotActive`, so an overflowed live
   * tool keeps its pressed marker in the overflow menu. Omit this outlet to
   * render inline positions only.
   */
  readonly renderOverflow?: (
    overflow: readonly ShelfSlotEntry[],
  ) => React.ReactNode;
  /**
   * Browsed==active gate. `false` renders tools only —
   * slot buttons still execute, but second-tap editors never open so no
   * quicks/settings leak into a browsed foreign category.
   */
  readonly isActiveContext?: boolean;
}

/**
 * One renderer for every slot kind, with stable order, fixed counts,
 * second-activation editors, and keyboard accessibility:
 * a single-row icon-first group with fixed positions in verbatim order,
 * active marked in place, empty placeholders never collapsing, and
 * slot-scoped editors shared with the compact triggers' command channel.
 *
 * Overflow behavior: inline positions keep
 * the first `count` entries verbatim — the shelf never promotes, demotes,
 * or drops entries, so the live tool may sit beyond `count`. The surplus
 * (in verbatim order) flows to `renderOverflow`, the container carries
 * `data-overflow-count`, and `data-active-overflow="true"` marks the
 * overflowed-live-tool state (`activeOverflowSlots` selects those
 * entries) so the More outlet can keep the pressed marker visible.
 */
export function ShelfSlotShelf(props: ShelfSlotShelfProps): React.ReactElement {
  const {
    kind,
    label,
    group,
    entries,
    execute,
    settingsForSlot,
    surfaceForSlot,
    resetKey,
    renderOverflow,
  } = props;
  const family = props.family ?? 'pen';
  const slotSizes = props.slotSizes;
  const slotColors = props.slotColors;
  const onEditSlotSize = props.onEditSlotSize;
  const onEditSlotColor = props.onEditSlotColor;
  const onReorderSlotColor = props.onReorderSlotColor;
  const isActiveContext = props.isActiveContext ?? true;
  const count = props.count ?? defaultSlotCountForKind(kind);
  const { inline, overflow } = toFixedSlots(entries, count);
  const scopedSections = editorSectionsForKind(kind);
  // Exclusive-open ownership: one claimed slot key per shelf;
  // cells claim on open and close on foreign claims. Cleared whenever the
  // pane:document key changes, so tab/document switches never inherit a
  // stale open editor (belt-and-braces beside remounting by key).
  const [claimedOpenKey, setClaimedOpenKey] = useState<string | null>(null);
  useEffect(() => {
    setClaimedOpenKey(null);
  }, [resetKey]);
  const onClaimOpen = useCallback(
    (slotKey: string | null): void => setClaimedOpenKey(slotKey),
    [],
  );
  const overflowActive = activeOverflowSlots(overflow);
  return (
    <div
      className={styles['fl-shelf-slots']}
      role="group"
      aria-label={label}
      data-slot-kind={kind}
      data-strip-group={stripGroupIdForCategory(group)}
      data-overflow-count={overflow.length}
      {...(overflowActive.length > 0 ? { 'data-active-overflow': 'true' } : {})}
    >
      {inline.map((entry, index) => {
        if (entry === null) {
          return (
            <button
              type="button"
              className={`${styles['fl-document-tool']} ${styles['fl-shelf-slot-empty']}`}
              aria-label={`Empty ${kind} slot ${index + 1}`}
              data-empty-slot="true"
              data-slot-kind={kind}
              disabled
              key={`__empty:${kind}:${index}`}
            />
          );
        }
        const slotKey = slotIdForItem(entry);
        const slotSettings = isActiveContext
          ? settingsForSlot(slotKey)
          : NO_SETTINGS;
        const openCoordination: SlotOpenCoordination = {
          slotKey,
          claimedOpenKey,
          onClaimOpen,
        };
        if (entry.control.kind === 'button') {
          const baseSurface = surfaceForSlot?.(slotKey);
          const surface =
            baseSurface !== undefined || scopedSections !== undefined
              ? {
                  ...baseSurface,
                  editorSections: scopedSections ?? baseSurface?.editorSections,
                }
              : undefined;
          return (
            <SurfaceToolButton
              key={slotKey}
              control={entry.control}
              execute={(id, value) => execute(id, value ?? entry.value)}
              settings={slotSettings}
              resetKey={resetKey}
              surface={surface}
              openCoordination={openCoordination}
            />
          );
        }
        return (
          <ShelfSlotCell
            key={slotKey}
            entry={entry}
            slotKey={slotKey}
            kind={kind}
            index={index}
            family={family}
            sizeValue={kind === 'size' ? slotSizes?.[index] : undefined}
            colorValue={kind === 'color' ? slotColors?.[index] : undefined}
            onEditSlotSize={onEditSlotSize}
            onEditSlotColor={onEditSlotColor}
            onReorderSlotColor={onReorderSlotColor}
            execute={execute}
            settings={slotSettings}
            resetKey={resetKey}
            openCoordination={openCoordination}
            isActiveContext={isActiveContext}
          />
        );
      })}
      {renderOverflow?.(overflow) ?? null}
    </div>
  );
}
