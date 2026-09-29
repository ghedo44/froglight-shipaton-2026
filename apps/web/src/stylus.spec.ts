import { describe, expect, it } from 'vitest';
import { stylusToken } from '@froglight/foundation';
import { Runtime, definePlugin } from '@froglight/runtime';
import { createWebStylus, probeWebStylusCapabilities } from './stylus.js';

describe('web stylus capability probe', () => {
  it('reports unavailable without a window probe (headless)', () => {
    expect(probeWebStylusCapabilities()).toMatchObject({
      available: false,
      pressure: false,
      squeeze: false,
    });
    expect(probeWebStylusCapabilities(null)).toMatchObject({
      available: false,
    });
  });

  it('reports pen-class input when PointerEvent + coalesced events exist', () => {
    const capabilities = probeWebStylusCapabilities({
      pointerEvent: function PointerEvent() {
        return undefined;
      },
      getCoalescedEvents: function getCoalescedEvents() {
        return [];
      },
      maxTouchPoints: 5,
    });
    expect(capabilities).toMatchObject({
      available: true,
      pressure: true,
      tilt: true,
      twist: true,
      hover: true,
      eraser: true,
      barrelButton: true,
      doubleTap: false,
      squeeze: false,
    });
  });

  it('does not require touch points: tablets report maxTouchPoints 0', () => {
    expect(
      probeWebStylusCapabilities({
        pointerEvent: function PointerEvent() {
          return undefined;
        },
        maxTouchPoints: 0,
      }),
    ).toMatchObject({ available: true, pressure: true, hover: true });
  });

  it('never claims double-tap or squeeze on web (no web API exists)', () => {
    expect(
      probeWebStylusCapabilities({
        pointerEvent: function PointerEvent() {
          return undefined;
        },
        getCoalescedEvents: function getCoalescedEvents() {
          return [];
        },
        maxTouchPoints: 5,
      }),
    ).toMatchObject({ doubleTap: false, squeeze: false });
  });

  it('provides the token binding through the runtime lifecycle', async () => {
    const runtime = new Runtime();
    const host = createWebStylus({
      pointerEvent: function PointerEvent() {
        return undefined;
      },
      getCoalescedEvents: function getCoalescedEvents() {
        return [];
      },
      maxTouchPoints: 1,
    });
    await runtime.registerSlot({
      id: 'stylus',
      plugin: host.definition,
    });
    let seen = false;
    await runtime.registerSlot({
      id: 'stylus-consumer',
      plugin: definePlugin({
        id: 'froglight.stylus.web-consumer',
        requirements: { requires: [stylusToken] },
        activate: (ctx) => {
          seen = ctx.require(stylusToken).capabilities().available;
        },
      }),
    });
    expect(seen).toBe(true);
    await runtime.dispose();
  });
});
