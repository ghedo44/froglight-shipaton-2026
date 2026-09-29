// @vitest-environment jsdom
/**
 * Brush preview renderer.
 *
 * Deterministic inputs, semantic assertions, no pixel snapshots:
 * previews distinguish the five families plus widths/colors/pressure/tip,
 * memoize by a stable cache key, and invalidate only on visually relevant
 * params (stabilization/streamline never invalidate).
 */

import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';
import {
  BrushPreview,
  brushPreviewCacheKey,
  clearBrushPreviewCacheForTests,
  getBrushPreviewGeometry,
  type BrushPreviewInput,
} from './brush-preview.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function input(
  toolKind: string,
  preset: BrushPreviewInput['preset'] = {},
): BrushPreviewInput {
  return { toolKind, preset };
}

describe('brushPreviewCacheKey', () => {
  it('distinguishes all five families', () => {
    clearBrushPreviewCacheForTests();
    const keys = new Set(
      ['pen', 'fountain', 'brush', 'pencil', 'highlighter'].map((toolKind) =>
        brushPreviewCacheKey(input(toolKind)),
      ),
    );
    expect(keys.size).toBe(5);
  });

  it('changes on width, color, pressure, and tip — not on smoothing', () => {
    const base = input('fountain', { color: '#123456', size: 3.5 });
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(input('fountain', { color: '#654321', size: 3.5 })),
    );
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(input('fountain', { color: '#123456', size: 6 })),
    );
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(
        input('fountain', {
          color: '#123456',
          size: 3.5,
          brush: { pressure: { enabled: false } },
        }),
      ),
    );
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(
        input('fountain', {
          color: '#123456',
          size: 3.5,
          brush: { tip: { shape: 'flat', aspect: 0.3 } },
        }),
      ),
    );
    // Smoothing is not visually relevant for a static ribbon.
    expect(brushPreviewCacheKey(base)).toBe(
      brushPreviewCacheKey(
        input('fountain', {
          color: '#123456',
          size: 3.5,
          brush: { stabilization: 0.9, streamline: 0.9 },
        }),
      ),
    );
  });

  it('is stable for identical inputs', () => {
    expect(
      brushPreviewCacheKey(
        input('brush', { color: '#111111', size: 5, brush: { taperEnd: 0.3 } }),
      ),
    ).toBe(
      brushPreviewCacheKey(
        input('brush', { color: '#111111', size: 5, brush: { taperEnd: 0.3 } }),
      ),
    );
  });

  it('resolves nested brush color/size/opacity when the top level is absent', () => {
    // Regression: the key used to read only top-level color/size/opacity,
    // so two nested-only colors shared one cache entry.
    const nestedRed = input('pen', { brush: { color: '#ff0000' } });
    const nestedGreen = input('pen', { brush: { color: '#00ff00' } });
    expect(brushPreviewCacheKey(nestedRed)).not.toBe(
      brushPreviewCacheKey(nestedGreen),
    );
    const nestedThin = input('pen', { brush: { size: 2 } });
    const nestedThick = input('pen', { brush: { size: 9 } });
    expect(brushPreviewCacheKey(nestedThin)).not.toBe(
      brushPreviewCacheKey(nestedThick),
    );
    const nestedFaint = input('pen', { brush: { opacity: 0.2 } });
    const nestedSolid = input('pen', { brush: { opacity: 0.9 } });
    expect(brushPreviewCacheKey(nestedFaint)).not.toBe(
      brushPreviewCacheKey(nestedSolid),
    );
    // Top-level still wins over nested (same resolution as the renderer).
    const topWins = input('pen', {
      color: '#111111',
      brush: { color: '#ff0000' },
    });
    expect(brushPreviewCacheKey(topWins)).toBe(
      brushPreviewCacheKey(
        input('pen', { color: '#111111', brush: { color: '#00ff00' } }),
      ),
    );
    expect(brushPreviewCacheKey(topWins)).not.toBe(
      brushPreviewCacheKey(nestedRed),
    );
  });

  it('invalidates for taper/tilt/cap/opacity and ignores velocity smoothing', () => {
    const base = input('brush', { color: '#111111', size: 5 });
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(
        input('brush', {
          color: '#111111',
          size: 5,
          brush: { taperEnd: 0.6 },
        }),
      ),
    );
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(
        input('brush', {
          color: '#111111',
          size: 5,
          brush: { tiltEffect: 0.9 },
        }),
      ),
    );
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(
        input('brush', {
          color: '#111111',
          size: 5,
          brush: { tip: { cap: 'butt' } },
        }),
      ),
    );
    expect(brushPreviewCacheKey(base)).not.toBe(
      brushPreviewCacheKey(
        input('brush', { color: '#111111', size: 5, opacity: 0.4 }),
      ),
    );
    // Velocity-pressure derivation never changes the static ribbon.
    expect(brushPreviewCacheKey(base)).toBe(
      brushPreviewCacheKey(
        input('brush', {
          color: '#111111',
          size: 5,
          brush: { velocityPressure: true },
        }),
      ),
    );
  });
});

