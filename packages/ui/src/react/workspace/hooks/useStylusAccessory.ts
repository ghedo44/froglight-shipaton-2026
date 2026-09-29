/**
 * Shell binding for stylus accessory actions (hardened).
 *
 * Mounts the framework-free `StylusAccessoryBinder` for the lifetime of
 * the workspace view: squeeze opens the built-in Pencil quick palette near
 * the Pencil tip (core `DocumentToolSnapshot` tools plus registry
 * contributions), double-tap honors the system preferred action, and the
 * rubber end auto-selects the eraser with restore on release.
 */

import { useEffect, useRef } from 'react';
import { settingsToken, stylusToken } from '@froglight/foundation';
import { ToolbarCustomizationStore } from '../../../toolbar/toolbar-customization.js';
import { showContextMenu } from '../../../menu.js';
import {
  StylusAccessoryBinder,
  type StylusAccessoryCommandsPort,
  type StylusAccessoryMenuAnchor,
  type StylusAccessoryToolsPort,
} from '../../../stylus-accessory.js';
import type { StylusPaletteModel } from '../../../stylus-palette-model.js';
import { showStylusPalette } from '../../StylusPaletteOverlay.jsx';
import { stylusMenuRegistryToken } from '../../../stylus-menu-registry.js';
import type { UiServiceLookup } from '../../../workbench.js';
import type { WorkbenchEditorToolsPort } from '../../../workbench-ports.js';
import type { StylusMenuContext } from '../../../stylus-menu-registry.js';
import { toolbarCompositionToken } from '../../../toolbar/composition-registry.js';
import {
  documentToolbarRegistryToken,
  type DocumentToolbarContext,
  type DocumentToolbarRegistry,
} from '../../../document-toolbar-registry.js';
import type { OwnedToolbarControl } from '../../../toolbar/placement-resolver.js';

/**
 * Viewport-centered safe fallback anchor (last resort only). The normal
 * path is `hoverPose.location` → latest pen PointerEvent → focused surface
 * center → this fallback.
 */
export function defaultStylusMenuAnchor(): StylusAccessoryMenuAnchor {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  return {
    x: Math.round(window.innerWidth / 2),
    y: Math.round(window.innerHeight / 2),
  };
}

/**
 * Focused-surface-center fallback: the center of the focused document
 * surface when measurable, otherwise the viewport center. Never throws —
 * geometry failures degrade to the safe viewport fallback.
 */
export function defaultSurfaceCenter(
  doc?: Document,
): StylusAccessoryMenuAnchor {
  const fallback = defaultStylusMenuAnchor();
  try {
    const target = doc ?? (typeof document === 'undefined' ? null : document);
    const main = target?.querySelector('[data-fl-component="main"]') ?? null;
    if (main instanceof HTMLElement) {
      const rect = main.getBoundingClientRect();
      if (
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top) &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }
    }
  } catch {
    // Geometry failures degrade to the viewport fallback below.
  }
  return fallback;
}

/**
 * Dev-only squeeze diagnostic channel (mirrors `reportDiagnostics` in
 * `UnifiedToolbar`: silent in production, `console.error` in dev/test).
 * The binder receives it as `deps.diagnostics` so assembly/probe failures
 * never silently disappear in production paths. Never throws.
 */
function reportSqueezeDiagnostic(message: string): void {
  try {
    if (
      typeof process !== 'undefined' &&
      (process.env?.['NODE_ENV'] ?? 'development') !== 'production'
    ) {
      console.error(`[toolbar-placement] ${message}`);
    }
  } catch {
    // Diagnostics must never throw.
  }
}

/**
 * Resubscribing `onDidChange` liveness.
 *
 * The binder subscribes once to a stable proxy; the proxy subscribes to the
 * current live source and re-subscribes when `resolveSource` identity
 * changes — no binder remount, no palette remount, no polling, no second
 * store. Exactly-once per live source: old disposed once, new subscribed
 * once; old emits no longer push. Throwing resolvers/sources degrade to a
 * no-op subscription (never throw). `reconcile()` is idempotent and cheap
 * (identity compare); the hook calls it on source-identity effects and it
 * notifies listeners on swap so the open palette refreshes in place.
 */
