/** Canonical Froglight frog mark geometry.
 *
 *  Same square-module source as `assets/generate_froglight_logo.py`
 *  on a 25x24 module grid with a 2-module
 *  margin, rendered as merged horizontal runs. The raster/ICO assets in
 *  `apps/web/public` are generated from the same geometry, and
 *  `frog-mark.spec.ts` pins parity with the canonical SVG rect count.
 */

const PALETTE = {
  D: '#023727', // deepest green: silhouette
  M: '#19683F', // body green
  G: '#318341', // highlight green
  L: '#7AB03D', // lime
  Y: '#BBCF32', // yellow-lime
  C: '#F7EE86', // warm luminous square
  W: '#FFFBE8', // brightest light core
} as const;

const FROG_GRID: readonly string[] = [
  '    DDDD         DDDD    ',
  '   DLLLLD       DLLLLD   ',
  '   DLDDDLD     DLDDDLD   ',
  '   DLWWMLMMMMMMMLWWMLD   ',
  '   DLWWDLMMMMMMMLWWDLD   ',
  '   DLDDDLMMMMMMMLDDDLD   ',
  '    LLLLMMMMMMMMMLLLL    ',
  '   DMMMMMMMMMDMMMMMDMD   ',
  '   DMMMDDDMMMMMDDMMMMD   ',
  '    DMMMMMDDDDDMMMMMD    ',
  '     DMMMMGGGGGGMMMD     ',
  '     DDMMGGGGGGGMDDD     ',
  '     DMMGGGLYLGGGMMD     ',
  '    GDGGGGLYYYLGGMMD     ',
  'DDDDDLMGGLYCCCYLGGLLDDDDD',
  'DMMDDLDGGYYWW YYGMLLDDMMD',
  'DMMMDLLDGYYWW YYGDLLDMMMD',
  ' DMMDDLLDMYCCCYMDLMDDMMD ',
  '  DMMDDLLYMYYYMYLGDDMMD  ',
  '   DMDDLLDYYYLYDLMDMMD   ',
  '    DMDDDGDGLDDGDDMMD    ',
  ' DMMMMDDDDGDDDGDDDDMMMMD ',
  'D    D DDDDDDDDDDD D M  D',
  '  DDD               D D  ',
];

export const FROG_MARK_VIEWBOX = '0 0 29 28';

export type FrogMarkRect = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
];

function mergeRuns(grid: readonly string[]): FrogMarkRect[] {
  const rects: FrogMarkRect[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x];
      if (cell === ' ' || !(cell in PALETTE)) {
        x += 1;
        continue;
      }
      const key = cell as keyof typeof PALETTE;
      let end = x + 1;
      while (end < row.length && row[end] === key) end += 1;
      rects.push([x, y, end - x, 1, PALETTE[key]]);
      x = end;
    }
  });
  return rects;
}

/** Merged module runs, in the canonical SVG's draw order. */
export const FROG_MARK_RECTS: readonly FrogMarkRect[] = mergeRuns(FROG_GRID);