describe('getBrushPreviewGeometry', () => {
  it('returns cached identity for identical inputs', () => {
    clearBrushPreviewCacheForTests();
    const first = getBrushPreviewGeometry(input('pen', { size: 3 }));
    const second = getBrushPreviewGeometry(input('pen', { size: 3 }));
    expect(second).toBe(first);
    expect(
      getBrushPreviewGeometry(input('pen', { size: 6 })),
    ).not.toBe(first);
  });

  it('resolves real spec semantics: highlighter translucent butt, pencil thin', () => {
    clearBrushPreviewCacheForTests();
    const highlighter = getBrushPreviewGeometry(input('highlighter', {}));
    expect(highlighter.opacity).toBeCloseTo(0.35, 2);
    expect(highlighter.cap).toBe('butt');
    const ball = getBrushPreviewGeometry(input('pen', {}));
    expect(ball.opacity).toBe(1);
    expect(ball.cap).toBe('round');
    const fountain = getBrushPreviewGeometry(input('fountain', {}));
    expect(fountain.flatNib).toBe(true);
    expect(ball.flatNib).toBe(false);
    // Distinct families produce distinct ribbons (no shared `d`).
    const ds = new Set(
      (['pen', 'fountain', 'brush', 'pencil', 'highlighter'] as const).map(
        (toolKind) => getBrushPreviewGeometry(input(toolKind, {})).d,
      ),
    );
    expect(ds.size).toBe(5);
  });

  it('scales ribbons with size and honors explicit color', () => {
    clearBrushPreviewCacheForTests();
    const thin = getBrushPreviewGeometry(input('pen', { size: 2 }));
    const thick = getBrushPreviewGeometry(input('pen', { size: 8 }));
    expect(thin.d).not.toBe(thick.d);
    const blue = getBrushPreviewGeometry(
      input('pen', { color: '#0000ff', size: 3 }),
    );
    expect(blue.color).toBe('#0000ff');
  });

  it('changes geometry on nested brush pressure/tip with identical tops', () => {
    clearBrushPreviewCacheForTests();
    const top = { color: '#123456', size: 3.5 };
    const flat = getBrushPreviewGeometry(input('fountain', top));
    const noPressure = getBrushPreviewGeometry(
      input('fountain', { ...top, brush: { pressure: { enabled: false } } }),
    );
    expect(noPressure.d).not.toBe(flat.d);
    const roundTip = getBrushPreviewGeometry(
      input('fountain', { ...top, brush: { tip: { shape: 'round' } } }),
    );
    const flatTip = getBrushPreviewGeometry(
      input('fountain', {
        ...top,
        brush: { tip: { shape: 'flat', aspect: 0.3 } },
      }),
    );
    expect(roundTip.flatNib).toBe(false);
    expect(flatTip.flatNib).toBe(true);
    expect(roundTip.d).not.toBe(flatTip.d);
  });

  it('does not share cache entries for distinct nested-only colors', () => {
    clearBrushPreviewCacheForTests();
    const red = getBrushPreviewGeometry(
      input('pen', { brush: { color: '#ff0000' } }),
    );
    const green = getBrushPreviewGeometry(
      input('pen', { brush: { color: '#00ff00' } }),
    );
    expect(red.color).toBe('#ff0000');
    expect(green.color).toBe('#00ff00');
    expect(green).not.toBe(red);
    expect(green.key).not.toBe(red.key);
  });

  it('renders cap style as geometry: round extends past butt', () => {
    clearBrushPreviewCacheForTests();
    const round = getBrushPreviewGeometry(input('pen', {}));
    const butt = getBrushPreviewGeometry(
      input('pen', { brush: { tip: { cap: 'butt' } } }),
    );
    expect(round.cap).toBe('round');
    expect(butt.cap).toBe('butt');
    expect(butt.d).not.toBe(round.d);
    expect(butt.key).not.toBe(round.key);
  });

  it('renders nib angle and aspect directionally for shaped nibs', () => {
    clearBrushPreviewCacheForTests();
    const straight = getBrushPreviewGeometry(
      input('fountain', {
        brush: { tip: { shape: 'flat', angle: 0, aspect: 0.35 } },
      }),
    );
    const rotated = getBrushPreviewGeometry(
      input('fountain', {
        brush: { tip: { shape: 'flat', angle: 1.57, aspect: 0.35 } },
      }),
    );
    expect(rotated.d).not.toBe(straight.d);
    expect(brushPreviewCacheKey(input('fountain', {
      brush: { tip: { shape: 'flat', angle: 0, aspect: 0.35 } },
    }))).not.toBe(
      brushPreviewCacheKey(input('fountain', {
        brush: { tip: { shape: 'flat', angle: 1.57, aspect: 0.35 } },
      })),
    );
    const thinFlat = getBrushPreviewGeometry(
      input('fountain', {
        brush: { tip: { shape: 'flat', angle: 0, aspect: 0.2 } },
      }),
    );
    const wideFlat = getBrushPreviewGeometry(
      input('fountain', {
        brush: { tip: { shape: 'flat', angle: 0, aspect: 0.9 } },
      }),
    );
    expect(thinFlat.d).not.toBe(wideFlat.d);
  });

  it('renders pressure curve, taper, tilt, and opacity claims', () => {
    clearBrushPreviewCacheForTests();
    const softCurve = getBrushPreviewGeometry(
      input('pen', { brush: { pressure: { curve: 0.5 } } }),
    );
    const hardCurve = getBrushPreviewGeometry(
      input('pen', { brush: { pressure: { curve: 2.5 } } }),
    );
    expect(softCurve.d).not.toBe(hardCurve.d);
    const noTaper = getBrushPreviewGeometry(
      input('brush', { brush: { taperStart: 0, taperEnd: 0 } }),
    );
    const heavyTaper = getBrushPreviewGeometry(
      input('brush', { brush: { taperStart: 0.4, taperEnd: 0.5 } }),
    );
    expect(noTaper.d).not.toBe(heavyTaper.d);
    const noTilt = getBrushPreviewGeometry(
      input('pencil', { brush: { tiltEffect: 0 } }),
    );
    const fullTilt = getBrushPreviewGeometry(
      input('pencil', { brush: { tiltEffect: 1 } }),
    );
    expect(noTilt.d).not.toBe(fullTilt.d);
    const faint = getBrushPreviewGeometry(input('pen', { opacity: 0.25 }));
    const solid = getBrushPreviewGeometry(input('pen', { opacity: 0.95 }));
    expect(faint.opacity).toBeCloseTo(0.25, 3);
    expect(solid.opacity).toBeCloseTo(0.95, 3);
    expect(faint.key).not.toBe(solid.key);
  });
});

describe('BrushPreview component', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function mount(props: BrushPreviewInput): HTMLElement {
    host?.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<BrushPreview {...props} />);
    });
    return host;
  }

  it('renders a decorative cached ribbon with spec color and cap', () => {
    clearBrushPreviewCacheForTests();
    const el = mount(input('highlighter', {}));
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('data-brush-cap')).toBe('butt');
    const path = svg?.querySelector('path');
    expect(path?.getAttribute('fill-opacity')).toBe('0.35');
    expect(path?.getAttribute('d')?.startsWith('M ')).toBe(true);
  });

  it('memoizes across identical re-renders (no pointer-move recompute)', () => {
    clearBrushPreviewCacheForTests();
    const props = input('fountain', { color: '#123456', size: 3.5 });
    const before = getBrushPreviewGeometry(props);
    const el = mount(props);
    const firstD = el.querySelector('path')?.getAttribute('d');
    act(() => {
      root!.render(<BrushPreview {...props} />);
    });
    expect(el.querySelector('path')?.getAttribute('d')).toBe(firstD);
    expect(getBrushPreviewGeometry(props)).toBe(before);
  });
});
