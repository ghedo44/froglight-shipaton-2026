/**
 * Snap/alignment computation (slice 9, whiteboard): pure edge/center
 * matching of a moving bounds against static bounds with guide segments.
 * Ephemeral by contract — guides never enter canonical data.
 */

import { describe, expect, it } from 'vitest';
import { computeSnap, SNAP_GUIDE_COLOR } from './snap.js';

const statics = [
  { x: 100, y: 100, width: 40, height: 40 },
  { x: 300, y: 100, width: 40, height: 40 },
];

describe('computeSnap', () => {
  it('snaps moving edges to static edges within threshold', () => {
    // Moving center 96 vs static min 100: off by 4 ≤ 8 (first best wins).
    const moving = { x: 76, y: 200, width: 40, height: 40 };
    const snap = computeSnap(moving, statics, 8);
    expect(snap.dx).toBe(4);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toHaveLength(1);
    expect(snap.guides[0]).toMatchObject({ axis: 'x', position: 100 });
  });

  it('snaps edges independently per axis', () => {
    // Left edge 96 vs static left 100 (dx +4); vertical far away.
    const moving = { x: 96, y: 500, width: 40, height: 40 };
    const snap = computeSnap(moving, statics, 8);
    expect(snap.dx).toBe(4);
    expect(snap.dy).toBe(0);
  });

  it('ignores targets beyond the threshold', () => {
    const moving = { x: 0, y: 0, width: 40, height: 40 };
    const snap = computeSnap(moving, statics, 8);
    expect(snap.dx).toBe(0);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toEqual([]);
  });

  it('picks the first best candidate deterministically per axis', () => {
    // Moving min 290 vs static-2 min 300: 10 ≤ 12 wins the three-way tie.
    const moving = { x: 290, y: 200, width: 40, height: 40 };
    const snap = computeSnap(moving, statics, 12);
    expect(snap.dx).toBe(10);
    expect(snap.guides[0]).toMatchObject({ axis: 'x', position: 300 });
  });

  it('spans guides across the matched pair', () => {
    const moving = { x: 76, y: 76, width: 40, height: 40 };
    const snap = computeSnap(moving, statics, 8);
    expect(snap.dx).toBe(4);
    expect(snap.dy).toBe(4);
    expect(snap.guides).toHaveLength(2);
    for (const guide of snap.guides) {
      expect(guide.from).toBeLessThanOrEqual(76);
      expect(guide.to).toBeGreaterThanOrEqual(140);
    }
  });

  it('exposes a stable guide color', () => {
    expect(SNAP_GUIDE_COLOR).toBe('#7c6cf0');
  });
});
