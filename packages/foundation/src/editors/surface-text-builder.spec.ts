/**
 * Shared surface-text builder contract.
 *
 * Pins the canonical grouped-text table — one Style selector
 * (Body/H1/H2/H3), one Font-size stepper, Bold/Italic toggles, one Align
 * selector, one Text-color picker, one Wrap toggle — with shared labels,
 * icons, groups, semantic roles, activation roles, and ordering.
 * Providers map their own control ids onto the slots and pass
 * provider-computed selection state; the builder never defaults state
 * itself and emits nothing when the selection holds no text (dormant via
 * omission, never synthesized or disabled placeholders).
 */
import { describe, expect, it } from 'vitest';
import {
  buildSurfaceTextControls,
  NO_SURFACE_TEXT_SELECTION,
  SURFACE_TEXT_COLOR_SWATCHES,
  SURFACE_TEXT_DEFAULT_COLOR,
  SURFACE_TEXT_DEFAULT_SIZE,
  SURFACE_TEXT_H1_MIN_SIZE,
  SURFACE_TEXT_H1_SIZE,
  SURFACE_TEXT_H2_MIN_SIZE,
  SURFACE_TEXT_H2_SIZE,
  SURFACE_TEXT_H3_SIZE,
  SURFACE_TEXT_ORDER,
  surfaceTextAlignControl,
  surfaceTextColorControl,
  surfaceTextControlIds,
  surfaceTextSizeControl,
  surfaceTextStyleControl,
  surfaceTextToggleControl,
  type SurfaceTextSelectionState,
} from './surface-text-builder.js';

function liveState(
  overrides: Partial<SurfaceTextSelectionState> = {},
): SurfaceTextSelectionState {
  return {
    hasText: true,
    style: 'body',
    size: 16,
    bold: { active: false, mixed: false },
    italic: { active: false, mixed: false },
    align: 'start',
    color: '#37352f',
    wrap: { active: false, mixed: false },
    ...overrides,
  };
}

