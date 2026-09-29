// @vitest-environment jsdom
/**
 * Integration test for the `useStylusAccessory` hook.
 *
 * Mounts the real `useStylusAccessory` hook with a real
 * `InMemoryStylusService` and the real `showStylusPalette` overlay (jsdom),
 * then drives full squeeze gestures and asserts the integrated loop:
 *
 * - Case C: squeeze opens near the tip; outside pointer DOWN closes the
 *   real overlay AND reconciles the binder (`handlePaletteClosed` is
 *   called); the next squeeze opens fresh.
 * - Case D: an inside tool click executes through the owned port, keeps
 *   the palette open, and refreshes the pressed state in place.
 * - Case E: Escape closes and reconciles.
 * - Case F: a pane change closes via `handlePaneChanged`.
 * - Unmount disposes the binder (palette torn down, no leaks).
 *
 * Stable seams: no binder remount across re-renders (stable
 * proxies + `live` ref), liveness reconcile untouched.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryStylusService,
  stylusToken,
  type DocumentToolSnapshot,
} from '@froglight/foundation';
import { StylusAccessoryBinder } from '../../../stylus-accessory.js';
import type { UiServiceLookup } from '../../../workbench.js';
import type { StylusMenuContext } from '../../../stylus-menu-registry.js';
import { disposePaletteHost } from '../../StylusPaletteOverlay.jsx';
import { useStylusAccessory } from './useStylusAccessory.js';
import { useState } from 'react';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function surfaceButton(
  id: string,
  extra: Record<string, unknown> = {},
): DocumentToolSnapshot['controls'][number] {
  const toolRole = id.endsWith('.pen')
    ? 'pen'
    : id.endsWith('.highlighter')
      ? 'highlighter'
      : id.endsWith('.eraser')
        ? 'eraser'
        : undefined;
  const semanticRole = id.endsWith('.pen')
    ? 'surface.pen.ball'
    : id.endsWith('.highlighter')
      ? 'surface.highlighter'
      : id.endsWith('.eraser')
        ? 'surface.erase'
        : undefined;
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    role: 'surface-tool',
    ...(toolRole !== undefined ? { toolRole } : {}),
    ...(semanticRole !== undefined ? { semanticRole } : {}),
    ...extra,
  } as DocumentToolSnapshot['controls'][number];
}

function surfaceSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      surfaceButton('ink.tool.froglight.ink.pen', { active: true }),
      surfaceButton('ink.tool.froglight.ink.highlighter'),
      surfaceButton('ink.tool.froglight.ink.eraser'),
      {
        kind: 'color',
        id: 'ink.color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0'],
        semanticRole: 'surface.style.color',
      },
      {
        kind: 'choice',
        id: 'ink.width',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [{ value: '3.5', label: '3.5 px' }],
        semanticRole: 'surface.style.width',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

interface Mounted {
  service: InMemoryStylusService;
  executed: Array<{ pane: string; id: string; value?: string }>;
  setPane(pane: string | null): void;
  unmount(): void;
}

function mountHook(): Mounted {
  const service = new InMemoryStylusService();
  let snapshot: DocumentToolSnapshot = surfaceSnapshot();
  const executed: Mounted['executed'] = [];
  const services = {
    try: (token: unknown) => (token === stylusToken ? service : undefined),
  } as unknown as UiServiceLookup;
  const tools = {
    editorToolSnapshot: () => snapshot,
    executeEditorTool: (pane: string, id: string, value?: string) => {
      executed.push({ pane, id, value });
      try {
        if (
          snapshot.controls.some(
            (control) => control.kind === 'button' && control.id === id,
          )
        ) {
          snapshot = {
            ...snapshot,
            controls: snapshot.controls.map((control) =>
              control.kind === 'button' && control.role === 'surface-tool'
                ? { ...control, active: control.id === id }
                : control,
            ),
          } as DocumentToolSnapshot;
        }
      } catch {
        // Commit simulation never breaks execution recording.
      }
      return true;
    },
    canExecEditorCommand: () => false,
    execEditorCommand: () => false,
  };
  const menuContext: StylusMenuContext = {
    pane: 'main',
    documentId: 'doc-1',
    kindId: 'froglight.ink',
  };
  let setPaneRef: ((pane: string | null) => void) | null = null;
  function Probe(initial: { pane: string | null }): React.ReactElement {
    const [pane, setPane] = useState(initial.pane);
    setPaneRef = setPane;
    useStylusAccessory({
      services,
      tools,
      focusedPane: pane,
      menuContext,
    });
    return (null as unknown as React.ReactElement);
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  act(() => {
    root.render(<Probe pane="main" />);
  });
  return {
    service,
    executed,
    setPane(pane: string | null): void {
      act(() => {
        setPaneRef?.(pane);
      });
    },
    unmount(): void {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function squeeze(
  service: InMemoryStylusService,
  payload: Record<string, unknown>,
): void {
  service.handleNativeEvent('action', { type: 'squeeze', ...payload });
}

function dialog(): HTMLElement | null {
  return document.querySelector(
    '[role="dialog"][aria-label="Pencil palette"]',
  ) as HTMLElement | null;
}

function backdrop(): HTMLElement | null {
  return document.querySelector(
    'div[class*="backdrop"]',
  ) as HTMLElement | null;
}

afterEach(() => {
  disposePaletteHost();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('useStylusAccessory close lifecycle (H4 integration)', () => {
  it('Case C: squeeze opens; outside DOWN closes the overlay and reconciles the binder; next squeeze opens fresh', () => {
    const reconciled = vi.spyOn(
      StylusAccessoryBinder.prototype,
      'handlePaletteClosed',
    );
    const m = mountHook();
    try {
      squeeze(m.service, { phase: 'began', anchor: { x: 300, y: 300 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).not.toBeNull();
      act(() => {
        (backdrop() as HTMLElement).dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
        );
      });
      expect(dialog()).toBeNull();
      expect(backdrop()).toBeNull();
      expect(reconciled).toHaveBeenCalled();
      // Next squeeze opens fresh (stale handle dropped, session idle).
      squeeze(m.service, { phase: 'began', anchor: { x: 80, y: 80 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).not.toBeNull();
    } finally {
      m.unmount();
    }
  });

  it('Case D: inside tool click executes, stays open, and refreshes pressed state in place', async () => {
    const m = mountHook();
    try {
      squeeze(m.service, { phase: 'began', anchor: { x: 300, y: 300 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).not.toBeNull();
      const before = dialog();
      const eraserId = 'ink.tool.froglight.ink.eraser';
      await act(async () => {
        (
          document.querySelector(
            `button[aria-label="${eraserId}"]`,
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(
        m.executed.filter((call) => call.id === 'ink.tool.froglight.ink.eraser'),
      ).toHaveLength(1);
      // Stays open (no outside-close, no toggle-close) without remounting.
      expect(dialog()).toBe(before);
      expect(
        document
          .querySelector(`button[aria-label="${eraserId}"]`)
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
    } finally {
      m.unmount();
    }
  });

  it('Case E: Escape closes the overlay and reconciles the binder', () => {
    const reconciled = vi.spyOn(
      StylusAccessoryBinder.prototype,
      'handlePaletteClosed',
    );
    const m = mountHook();
    try {
      squeeze(m.service, { phase: 'began', anchor: { x: 300, y: 300 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).not.toBeNull();
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(dialog()).toBeNull();
      expect(reconciled).toHaveBeenCalled();
    } finally {
      m.unmount();
    }
  });

  it('Case F: pane change closes the open palette', () => {
    const m = mountHook();
    try {
      squeeze(m.service, { phase: 'began', anchor: { x: 300, y: 300 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).not.toBeNull();
      m.setPane('second');
      expect(dialog()).toBeNull();
    } finally {
      m.unmount();
    }
  });

  it('Case B (integration): squeeze-while-open closes exactly once and never reopens on its tail', () => {
    const m = mountHook();
    try {
      squeeze(m.service, { phase: 'began', anchor: { x: 300, y: 300 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).not.toBeNull();
      squeeze(m.service, { phase: 'began', anchor: { x: 310, y: 310 } });
      expect(dialog()).toBeNull();
      squeeze(m.service, { phase: 'changed', anchor: { x: 320, y: 320 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).toBeNull();
      // Next squeeze opens fresh.
      squeeze(m.service, { phase: 'began', anchor: { x: 90, y: 90 } });
      squeeze(m.service, { phase: 'ended' });
      expect(dialog()).not.toBeNull();
    } finally {
      m.unmount();
    }
  });

  it('unmount disposes the binder and tears the palette down', () => {
    const m = mountHook();
    squeeze(m.service, { phase: 'began', anchor: { x: 300, y: 300 } });
    squeeze(m.service, { phase: 'ended' });
    expect(dialog()).not.toBeNull();
    m.unmount();
    expect(dialog()).toBeNull();
  });
});
