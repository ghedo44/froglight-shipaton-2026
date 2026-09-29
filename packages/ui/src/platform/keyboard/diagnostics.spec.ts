// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectKeyboardDiagnostics } from './diagnostics.js';
import { VISUAL_VIEWPORT_PAN_VAR } from './ios-viewport-pan-guard.js';

describe('collectKeyboardDiagnostics', () => {
  it('reports inset, viewport origin, scroll, and compensation', () => {
    document.documentElement.style.setProperty(VISUAL_VIEWPORT_PAN_VAR, '24px');
    document.documentElement.style.setProperty('--fl-keyboard-inset-height', '300px');
    const snapshot = collectKeyboardDiagnostics({
      doc: document,
      keyboardInset: 300,
      viewport: { pageTop: 84 },
      windowScrollY: 0,
    });
    expect(snapshot).toMatchObject({
      keyboardInset: 300,
      visualViewportPageTop: 84,
      windowScrollY: 0,
      compatibilityCompensation: 24,
      appliedInset: 300,
    });
    document.documentElement.style.removeProperty(VISUAL_VIEWPORT_PAN_VAR);
    document.documentElement.style.removeProperty('--fl-keyboard-inset-height');
  });

  it('reports measurement, reserved height, and editor viewport height', () => {
    const snapshot = collectKeyboardDiagnostics({
      doc: document,
      keyboardInset: 346,
      measurement: 'exact',
      reservedHeight: 320,
      appliedInset: 346,
      viewport: { pageTop: 84 },
      windowScrollY: 0,
      editorViewportHeight: 400,
    });
    expect(snapshot).toMatchObject({
      keyboardInset: 346,
      measurement: 'exact',
      reservedHeight: 320,
      appliedInset: 346,
      visualViewportPageTop: 84,
      editorViewportHeight: 400,
    });
  });
});
