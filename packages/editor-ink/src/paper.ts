import {
  defaultPaperSpacingForTemplate,
  NOTEBOOK_TEMPLATES,
  PAPER_SPACING_MAX,
  PAPER_SPACING_MIN,
  type DocumentToolControl,
  type JsonValue,
  type SurfaceModel,
} from '@froglight/foundation';

export const DEFAULT_SURFACE_PAPER = 'froglight.dots';

const labels: Record<string, string> = {
  'froglight.blank': 'Blank',
  'froglight.lined': 'Ruled',
  'froglight.grid': 'Grid',
  'froglight.dots': 'Dots',
  'froglight.cornell': 'Cornell',
};

const colors = ['#ffffff', '#faf7ef', '#f3ede0', '#eef2f5', '#e9eaee'];

export interface SurfacePaper {
  template: string;
  spacing?: number;
  paperColor?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function surfacePaper(model: SurfaceModel): SurfacePaper {
  const meta = record(model.unknownFields?.meta);
  const paper = record(meta?.paper);
  return {
    template:
      typeof paper?.template === 'string' && paper.template !== ''
        ? paper.template
        : DEFAULT_SURFACE_PAPER,
    ...(typeof paper?.spacing === 'number' &&
    Number.isFinite(paper.spacing) &&
    paper.spacing >= PAPER_SPACING_MIN &&
    paper.spacing <= PAPER_SPACING_MAX
      ? { spacing: paper.spacing }
      : {}),
    ...(typeof paper?.paperColor === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(paper.paperColor)
      ? { paperColor: paper.paperColor }
      : {}),
  };
}

export function surfacePaperControls(
  model: SurfaceModel,
  prefix: string,
): DocumentToolControl[] {
  const paper = surfacePaper(model);
  return [
    {
      kind: 'choice',
      id: `${prefix}.paper-template`,
      semanticRole: 'surface.canvas.paper.template',
      group: 'canvas',
      label: 'Page paper',
      value: paper.template,
      options: NOTEBOOK_TEMPLATES.map((template) => ({
        value: template,
        label: labels[template] ?? template,
      })),
    },
    {
      kind: 'number',
      id: `${prefix}.paper-spacing`,
      semanticRole: 'surface.canvas.paper.spacing',
      group: 'canvas',
      label: 'Rule spacing',
      value: paper.spacing ?? defaultPaperSpacingForTemplate(paper.template),
      min: PAPER_SPACING_MIN,
      max: PAPER_SPACING_MAX,
      step: 1,
      suffix: 'px',
    },
    {
      kind: 'color',
      id: `${prefix}.paper-color`,
      semanticRole: 'surface.canvas.paper.color',
      group: 'canvas',
      label: 'Paper color',
      value: paper.paperColor ?? '#ffffff',
      options: colors,
    },
    {
      kind: 'button',
      id: `${prefix}.paper-reset`,
      semanticRole: 'surface.canvas.paper.reset',
      group: 'canvas',
      label: 'Reset paper',
      shortLabel: 'Reset paper',
      disabled: record(record(model.unknownFields?.meta)?.paper) === null,
    },
  ];
}

export function executeSurfacePaperControl(
  model: SurfaceModel,
  prefix: string,
  id: string,
  value: string | undefined,
  changed: () => void,
): boolean {
  const key =
    id === `${prefix}.paper-template`
      ? 'template'
      : id === `${prefix}.paper-spacing`
        ? 'spacing'
        : id === `${prefix}.paper-color`
          ? 'paperColor'
          : id === `${prefix}.paper-reset`
            ? 'reset'
            : null;
  if (key === null) return false;
  if (key !== 'reset' && value === undefined) return true;
  const input = value ?? '';
  const current = surfacePaper(model);
  let next: SurfacePaper | null = current;
  if (key === 'template') {
    if (
      !NOTEBOOK_TEMPLATES.includes(input as (typeof NOTEBOOK_TEMPLATES)[number])
    )
      return true;
    next = { ...current, template: input };
  } else if (key === 'spacing') {
    const spacing = Number(input);
    if (
      !Number.isFinite(spacing) ||
      spacing < PAPER_SPACING_MIN ||
      spacing > PAPER_SPACING_MAX
    )
      return true;
    next = { ...current, spacing };
  } else if (key === 'paperColor') {
    if (!/^#[0-9a-fA-F]{6}$/.test(input)) return true;
    next = { ...current, paperColor: input };
  } else {
    next = null;
  }
  const meta = record(model.unknownFields?.meta) ?? {};
  const oldPaper = record(meta.paper) ?? {};
  const { paper: _paper, ...otherMeta } = meta;
  const {
    template: _template,
    spacing: _spacing,
    paperColor: _paperColor,
    ...otherPaper
  } = oldPaper;
  model.unknownFields = {
    ...model.unknownFields,
    meta: (next === null
      ? Object.keys(otherPaper).length > 0
        ? { ...otherMeta, paper: otherPaper }
        : otherMeta
      : { ...otherMeta, paper: { ...oldPaper, ...next } }) as JsonValue,
  };
  changed();
  return true;
}
