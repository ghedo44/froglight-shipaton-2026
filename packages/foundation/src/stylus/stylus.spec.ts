/**
 * Stylus accessory capability conformance.
 *
 * Host- and framework-free: semantic accessory events only, never stroke
 * samples. Malformed native payloads are ignored; disposal follows the
 * runtime lifecycle invariant.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { stylusToken } from '../tokens.js';
import {
  DEFAULT_STYLUS_CAPABILITIES,
  DEFAULT_STYLUS_DEVICE_CAPABILITIES,
  STYLUS_NATIVE_EVENT_CHANNEL,
  type StylusAction,
  type StylusCapabilities,
} from './contract.js';
import { InMemoryStylusService } from './service.js';
import { createStylusHost } from './plugin.js';

const FULL_CAPABILITIES: StylusCapabilities = {
  available: true,
  pressure: true,
  tilt: true,
  twist: true,
  hover: true,
  eraser: true,
  barrelButton: true,
  doubleTap: true,
  squeeze: true,
};

describe('stylus service', () => {
  it('starts unavailable with no capabilities', () => {
    const service = new InMemoryStylusService();
    expect(service.capabilities()).toEqual(DEFAULT_STYLUS_CAPABILITIES);
  });

  it('applies well-formed capability reports and notifies subscribers', () => {
    const service = new InMemoryStylusService();
    const seen: StylusCapabilities[] = [];
    const dispose = service.onCapabilitiesChange((c) => seen.push(c));
    service.handleNativeEvent('capabilities', { ...FULL_CAPABILITIES });
    expect(service.capabilities()).toEqual(FULL_CAPABILITIES);
    expect(seen).toEqual([FULL_CAPABILITIES]);
    dispose();
    service.handleNativeEvent('capabilities', {
      ...DEFAULT_STYLUS_CAPABILITIES,
    });
    expect(seen).toHaveLength(1);
  });

  it('ignores malformed capability payloads', () => {
    const service = new InMemoryStylusService();
    service.handleNativeEvent('capabilities', { available: true });
    service.handleNativeEvent('capabilities', null);
    service.handleNativeEvent('capabilities', 'stylus');
    expect(service.capabilities()).toEqual(DEFAULT_STYLUS_CAPABILITIES);
  });

  it('dispatches semantic accessory actions and ignores malformed ones', () => {
    const service = new InMemoryStylusService();
    const seen: StylusAction[] = [];
    const dispose = service.onAction((a) => seen.push(a));
    service.handleNativeEvent('action', { type: 'doubleTap' });
    service.handleNativeEvent('action', { type: 'squeeze', phase: 'began' });
    service.handleNativeEvent('action', { type: 'squeeze' });
    service.handleNativeEvent('action', {
      type: 'squeeze',
      phase: 'cancelled',
    });
    service.handleNativeEvent('action', {
      type: 'primaryButton',
      pressed: true,
    });
    service.handleNativeEvent('action', {
      type: 'secondaryButton',
      pressed: false,
    });
    service.handleNativeEvent('action', { type: 'eraser', active: true });
    service.handleNativeEvent('action', { type: 'proximity', active: false });
    // Malformed reports never reach subscribers and never throw.
    service.handleNativeEvent('action', { type: 'squeeze', phase: 'nope' });
    service.handleNativeEvent('action', { type: 'primaryButton' });
    service.handleNativeEvent('action', { type: 'eraser', active: 'yes' });
    service.handleNativeEvent('action', { type: 'unknown-gesture' });
    service.handleNativeEvent('unknown-channel', { type: 'doubleTap' });
    expect(seen).toEqual([
      { type: 'doubleTap' },
      { type: 'squeeze', phase: 'began' },
      { type: 'squeeze' },
      { type: 'squeeze', phase: 'cancelled' },
      { type: 'primaryButton', pressed: true },
      { type: 'secondaryButton', pressed: false },
      { type: 'eraser', active: true },
      { type: 'proximity', active: false },
    ]);
    dispose();
  });

  it('preserves preferredAction and anchor on doubleTap and squeeze', () => {
    const service = new InMemoryStylusService();
    const seen: StylusAction[] = [];
    const dispose = service.onAction((a) => seen.push(a));
    service.handleNativeEvent('action', {
      type: 'doubleTap',
      preferredAction: 'switchEraser',
      anchor: { x: 512, y: 384 },
    });
    service.handleNativeEvent('action', {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'showContextualPalette',
      anchor: { x: 620, y: 410 },
    });
    service.handleNativeEvent('action', {
      type: 'squeeze',
      phase: 'changed',
      anchor: { x: 621, y: 411 },
    });
    expect(seen).toEqual([
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
      { type: 'squeeze', phase: 'changed', anchor: { x: 621, y: 411 } },
    ]);
    dispose();
  });

  it('accepts every preferred-action value and legacy payloads without them', () => {
    const service = new InMemoryStylusService();
    const seen: StylusAction[] = [];
    const dispose = service.onAction((a) => seen.push(a));
    const values = [
      'ignore',
      'switchEraser',
      'switchPrevious',
      'showColorPalette',
      'showInkAttributes',
      'showContextualPalette',
      'runSystemShortcut',
      'unknown',
    ] as const;
    for (const preferredAction of values) {
      service.handleNativeEvent('action', { type: 'doubleTap', preferredAction });
    }
    // Legacy payloads remain valid.
    service.handleNativeEvent('action', { type: 'doubleTap' });
    service.handleNativeEvent('action', { type: 'squeeze' });
    expect(seen).toHaveLength(values.length + 2);
    expect(seen[0]).toEqual({ type: 'doubleTap', preferredAction: 'ignore' });
    expect(seen[values.length]).toEqual({ type: 'doubleTap' });
    dispose();
  });

  it('maps unknown future preferred actions to unknown without dropping the event', () => {
    const service = new InMemoryStylusService();
    const seen: StylusAction[] = [];
    const dispose = service.onAction((a) => seen.push(a));
    service.handleNativeEvent('action', {
      type: 'doubleTap',
      preferredAction: 'futureAppleAction',
    });
    service.handleNativeEvent('action', {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'anotherFutureValue',
      anchor: { x: 1, y: 2 },
    });
    expect(seen).toEqual([
      { type: 'doubleTap', preferredAction: 'unknown' },
      {
        type: 'squeeze',
        phase: 'began',
        preferredAction: 'unknown',
        anchor: { x: 1, y: 2 },
      },
    ]);
    dispose();
  });

  it('discards only the anchor on malformed coordinates and never throws', () => {
    const service = new InMemoryStylusService();
    const seen: StylusAction[] = [];
    const dispose = service.onAction((a) => seen.push(a));
    const malformed: unknown[] = [
      { type: 'doubleTap', preferredAction: 'switchEraser', anchor: { x: NaN, y: 10 } },
      { type: 'doubleTap', anchor: { x: Infinity, y: 10 } },
      { type: 'doubleTap', anchor: { x: '512', y: 384 } },
      { type: 'doubleTap', anchor: { x: 1 } },
      { type: 'doubleTap', anchor: '512,384' },
      { type: 'doubleTap', anchor: null, preferredAction: 'ignore' },
      { type: 'squeeze', phase: 'began', anchor: { x: NaN, y: NaN } },
      { type: 'squeeze', phase: 'began', preferredAction: 42, anchor: { x: 1, y: 2 } },
    ];
    expect(() =>
      malformed.forEach((payload) => service.handleNativeEvent('action', payload)),
    ).not.toThrow();
    // Valid tap + invalid anchor still delivers the tap.
    expect(seen[0]).toEqual({ type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(seen[1]).toEqual({ type: 'doubleTap' });
    expect(seen[2]).toEqual({ type: 'doubleTap' });
    expect(seen[3]).toEqual({ type: 'doubleTap' });
    expect(seen[4]).toEqual({ type: 'doubleTap' });
    expect(seen[5]).toEqual({ type: 'doubleTap', preferredAction: 'ignore' });
    expect(seen[6]).toEqual({ type: 'squeeze', phase: 'began' });
    // Non-string preferredAction degrades to unknown, anchor still kept.
    expect(seen[7]).toEqual({
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'unknown',
      anchor: { x: 1, y: 2 },
    });
    dispose();
  });

  it('exposes a stable native event channel name', () => {
    expect(STYLUS_NATIVE_EVENT_CHANNEL).toBe('__FROGLIGHT_STYLUS_EVENT__');
  });

  it('keeps capabilities as retrievable state seeded after late forwarder install', () => {
    // Regression: iOS emitted capabilities during plugin load, before JS
    // installed `__FROGLIGHT_STYLUS_EVENT__`, losing the report forever.
    // Capabilities are state: a later `get_capabilities` query seeds them.
    const service = new InMemoryStylusService();
    expect(service.capabilities()).toEqual(DEFAULT_STYLUS_CAPABILITIES);
    service.handleNativeEvent('capabilities', { ...FULL_CAPABILITIES });
    expect(service.capabilities()).toEqual(FULL_CAPABILITIES);
  });

  it('tracks observed device capabilities separately from host support', () => {
    const service = new InMemoryStylusService({ ...FULL_CAPABILITIES });
    // Host support must not imply attached hardware.
    expect(service.deviceCapabilities()).toEqual(
      DEFAULT_STYLUS_DEVICE_CAPABILITIES,
    );
    service.noteObservedPen({ pointerType: 'pen', pressure: 0.7 });
    expect(service.deviceCapabilities()).toMatchObject({
      connected: true,
      pressure: true,
      twist: 'unknown',
    });
    // Non-pen samples never promote stylus flags.
    service.noteObservedPen({ pointerType: 'mouse', pressure: 0.5 });
    expect(service.deviceCapabilities().twist).toBe('unknown');
    // Accessory actions promote hardware evidence monotonically.
    service.handleNativeEvent('action', { type: 'squeeze', phase: 'began' });
    expect(service.deviceCapabilities().squeeze).toBe(true);
    service.handleNativeEvent('action', { type: 'doubleTap' });
    expect(service.deviceCapabilities().doubleTap).toBe(true);
  });
});

describe('stylus runtime binding', () => {
  it('provides one binding, withdraws on dispose, restores on reactivate', async () => {
    const runtime = new Runtime();
    const host = createStylusHost();
    const slot = await runtime.registerSlot({
      id: 'stylus',
      plugin: host.definition,
    });
    expect(slot.id).toBe('stylus');

    // The binding is observable through a dependent fiber.
    let observed = 0;
    const probe = await runtime.registerSlot({
      id: 'stylus-probe',
      plugin: definePlugin({
        id: 'froglight.stylus.probe',
        requirements: { requires: [stylusToken] },
        activate: (ctx) => {
          ctx.require(stylusToken);
          observed += 1;
          ctx.effect(() => () => {
            observed -= 1;
          });
        },
      }),
    });
    expect(observed).toBe(1);

    await runtime.removeSlot(probe.id);
    expect(observed).toBe(0);

    await runtime.removeSlot(slot.id);
    // Reactivate → exactly one binding again, same host service retained.
    await runtime.registerSlot({
      id: 'stylus',
      plugin: host.definition,
    });
    let observedAgain = 0;
    await runtime.registerSlot({
      id: 'stylus-probe',
      plugin: definePlugin({
        id: 'froglight.stylus.probe',
        requirements: { requires: [stylusToken] },
        activate: (ctx) => {
          const service = ctx.require(stylusToken);
          if (service === host.service) observedAgain += 1;
        },
      }),
    });
    expect(observedAgain).toBe(1);

    await runtime.dispose();
  });

  it('keeps observed capabilities across reactivations (host-owned state)', async () => {
    const runtime = new Runtime();
    const host = createStylusHost();
    host.service.handleNativeEvent('capabilities', { ...FULL_CAPABILITIES });
    await runtime.registerSlot({
      id: 'stylus',
      plugin: host.definition,
    });
    await runtime.removeSlot('stylus');
    await runtime.registerSlot({
      id: 'stylus',
      plugin: host.definition,
    });
    let observed: StylusCapabilities | null = null;
    await runtime.registerSlot({
      id: 'stylus-probe',
      plugin: definePlugin({
        id: 'froglight.stylus.probe2',
        requirements: { requires: [stylusToken] },
        activate: (ctx) => {
          observed = ctx.require(stylusToken).capabilities();
        },
      }),
    });
    expect(observed).toEqual(FULL_CAPABILITIES);
    await runtime.dispose();
  });
});
