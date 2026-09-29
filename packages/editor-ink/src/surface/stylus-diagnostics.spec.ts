import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLUS_CAPABILITIES } from '@froglight/foundation';
import {
  RecentStylusActions,
  collectStylusDiagnostics,
} from './stylus-diagnostics.js';

describe('collectStylusDiagnostics', () => {
  it('merges pointer fields with native capability/action state', () => {
    const snapshot = collectStylusDiagnostics(
      {
        pointerType: 'pen',
        button: 2,
        buttons: 4,
        pressure: 0.5,
        tiltX: 30,
        tiltY: -20,
        twist: 90,
        coalescedCount: 3,
        predictedCount: 1,
      },
      { ...DEFAULT_STYLUS_CAPABILITIES, available: true, barrelButton: true },
      [{ type: 'doubleTap' }],
    );
    expect(snapshot.pointerType).toBe('pen');
    expect(snapshot.button).toBe(2);
    expect(snapshot.pressure).toBe(0.5);
    expect(snapshot.tiltX).toBe(30);
    expect(snapshot.tiltY).toBe(-20);
    expect(snapshot.coalescedCount).toBe(3);
    expect(snapshot.native.capabilities.available).toBe(true);
    expect(snapshot.native.recentActions).toEqual([{ type: 'doubleTap' }]);
  });

  it('normalizes missing and non-finite fields to null/unknown', () => {
    const snapshot = collectStylusDiagnostics(
      { pressure: Number.NaN },
      DEFAULT_STYLUS_CAPABILITIES,
      [],
    );
    expect(snapshot.pointerType).toBe('unknown');
    expect(snapshot.pressure).toBeNull();
    expect(snapshot.button).toBeNull();
    expect(snapshot.native.recentActions).toEqual([]);
  });
});

describe('RecentStylusActions', () => {
  it('keeps the most recent actions within the limit', () => {
    const recent = new RecentStylusActions(2);
    recent.push({ type: 'doubleTap' });
    recent.push({ type: 'squeeze', phase: 'began' });
    recent.push({ type: 'eraser', active: true });
    expect(recent.list()).toEqual([
      { type: 'squeeze', phase: 'began' },
      { type: 'eraser', active: true },
    ]);
  });

  it('preserves preferredAction and anchors for accessory diagnostics', () => {
    const snapshot = collectStylusDiagnostics(
      { pointerType: 'pen' },
      DEFAULT_STYLUS_CAPABILITIES,
      [
        {
          type: 'doubleTap',
          preferredAction: 'switchEraser',
          anchor: { x: 512, y: 384 },
        },
        {
          type: 'squeeze',
          phase: 'began',
          preferredAction: 'showContextualPalette',
          anchor: { x: 620, y: 410 },
        },
      ],
    );
    expect(snapshot.native.recentActions).toEqual([
      {
        type: 'doubleTap',
        preferredAction: 'switchEraser',
        anchor: { x: 512, y: 384 },
      },
      {
        type: 'squeeze',
        phase: 'began',
        preferredAction: 'showContextualPalette',
        anchor: { x: 620, y: 410 },
      },
    ]);
  });
});
