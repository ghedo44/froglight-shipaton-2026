/**
 * Slices 1–10 production consolidation: regression coverage for the repair
 * items closed in this pass. Headless, deterministic, no wall-clock
 * assertions — operation counters and structural invariants only.
 */
import { describe, expect, it } from 'vitest';
import { compileInkStroke } from './ink/geometry.js';
import { LiveInkStrokeCompiler } from './ink/live-compiler.js';
import { InkPresetStore } from './ink/presets.js';
import { InMemorySettingsService } from '../settings.js';
import { PersistentSettingsService } from '../settings-persistent.js';
import {
  distanceToRulerSegment,
  distanceToRuler,
  rulerSnapThresholdSurface,
  shouldSnapToRuler,
  RULER_SNAP_THRESHOLD,
} from './ruler.js';
import type { InkSample } from './model.js';
import { resolveBrushSpec } from './ink/brush.js';

const FLAT_BRUSH = () =>
  resolveBrushSpec({
    stabilization: 0,
    streamline: 0,
    taperStart: 0,
    taperEnd: 0,
  });
const BALL_BRUSH = () => resolveBrushSpec({});

function sample(
  x: number,
  y: number,
  extra: Partial<InkSample> = {},
): InkSample {
  return { x, y, ...extra };
}

describe('consolidation: geometry cleanup', () => {
  it('preserves tilt-only changes at identical coords', () => {
    const geometry = compileInkStroke(
      [
        sample(0, 0, { pressure: 0.5, tilt: { x: 0.1, y: 0 } }),
        sample(0, 0, { pressure: 0.5, tilt: { x: 0.3, y: 0 } }),
        sample(20, 0, { pressure: 0.5 }),
      ],
      BALL_BRUSH(),
      { minDistance: 0.5, spacing: 100 },
    );
    // Both tilted samples survive (exact-duplicate compares all axes).
    expect(geometry.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('does not pinch the middle when tapers overlap', () => {
    const line = [sample(0, 0), sample(50, 0), sample(100, 0)];
    const brush = { ...BALL_BRUSH(), taperStart: 1, taperEnd: 1 };
    const geometry = compileInkStroke(line, brush, { spacing: 100 });
    const widths = geometry.nodes.map((n) => n.width);
    const mid = widths[Math.floor(widths.length / 2)]!;
    const max = Math.max(...widths);
    // Normalized zones meet at most: middle holds near-full width.
    expect(mid).toBeGreaterThan(max * 0.9);
  });
});

describe('consolidation: live compiler', () => {
  it('carries dt through to finish for velocity brushes', () => {
    const brush = { ...BALL_BRUSH(), velocityPressure: true } as ReturnType<
      typeof BALL_BRUSH
    >;
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin(sample(0, 0, { dt: 0 }), brush);
    compiler.append([sample(10, 0, { dt: 50 }), sample(20, 0, { dt: 100 })]);
    const committed = compiler.finish();
    expect(committed.nodes.length).toBeGreaterThan(0);
    // finish() matches a clean full compile over timed samples.
    const clean = compileInkStroke(
      [
        sample(0, 0, { dt: 0 }),
        sample(10, 0, { dt: 50 }),
        sample(20, 0, { dt: 100 }),
      ],
      brush,
    );
    expect(committed.polygon.length).toEqual(clean.polygon.length);
  });

  it('publishes bounds containing the full polygon including caps', () => {
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin(sample(0, 0), BALL_BRUSH());
    compiler.append([sample(10, 0), sample(10, 20)]);
    const live = compiler.liveOutline();
    expect(live.polygon.length).toBeGreaterThanOrEqual(8);
    for (const p of live.polygon) {
      expect(p.x).toBeGreaterThanOrEqual(live.bounds.x - 1e-9);
      expect(p.x).toBeLessThanOrEqual(live.bounds.x + live.bounds.width + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(live.bounds.y - 1e-9);
      expect(p.y).toBeLessThanOrEqual(
        live.bounds.y + live.bounds.height + 1e-9,
      );
    }
  });
});

describe('consolidation: preset merge', () => {
  it('merges single-field brush patches without dropping prior tuning', () => {
    const store = new InkPresetStore();
    store.setTool('pen', { brush: { stabilization: 0.8 } as never });
    store.setTool('pen', { brush: { streamline: 0.3 } as never });
    const preset = store.getTool('pen');
    expect(preset.brush).toMatchObject({ stabilization: 0.8, streamline: 0.3 });
  });

  it('replace-restore clears absent brush tuning', () => {
    const store = new InkPresetStore();
    store.setTool('pen', { brush: { stabilization: 0.8 } as never });
    store.restore({
      pen: {},
      fountain: {},
      brush: {},
      pencil: {},
      highlighter: {},
      eraser: {},
      lasso: {},
    });
    expect(store.getTool('pen').brush).toBeUndefined();
  });
});

describe('consolidation: persistent settings', () => {
  function memoryStorage(): {
    store: Map<string, string>;
    bridge: {
      getItem(k: string): string | null;
      setItem(k: string, v: string): void;
      removeItem(k: string): void;
    };
  } {
    const store = new Map<string, string>();
    return {
      store,
      bridge: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    };
  }

  it('survives destroy/recreate through the injected bridge (restart)', () => {
    const { bridge } = memoryStorage();
    const first = new PersistentSettingsService({ storage: bridge });
    first.set('ink.preset.pen.color', '#ff0000');
    first.set('ink.preset.pen.size', 4);
    const second = new PersistentSettingsService({ storage: bridge });
    expect(second.get('ink.preset.pen.color')).toBe('#ff0000');
    expect(second.get('ink.preset.pen.size')).toBe(4);
  });

  it('degrades corrupt envelopes to defaults without throwing', () => {
    const { bridge, store } = memoryStorage();
    store.set('froglight.settings', 'not-json{{{');
    expect(
      () => new PersistentSettingsService({ storage: bridge }),
    ).not.toThrow();
    const service = new PersistentSettingsService({ storage: bridge });
    expect(service.get('ink.preset.pen.color')).toBeUndefined();
  });

  it('shares presets across editors through one service', () => {
    const settings = new InMemorySettingsService();
    const a = new InkPresetStore({ settings });
    const b = new InkPresetStore({ settings });
    a.setTool('pen', { color: '#00ff00' });
    expect(b.getTool('pen').color).toBe('#00ff00');
  });
});

describe('consolidation: ruler finite segment', () => {
  const ruler = { visible: true, x: 0, y: 0, angle: 0, length: 100 };

  it('latches near the visible segment but not far beyond endpoints', () => {
    expect(shouldSnapToRuler({ x: 0, y: 5 }, ruler, RULER_SNAP_THRESHOLD)).toBe(
      true,
    );
    // Far beyond the +x endpoint: infinite-line distance is 5 (would snap),
    // segment distance is ~150 (must not snap).
    expect(distanceToRuler({ x: 200, y: 5 }, ruler)).toBeCloseTo(5, 9);
    expect(distanceToRulerSegment({ x: 200, y: 5 }, ruler)).toBeGreaterThan(
      100,
    );
    expect(
      shouldSnapToRuler({ x: 200, y: 5 }, ruler, RULER_SNAP_THRESHOLD),
    ).toBe(false);
  });

  it('holds screen-constant tolerance across zoom', () => {
    expect(rulerSnapThresholdSurface(1)).toBeCloseTo(12, 9);
    expect(rulerSnapThresholdSurface(2)).toBeCloseTo(6, 9);
    expect(rulerSnapThresholdSurface(0.5)).toBeCloseTo(24, 9);
  });
});

describe('consolidation: flat brush fixture', () => {
  it('exposes a deterministic flat nib for tests', () => {
    expect(FLAT_BRUSH().stabilization).toBe(0);
  });
});
