/**
 * Core notebook templates.
 * §3: template ids compile to plain-data background draw items rendered
 * beneath page objects. Presentation derived from canonical ids only —
 * never stored as objects; unknown values render blank (never invented
 * content). Engine-free plain data so every backend and the export path
 * reproduce paper identically.
 *
 * Slice 10 adds the Cornell layout plus per-page paper options (rule
 * spacing override, paper fill). Music/staff paper stays deferred.
 */

import type { DrawItem, EllipseItem, LineItem, RectItem } from '../surfaces/draw.js';
import {
  resolvePaperColor,
  resolvePaperSpacing,
  type NotebookPaperOptions,
} from './paper.js';

/** Core template ids (spec §5); `froglight.blank` is the default. */
export const NOTEBOOK_TEMPLATES = [
  'froglight.blank',
  'froglight.lined',
  'froglight.grid',
  'froglight.dots',
  'froglight.cornell',
] as const;

export type CoreNotebookTemplate = (typeof NOTEBOOK_TEMPLATES)[number];

export const DEFAULT_NOTEBOOK_TEMPLATE: CoreNotebookTemplate = 'froglight.blank';

const CORE_TEMPLATE_SET: ReadonlySet<string> = new Set(NOTEBOOK_TEMPLATES);

/** True when `template` names a core notebook template. */
export function isCoreNotebookTemplate(template: string | undefined): boolean {
  return typeof template === 'string' && CORE_TEMPLATE_SET.has(template);
}

/**
 * Default rule gap for one template id (slice 10 paper UI): the display
 * default shown when a page carries no explicit spacing override.
 * Unknown/blank templates report the ruled gap.
 */
export function defaultPaperSpacingForTemplate(
  template: string | undefined,
): number {
  if (template === 'froglight.grid') return GRID_GAP;
  if (template === 'froglight.dots') return DOT_GAP;
  return LINED_GAP;
}

// Paper geometry in surface units; presentation constants are deliberately
// not wire data (spec §5).
const LINED_GAP = 44;
const GRID_GAP = 32;
const DOT_GAP = 26;
const RULE_WIDTH = 1;
const DOT_DIAMETER = 2.2;
const PAPER_INK = 'rgba(96, 125, 189, 0.30)';
/** Cornell cue-column fraction and summary-band fraction of the page. */
const CORNELL_CUE_FRACTION = 0.32;
const CORNELL_SUMMARY_FRACTION = 0.78;

let backgroundCounter = 0;

function lineItem(
  templateId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): LineItem {
  backgroundCounter += 1;
  const bounds = {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
  return {
    kind: 'line',
    objectId: `${templateId}#bg${backgroundCounter}`,
    bounds,
    rotation: 0,
    x: x1,
    y: y1,
    x2,
    y2,
    width: RULE_WIDTH,
    color: PAPER_INK,
  };
}

function dotItem(templateId: string, cx: number, cy: number): EllipseItem {
  backgroundCounter += 1;
  return {
    kind: 'ellipse',
    objectId: `${templateId}#bg${backgroundCounter}`,
    bounds: {
      x: cx - DOT_DIAMETER / 2,
      y: cy - DOT_DIAMETER / 2,
      width: DOT_DIAMETER,
      height: DOT_DIAMETER,
    },
    rotation: 0,
    fill: PAPER_INK,
  };
}

function paperFillItem(
  templateId: string,
  width: number,
  height: number,
  fill: string,
): RectItem {
  backgroundCounter += 1;
  return {
    kind: 'rect',
    objectId: `${templateId}#paper`,
    bounds: { x: 0, y: 0, width, height },
    rotation: 0,
    fill,
  };
}

/**
 * Compile one page's paper to background draw items for a bounded frame.
 * Unknown/blank templates compile to an empty list — blank paper is the
 * honest rendering of unrecognized ids (spec §5). A `paperColor` option
 * prepends a full-page fill rect so every backend (scene, thumbnail,
 * export) reproduces tinted paper identically; blank + tint still emits
 * only the fill.
 */
export function templateBackgroundDrawItems(
  template: string | undefined,
  width: number,
  height: number,
  paper?: NotebookPaperOptions,
): DrawItem[] {
  const items: DrawItem[] = [];
  const fill = resolvePaperColor(paper);
  const templateId = typeof template === 'string' ? template : DEFAULT_NOTEBOOK_TEMPLATE;
  if (
    fill !== undefined &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    items.push(paperFillItem(templateId, width, height, fill));
  }
  if (
    template === undefined ||
    !CORE_TEMPLATE_SET.has(template) ||
    template === DEFAULT_NOTEBOOK_TEMPLATE
  ) {
    return items;
  }
  if (template === 'froglight.lined') {
    const gap = resolvePaperSpacing(paper, LINED_GAP);
    for (let y = gap; y <= height; y += gap) {
      items.push(lineItem(template, 0, y, width, y));
    }
    return items;
  }
  if (template === 'froglight.grid') {
    const gap = resolvePaperSpacing(paper, GRID_GAP);
    for (let x = gap; x <= width; x += gap) {
      items.push(lineItem(template, x, 0, x, height));
    }
    for (let y = gap; y <= height; y += gap) {
      items.push(lineItem(template, 0, y, width, y));
    }
    return items;
  }
  if (template === 'froglight.cornell') {
    const gap = resolvePaperSpacing(paper, LINED_GAP);
    const cueX = width * CORNELL_CUE_FRACTION;
    const summaryY = height * CORNELL_SUMMARY_FRACTION;
    // Ruled notes area above the summary band.
    for (let y = gap; y < summaryY; y += gap) {
      items.push(lineItem(template, 0, y, width, y));
    }
    // Cue column + summary separator.
    items.push(lineItem(template, cueX, 0, cueX, summaryY));
    items.push(lineItem(template, 0, summaryY, width, summaryY));
    return items;
  }
  // froglight.dots
  const dots: string = template;
  const dotGap = resolvePaperSpacing(paper, DOT_GAP);
  for (let y = dotGap / 2; y <= height; y += dotGap) {
    for (let x = dotGap / 2; x <= width; x += dotGap) {
      items.push(dotItem(dots, x, y));
    }
  }
  return items;
}