describe('surface text builder', () => {
  it('pins canonical slot order Style, Size, Bold, Italic, Align, Color, Wrap', () => {
    expect(SURFACE_TEXT_ORDER).toEqual([
      'style',
      'size',
      'bold',
      'italic',
      'align',
      'color',
      'wrap',
    ]);
  });

  it('pins the H1/H2/H3 size split contract for the write path', () => {
    expect(SURFACE_TEXT_H1_MIN_SIZE).toBe(24);
    expect(SURFACE_TEXT_H1_SIZE).toBe(24);
    expect(SURFACE_TEXT_H2_MIN_SIZE).toBe(20);
    expect(SURFACE_TEXT_H2_SIZE).toBe(20);
    expect(SURFACE_TEXT_H3_SIZE).toBe(18);
  });

  it('derives provider ids from one prefix in canonical order', () => {
    expect(surfaceTextControlIds('notebook')).toEqual({
      style: 'notebook.text.style',
      size: 'notebook.text.size',
      bold: 'notebook.text.bold',
      italic: 'notebook.text.italic',
      align: 'notebook.text.align',
      color: 'notebook.text.color',
      wrap: 'notebook.text.wrap',
    });
  });

  it('emits nothing when the selection holds no text (dormant, never synthesized)', () => {
    expect(
      buildSurfaceTextControls(
        surfaceTextControlIds('notebook'),
        NO_SURFACE_TEXT_SELECTION,
      ),
    ).toEqual([]);
    expect(
      buildSurfaceTextControls(surfaceTextControlIds('notebook'), {
        ...liveState(),
        hasText: false,
      }),
    ).toEqual([]);
  });

  it('emits the seven grouped controls with shared presentation and order', () => {
    expect(
      buildSurfaceTextControls(
        surfaceTextControlIds('notebook'),
        liveState({
          style: 'h1',
          size: 24,
          bold: { active: true, mixed: false },
          italic: { active: false, mixed: true },
          align: 'center',
          color: '#c4554d',
          wrap: { active: true, mixed: false },
        }),
      ),
    ).toEqual([
      {
        kind: 'choice',
        id: 'notebook.text.style',
        group: 'text',
        label: 'Text style',
        icon: 'heading',
        value: 'h1',
        options: [
          { value: 'body', label: 'Body' },
          { value: 'h1', label: 'Heading 1' },
          { value: 'h2', label: 'Heading 2' },
          { value: 'h3', label: 'Heading 3' },
        ],
        semanticRole: 'surface.text.style',
      },
      {
        kind: 'number',
        id: 'notebook.text.size',
        group: 'text',
        label: 'Font size',
        value: 24,
        min: 8,
        max: 96,
        step: 1,
        suffix: 'px',
        semanticRole: 'surface.text.size',
      },
      {
        kind: 'button',
        id: 'notebook.text.bold',
        group: 'text',
        label: 'Bold',
        shortLabel: 'B',
        icon: 'bold',
        semanticRole: 'surface.text.bold',
        activationRole: 'toggle',
        active: true,
      },
      {
        kind: 'button',
        id: 'notebook.text.italic',
        group: 'text',
        label: 'Italic',
        shortLabel: 'I',
        icon: 'italic',
        semanticRole: 'surface.text.italic',
        activationRole: 'toggle',
        mixed: true,
      },
      {
        kind: 'choice',
        id: 'notebook.text.align',
        group: 'text',
        label: 'Text alignment',
        icon: 'align',
        value: 'center',
        options: [
          { value: 'start', label: 'Align start' },
          { value: 'center', label: 'Align center' },
          { value: 'end', label: 'Align end' },
        ],
        semanticRole: 'surface.text.align',
      },
      {
        kind: 'color',
        id: 'notebook.text.color',
        group: 'text',
        label: 'Text color',
        value: '#c4554d',
        options: [...SURFACE_TEXT_COLOR_SWATCHES],
        semanticRole: 'surface.text.color',
      },
      {
        kind: 'button',
        id: 'notebook.text.wrap',
        group: 'text',
        label: 'Wrap text',
        shortLabel: 'Wrap',
        semanticRole: 'surface.text.wrap',
        activationRole: 'toggle',
        active: true,
      },
    ]);
  });

  it('keeps toggles out of exclusive-tool reconciliation', () => {
    // Toggles carry activationRole 'toggle' even when active, so the shelf
    // never mistakes an active Bold for the active editing tool.
    const bold = surfaceTextToggleControl('n.text.bold', 'bold', {
      active: true,
      mixed: false,
    });
    expect(bold).toMatchObject({ activationRole: 'toggle', active: true });
    expect(bold).not.toHaveProperty('mixed');
  });

  it('renders mixed style/align as indeterminate, mixed size/color as defaults', () => {
    expect(surfaceTextStyleControl('n.text.style', 'mixed')).toMatchObject({
      kind: 'choice',
      value: '',
    });
    expect(surfaceTextAlignControl('n.text.align', 'mixed')).toMatchObject({
      kind: 'choice',
      value: '',
    });
    // Number/color controls always carry a valid value: mixed falls back
    // to the default so the stepper/picker stays usable, writing from a
    // mixed selection applies explicitly to every selected text.
    expect(surfaceTextSizeControl('n.text.size', 'mixed')).toMatchObject({
      kind: 'number',
      value: SURFACE_TEXT_DEFAULT_SIZE,
    });
    expect(surfaceTextSizeControl('n.text.size', 24)).toMatchObject({
      kind: 'number',
      value: 24,
    });
    expect(surfaceTextColorControl('n.text.color', 'mixed')).toMatchObject({
      kind: 'color',
      value: SURFACE_TEXT_DEFAULT_COLOR,
    });
    expect(
      surfaceTextColorControl('n.text.color', '#c4554d'),
    ).toMatchObject({ kind: 'color', value: '#c4554d' });
  });

  it('shares presentation across family dialects (reuse)', () => {
    const stripIds = (
      controls: ReturnType<typeof buildSurfaceTextControls>,
    ): unknown[] =>
      controls.map((control) => {
        const record = { ...(control as unknown as Record<string, unknown>) };
        delete record.id;
        return record;
      });
    const state = liveState({ style: 'h2', size: 20, align: 'end' });
    const notebook = stripIds(
      buildSurfaceTextControls(surfaceTextControlIds('notebook'), state),
    );
    const ink = stripIds(
      buildSurfaceTextControls(surfaceTextControlIds('ink'), state),
    );
    expect(notebook).toEqual(ink);
    expect(notebook).toHaveLength(7);
  });
});