export interface ResubscribingLiveness {
  readonly onDidChange: (listener: () => void) => { dispose(): void };
  reconcile(): void;
}

export function createResubscribingLiveness(
  resolveSource: () => {
    onDidChange?: (listener: () => void) => { dispose(): void };
  } | null | undefined,
  onError?: (error: unknown) => void,
): ResubscribingLiveness {
  const listeners = new Set<() => void>();
  let currentSource: unknown = null;
  let currentSub: { dispose(): void } | null = null;
  let initialized = false;

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Binder refresh is internally guarded; never break fan-out.
      }
    }
  };

  const subscribeTo = (source: unknown): void => {
    if (currentSub !== null) {
      try {
        currentSub.dispose();
      } catch {
        // Teardown must never throw.
      }
      currentSub = null;
    }
    currentSource = source;
    if (source === null || source === undefined) return;
    const onDidChange = (source as { onDidChange?: unknown }).onDidChange;
    if (typeof onDidChange !== 'function') return;
    try {
      currentSub = (
        onDidChange as (listener: () => void) => { dispose(): void }
      ).call(source, emit);
    } catch (error) {
      onError?.(error);
      currentSub = null;
    }
  };

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      if (!initialized) {
        initialized = true;
        try {
          subscribeTo(resolveSource());
        } catch (error) {
          onError?.(error);
        }
      }
      let disposed = false;
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
          if (listeners.size === 0 && currentSub !== null) {
            try {
              currentSub.dispose();
            } catch {
              // Teardown must never throw.
            }
            currentSub = null;
            initialized = false;
          }
        },
      };
    },
    reconcile: () => {
      if (!initialized) return;
      let next: unknown;
      try {
        next = resolveSource();
      } catch (error) {
        onError?.(error);
        return;
      }
      if (next !== currentSource) {
        subscribeTo(next);
        // The swap itself may carry new data: notify so the open palette
        // refreshes in place (equality gates no-ops, no remount).
        emit();
      }
    },
  };
}

/**
 * Narrow stable proxies for the squeeze binder.
 *
 * Pure factory over a `live` getter: data reads stay fresh per call
 * (`live()`), liveness rides the provided resubscribing controllers (stable
 * identity, no remount). Throwing data probes degrade to safe defaults and
 * report via `report` (never throw, never leak `boom` text into UI).
 * Exported so binder-seam specs can prove direct/absent/fallback/throwing
 * behavior without mounting React.
 */
