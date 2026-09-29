import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FROG_MARK_RECTS, FROG_MARK_VIEWBOX } from './frog-mark.js';

/** Grid cell painted by the canonical SVG's crisp-edge group at (x, y). */
function canonicalCells(): Map<string, string> {
  // The asset lives beside the generator script that produces the PWA icons.
  const url = new URL('../../../assets/froglight-frog.svg', import.meta.url);
  const svg = readFileSync(url, 'utf8');
  const crisp = svg
    .split('<g shape-rendering="crispEdges">')[1]
    ?.split('</g>')[0];
  if (crisp === undefined)
    throw new Error('canonical SVG lost its crisp-edge group');
  const cells = new Map<string, string>();
  for (const match of crisp.matchAll(
    /<rect[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*fill="(#\w+)"/g,
  )) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    for (let dy = 0; dy < Number(match[4]); dy += 1) {
      for (let dx = 0; dx < Number(match[3]); dx += 1) {
        cells.set(`${x + dx},${y + dy}`, match[5]);
      }
    }
  }
  return cells;
}

describe('frog mark geometry', () => {
  it('paints the same cells as the canonical SVG (2-module margin, glow overlays excluded)', () => {
    const canonical = canonicalCells();
    const painted = new Map<string, string>();
    for (const [x, y, width, height, fill] of FROG_MARK_RECTS) {
      for (let dy = 0; dy < height; dy += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          painted.set(`${x + dx + 2},${y + dy + 2}`, fill);
        }
      }
    }
    expect(painted).toEqual(canonical);
  });

  it('stays inside the declared viewBox', () => {
    const [, , viewW, viewH] = FROG_MARK_VIEWBOX.split(' ').map(Number);
    for (const [x, y, width, height] of FROG_MARK_RECTS) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(viewW);
      expect(y + height).toBeLessThanOrEqual(viewH);
    }
  });

  it('uses only the canonical palette hexes', () => {
    const palette = new Set([
      '#023727',
      '#19683F',
      '#318341',
      '#7AB03D',
      '#BBCF32',
      '#F7EE86',
      '#FFFBE8',
    ]);
    for (const rect of FROG_MARK_RECTS) {
      expect(palette.has(rect[4])).toBe(true);
    }
  });
});