export function createStylusAccessoryStablePorts(input: {
  readonly live: () => {
    readonly tools: Pick<
      WorkbenchEditorToolsPort,
      | 'editorToolSnapshot'
      | 'executeEditorTool'
      | 'canExecEditorCommand'
      | 'execEditorCommand'
    > &
      Partial<Pick<WorkbenchEditorToolsPort, 'onDidChange'>>;
    readonly toolbarRegistry?: (Pick<
      DocumentToolbarRegistry,
      'entries' | 'executeOwned'
    > &
      Partial<Pick<DocumentToolbarRegistry, 'onDidChange'>>) | null;
    readonly services: UiServiceLookup;
  };
  readonly toolsLiveness: ResubscribingLiveness;
  readonly toolbarLiveness: ResubscribingLiveness;
  readonly report?: (message: string) => void;
}): {
  readonly tools: StylusAccessoryToolsPort & StylusAccessoryCommandsPort;
  readonly toolbarRegistry: Pick<DocumentToolbarRegistry, 'entries'> &
    Partial<Pick<DocumentToolbarRegistry, 'onDidChange'>>;
} {
  const describe = (error: unknown): string =>
    error instanceof Error && error.message !== ''
      ? error.message
      : String(error);
  const report = input.report ?? ((): void => undefined);
  return {
    tools: {
      editorToolSnapshot: (pane) => {
        try {
          return input.live().tools.editorToolSnapshot(pane);
        } catch (error) {
          report(`squeeze tool snapshot probe failed: ${describe(error)}`);
          return null;
        }
      },
      executeEditorTool: (pane, id, value) => {
        try {
          return input.live().tools.executeEditorTool(pane, id, value);
        } catch (error) {
          report(`squeeze tool execute failed: ${describe(error)}`);
          return false;
        }
      },
      canExecEditorCommand: (command, pane) => {
        try {
          return input.live().tools.canExecEditorCommand(command, pane);
        } catch (error) {
          report(`squeeze history probe failed: ${describe(error)}`);
          return false;
        }
      },
      execEditorCommand: (command, pane) => {
        try {
          return input.live().tools.execEditorCommand(command, pane);
        } catch (error) {
          report(`squeeze history execute failed: ${describe(error)}`);
          return false;
        }
      },
      onDidChange: (listener) => input.toolsLiveness.onDidChange(listener),
    },
    toolbarRegistry: {
      entries: (context) => {
        try {
          const live = input.live();
          const direct =
            live.toolbarRegistry ??
            live.services.try(documentToolbarRegistryToken) ??
            null;
          return direct?.entries(context) ?? [];
        } catch (error) {
          report(
            `squeeze toolbar registry entries failed: ${describe(error)}`,
          );
          return [];
        }
      },
      onDidChange: (listener) =>
        input.toolbarLiveness.onDidChange(listener),
    },
  };
}

/**
 * Single execution owner for squeeze palette selections. Mirrors
 * `executeOwnedControl` (UnifiedToolbar): the resolved control already
 * knows which channel owns it, so a contribution can never hijack a
 * provider-owned id and provider code never probes contribution channels.
 */
export function executeSqueezeOwned(
  deps: {
    readonly tools: Pick<
      WorkbenchEditorToolsPort,
      'executeEditorTool' | 'execEditorCommand'
    >;
    readonly contributions: Pick<
      DocumentToolbarRegistry,
      'executeOwned'
    > | null;
    readonly pane: string;
    readonly context: DocumentToolbarContext;
  },
  item: OwnedToolbarControl,
  value?: string,
): boolean | Promise<boolean> | void {
  switch (item.owner.kind) {
    case 'provider':
      return deps.tools.executeEditorTool(deps.pane, item.control.id, value);
    case 'shell':
      return deps.tools.execEditorCommand(item.owner.command, deps.pane);
    case 'contribution': {
      if (deps.contributions === null) return;
      return deps.contributions.executeOwned(
        item.owner.contributionId,
        deps.context,
        item.control.id,
        value,
      );
    }
  }
}

export function useStylusAccessory(input: {
  readonly services: UiServiceLookup;
  readonly tools: Pick<
    WorkbenchEditorToolsPort,
    | 'editorToolSnapshot'
    | 'executeEditorTool'
    | 'canExecEditorCommand'
    | 'execEditorCommand'
  > &
    Partial<Pick<WorkbenchEditorToolsPort, 'onDidChange'>>;
  readonly focusedPane: string | null;
  readonly menuContext: StylusMenuContext | null;
  /**
   * Document toolbar contributions for squeeze owned-pool assembly and
   * owned execution. Falls back to
   * `services.try(documentToolbarRegistryToken)` when omitted so the
   * production workspace needs no extra wiring once the token is exposed.
   * When present, `onDidChange` participates in the narrow
   * proxy (direct first, service fallback); absent stays a no-op push
   * (no polling).
   */
  readonly toolbarRegistry?: (Pick<
    DocumentToolbarRegistry,
    'entries' | 'executeOwned'
  > &
    Partial<Pick<DocumentToolbarRegistry, 'onDidChange'>>) | null;
}): void {
  const live = useRef(input);
  live.current = input;
  const { services } = input;

  // Cheap latest-pen-position tracking (no native hover stream, no IPC).
  const penAnchor = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType !== 'pen') return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY))
        return;
      penAnchor.current = {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      };
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, []);

  // Route one palette selection through its preserved owner (same rule as
  // `executeOwnedControl` in UnifiedToolbar): provider via
  // `executeEditorTool`, shell via `execEditorCommand`, contribution via
  // `executeOwned`. Legacy snapshot-only models without `owned` fall back
  // to the provider channel.: returns the raw execute result so
  // callers refresh again after Promise resolution (async commits).
  const routeSqueezeTool = (
    model: StylusPaletteModel,
    id: string,
    value?: string,
  ): boolean | Promise<boolean> | void => {
    const pane = live.current.focusedPane;
    if (pane === null) return;
    const owned = (model.owned ?? []).find(
      (entry) => entry.control.id === id,
    );
    if (owned === undefined) {
      try {
        return live.current.tools.executeEditorTool(pane, id, value);
      } catch {
        return;
      }
    }
    const menuCtx = live.current.menuContext;
    if (menuCtx?.kindId == null || menuCtx?.documentId == null) {
      // No toolbar identity: only provider/shell can run without context.
      if (owned.owner.kind === 'provider') {
        try {
          return live.current.tools.executeEditorTool(pane, id, value);
        } catch {
          return;
        }
      } else if (owned.owner.kind === 'shell') {
        try {
          return live.current.tools.execEditorCommand(owned.owner.command, pane);
        } catch {
          return;
        }
      }
      return;
    }
    let editor: DocumentToolbarContext['editor'] = null;
    try {
      editor = live.current.tools.editorToolSnapshot(pane);
    } catch {
      editor = null;
    }
    const toolbarContext: DocumentToolbarContext = {
      pane,
      documentId: menuCtx.documentId,
      kindId: menuCtx.kindId,
      editor,
    };
    const registry =
      live.current.toolbarRegistry ??
      live.current.services.try(documentToolbarRegistryToken) ??
      null;
    try {
      return executeSqueezeOwned(
        { tools: live.current.tools, contributions: registry, pane, context: toolbarContext },
        owned,
        value,
      );
    } catch {
      return;
    }
  };

  const binderRef = useRef<StylusAccessoryBinder | null>(null);
  // Binder lifetime spans workspace re-renders: every mutable input flows
  // through `live` (or the stable proxies below), so squeeze anchor
  // tracking moves the existing palette via `updateAnchor` and never
  // remounts the binder/palette on unrelated renders. Only `services`
  // recreates the binder.: tools/toolbar liveness rides
  // resubscribing proxies (reconciled below); menu/composition ride
  // `updateLiveRegistries` (same effect). No polling, no second store.
  const livenessRef = useRef<{
    readonly tools: ResubscribingLiveness;
    readonly toolbar: ResubscribingLiveness;
  } | null>(null);
  if (livenessRef.current === null) {
    const describe = (error: unknown): string =>
      error instanceof Error && error.message !== ''
        ? error.message
        : String(error);
    livenessRef.current = {
      tools: createResubscribingLiveness(
        () => {
          try {
            return live.current.tools as {
              onDidChange?: (listener: () => void) => { dispose(): void };
            };
          } catch (error) {
            reportSqueezeDiagnostic(
              `squeeze tools liveness failed: ${describe(error)}`,
            );
            return null;
          }
        },
        (error) =>
          reportSqueezeDiagnostic(
            `squeeze tools liveness failed: ${describe(error)}`,
          ),
      ),
      toolbar: createResubscribingLiveness(
        () => {
          try {
            const direct = live.current.toolbarRegistry as
              | {
                  onDidChange?: (
                    listener: () => void,
                  ) => { dispose(): void };
                }
              | null
              | undefined;
            if (typeof direct?.onDidChange === 'function') return direct;
            return (
              live.current.services.try(documentToolbarRegistryToken) ?? null
            );
          } catch (error) {
            reportSqueezeDiagnostic(
              `squeeze toolbar liveness failed: ${describe(error)}`,
            );
            return null;
          }
        },
        (error) =>
          reportSqueezeDiagnostic(
            `squeeze toolbar liveness failed: ${describe(error)}`,
          ),
      ),
    };
  }
  const stablePorts = useRef<{
    readonly tools: StylusAccessoryToolsPort & StylusAccessoryCommandsPort;
    readonly toolbarRegistry: Pick<
      DocumentToolbarRegistry,
      'entries'
    > &
      Partial<Pick<DocumentToolbarRegistry, 'onDidChange'>>;
  } | null>(null);
  if (stablePorts.current === null) {
    stablePorts.current = createStylusAccessoryStablePorts({
      live: () => live.current,
      toolsLiveness: (livenessRef.current as {
        tools: ResubscribingLiveness;
        toolbar: ResubscribingLiveness;
      }).tools,
      toolbarLiveness: (livenessRef.current as {
        tools: ResubscribingLiveness;
        toolbar: ResubscribingLiveness;
      }).toolbar,
      report: (message) => reportSqueezeDiagnostic(message),
    });
  }
  useEffect(() => {
    const current = live.current;
    const service = current.services.try(stylusToken);
    if (service === undefined) return;
    const ports = stablePorts.current;
    if (ports === null) return;
    const settings = current.services.try(settingsToken);
    const slots = new ToolbarCustomizationStore(settings === undefined ? {} : { settings });
    const binder = new StylusAccessoryBinder({
      service,
      slots,
      menuRegistry: current.services.try(stylusMenuRegistryToken) ?? null,
      toolbarComposition: current.services.try(toolbarCompositionToken) ?? null,
      toolbarRegistry: ports.toolbarRegistry,
      tools: ports.tools,
      commands: ports.tools,
      focusedPane: () => live.current.focusedPane,
      menuContext: () => live.current.menuContext,
      showMenu: (entries, anchor) => showContextMenu(entries, anchor),
      menuAnchor: defaultStylusMenuAnchor,
      lastPenAnchor: () => penAnchor.current,
      surfaceCenter: defaultSurfaceCenter,
      diagnostics: (message) => reportSqueezeDiagnostic(message),
      showPalette: (
        model: StylusPaletteModel,
        anchor: StylusAccessoryMenuAnchor,
      ) => {
        // Repairs 4+5 live model: callbacks must route through the latest
        // presented model, not the opening closure — otherwise tool/color/
        // style/favorite/plugin selections after an in-place push would
        // execute via stale ownership. `currentModel` tracks every
        // `updateModel` push; anchor-following is preserved because the
        // handle identity never changes.
        let currentModel = model;
        // refresh sync for sync commits, then again after Promise
        // resolution for async commits (never just queueMicrotask alone).
        // One store, no per-frame poll: the second refresh runs only when
        // the execute returned a Promise.
        const refreshAfterExecute = (result: unknown): void => {
          try {
            binderRef.current?.refreshSqueezePalette();
          } catch {
            // Refresh must never break selection routing.
          }
          if (result instanceof Promise) {
            result.then(
              () => {
                try {
                  binderRef.current?.refreshSqueezePalette();
                } catch {
                  // Refresh must never break selection routing.
                }
              },
              () => undefined,
            );
          } else {
            queueMicrotask(() => {
              try {
                binderRef.current?.refreshSqueezePalette();
              } catch {
                // Refresh must never break selection routing.
              }
            });
          }
        };
        const refreshLive = (): void => {
          // Non-executing actions (menu entries already ran via entry.run):
          // sync + microtask reconcile without a second store.
          try {
            binderRef.current?.refreshSqueezePalette();
          } catch {
            // Refresh must never break selection routing.
          }
          queueMicrotask(() => {
            try {
              binderRef.current?.refreshSqueezePalette();
            } catch {
              // Refresh must never break selection routing.
            }
          });
        };
        const handle = showStylusPalette(model, anchor, {
          onSelectTool: (id) => {
            const result = routeSqueezeTool(currentModel, id);
            refreshAfterExecute(result);
          },
          onSelectColor: (id, value) => {
            const result = routeSqueezeTool(currentModel, id, value);
            refreshAfterExecute(result);
          },
          onSelectWidth: (id, value) => {
            const result = routeSqueezeTool(currentModel, id, value);
            refreshAfterExecute(result);
          },
          onSelectStyle: (id, value) => {
            const result = routeSqueezeTool(currentModel, id, value);
            refreshAfterExecute(result);
          },
          onSelectEraserSize: (id, value) => {
            const result = routeSqueezeTool(currentModel, id, value);
            refreshAfterExecute(result);
          },
          onUndo: () => {
            const pane = live.current.focusedPane;
            let result: unknown;
            if (pane !== null) {
              try {
                result = live.current.tools.execEditorCommand('undo', pane);
              } catch {
                result = undefined;
              }
            }
            refreshAfterExecute(result);
          },
          onRedo: () => {
            const pane = live.current.focusedPane;
            let result: unknown;
            if (pane !== null) {
              try {
                result = live.current.tools.execEditorCommand('redo', pane);
              } catch {
                result = undefined;
              }
            }
            refreshAfterExecute(result);
          },
          onSelectMenuEntry: () => {
            // `entry.run()` already executed in the overlay; reconcile any
            // plugin state change in place (lifecycle A) or close when the
            // commit removes the model (lifecycle B via refresh stale path).
            refreshLive();
          },
          onClose: () => {
            // Outside-dismissal reconcile: the overlay closed
            // itself (outside pointer DOWN, Escape). Drop the stale handle
            // in the binder so the next squeeze `began` opens fresh.
            // Reconcile must never break selection routing.
            try {
              binderRef.current?.handlePaletteClosed();
            } catch {
              // Reconcile must never break selection routing.
            }
          },
          onError: (message) => reportSqueezeDiagnostic(message),
        });
        const forwardedUpdate = handle.updateModel?.bind(handle);
        if (typeof forwardedUpdate === 'function') {
          handle.updateModel = (next: StylusPaletteModel): void => {
            currentModel = next;
            forwardedUpdate(next);
          };
        }
        return handle;
      },
    });
    binderRef.current = binder;
    const slotSubscription = slots.onChange(() => binder.refreshSqueezePalette());
    return () => {
      binderRef.current = null;
      slotSubscription.dispose();
      slots.dispose();
      binder.dispose();
    };
    // `services` only: tools/registry/focus flow via `live` + stable
    // proxies so re-renders never remount the binder mid-squeeze.
  }, [services]);

  // re-establish liveness when live sources swap without services
  // identity change (provider replacement). Stable tools/toolbar proxies
  // re-subscribe internally; service-resolved menu/composition instances
  // reconcile via `updateLiveRegistries`. All preserve the open palette
  // (no binder/palette remount, no polling, no second store). Runs after
  // every render — each reconcile is an idempotent identity check that
  // no-ops when unchanged (exactly-once preserved, no leak).
  useEffect(() => {
    try {
      livenessRef.current?.tools.reconcile();
    } catch {
      // Reconcile must never break rendering.
    }
    try {
      livenessRef.current?.toolbar.reconcile();
    } catch {
      // Reconcile must never break rendering.
    }
    try {
      const current = live.current;
      binderRef.current?.updateLiveRegistries({
        menuRegistry: current.services.try(stylusMenuRegistryToken) ?? null,
        toolbarComposition:
          current.services.try(toolbarCompositionToken) ?? null,
      });
    } catch {
      // Reconcile must never break rendering.
    }
  });

  // Pane/document changes close a squeeze-owned palette.
  const focusedPane = input.focusedPane;
  const menuContext = input.menuContext;
  useEffect(() => {
    binderRef.current?.handlePaneChanged();
  }, [focusedPane, menuContext]);
}
