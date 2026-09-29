/**
 * Contract tests for the deterministic mock Surface tools (spec #52).
 * Every alternate Surface provider speaks the provider-neutral Document
 * Tools seam without Canvas or DOM; these tests pin snapshot shape, command
 * routing, listener lifecycle, and per-family dialects through the public
 * handle interface only.
 */
import { describe, expect, it } from 'vitest';
import { SURFACE_TOOL_IDS } from '../surfaces/tools.js';
import { emptySurface, infiniteFrame } from '../surfaces/model.js';
import { emptyNotebook } from '../notebooks/model.js';
import type { DocumentSession } from '../session.js';
import type { NotebookModel } from '../notebooks/model.js';
import { createMockSurfaceTools } from './mock-surface-tools.js';
import { MockInkEditorHandle } from './mock-ink-editor.js';
import { MockNotebookEditorHandle } from './mock-notebook-editor.js';
import { MockWhiteboardEditorHandle } from './mock-whiteboard-editor.js';

describe('createMockSurfaceTools', () => {
  it('exposes draw, style, image, zoom, and fit controls with live state', () => {
    const tools = createMockSurfaceTools({
      context: 'Whiteboard',
      prefix: 'whiteboard',
    });
    const snapshot = tools.snapshot();
    expect(snapshot.context).toBe('Whiteboard');
    expect(
      snapshot.controls.map((control) => (control as { id: string }).id),
    ).toEqual([
      `whiteboard.tool.${SURFACE_TOOL_IDS.select}`,
      `whiteboard.tool.${SURFACE_TOOL_IDS.pen}`,
      `whiteboard.tool.${SURFACE_TOOL_IDS.highlighter}`,
      `whiteboard.tool.${SURFACE_TOOL_IDS.eraser}`,
      `whiteboard.tool.${SURFACE_TOOL_IDS.lasso}`,
      'whiteboard.color',
      'whiteboard.width',
      'whiteboard.eraser-radius',
      'whiteboard.image',
      'whiteboard.zoom-out',
      'whiteboard.zoom-reset',
      'whiteboard.zoom',
      'whiteboard.zoom-slider',
      'whiteboard.zoom-in',
      'whiteboard.fit',
    ]);
    const select = snapshot.controls[0] as unknown as {
      active?: boolean;
    };
    expect(select.active).toBe(true);
    const image = snapshot.controls.find(
      (control) => (control as { id: string }).id === 'whiteboard.image',
    ) as unknown as { disabled?: boolean };
    expect(image.disabled).toBe(true);
  });

  it('routes tool, style, image, zoom, and fit commands with one notification each', () => {
    const tools = createMockSurfaceTools({
      context: 'Ink canvas',
      prefix: 'ink',
    });
    let notifications = 0;
    const subscription = tools.onDidChange(() => {
      notifications += 1;
    });
    expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.pen}`)).toBe(true);
    expect(tools.execute('ink.color', '#c4554d')).toBe(true);
    expect(tools.execute('ink.width', '6')).toBe(true);
    expect(tools.execute('ink.eraser-radius', '20')).toBe(true);
    expect(tools.execute('ink.image')).toBe(true);
    expect(tools.execute('ink.zoom', '150')).toBe(true);
    expect(tools.execute('ink.zoom-in')).toBe(true);
    expect(tools.execute('ink.fit')).toBe(true);
    expect(tools.execute('ink.zoom-reset')).toBe(true);
    const snapshot = tools.snapshot();
    const byId = new Map(
      snapshot.controls.map((control) => [
        (control as { id: string }).id,
        control as unknown as Record<string, unknown>,
      ]),
    );
    expect(byId.get(`ink.tool.${SURFACE_TOOL_IDS.pen}`)).toMatchObject({
      active: true,
    });
    expect(byId.get(`ink.tool.${SURFACE_TOOL_IDS.select}`)).toMatchObject({
      active: false,
    });
    expect(byId.get('ink.color')).toMatchObject({ value: '#c4554d' });
    expect(byId.get('ink.width')).toMatchObject({ value: '6' });
    expect(byId.get('ink.eraser-radius')).toMatchObject({ value: 20 });
    expect(byId.get('ink.zoom')).toMatchObject({ value: 100 });
    expect(byId.get('ink.zoom-slider')).toMatchObject({ value: 100 });
    expect(notifications).toBe(9);
    subscription.dispose();
    expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.eraser}`)).toBe(true);
    expect(notifications).toBe(9);
  });

  it('rejects unknown tool keys and foreign ids without notifying', () => {
    const tools = createMockSurfaceTools({
      context: 'Notebook page',
      prefix: 'notebook',
    });
    let notifications = 0;
    tools.onDidChange(() => {
      notifications += 1;
    });
    expect(tools.execute('notebook.tool.bogus')).toBe(false);
    expect(tools.execute('notebook.export-all')).toBe(false);
    expect(tools.execute('ink.zoom-in')).toBe(false);
    expect(tools.execute('notebook.color')).toBe(false);
    expect(notifications).toBe(0);
  });
});

describe('mock surface handles speak the tools seam', () => {
  it.each([
    [
      'ink',
      'Ink canvas',
      `ink.tool.${SURFACE_TOOL_IDS.eraser}`,
      () =>
        new MockInkEditorHandle(emptySurface(infiniteFrame()), () => undefined),
    ],
    [
      'notebook',
      'Notebook page',
      `notebook.tool.${SURFACE_TOOL_IDS.eraser}`,
      () =>
        new MockNotebookEditorHandle({
          model: emptyNotebook(),
          markDirty: () => undefined,
        } as unknown as DocumentSession<NotebookModel>),
    ],
    [
      'whiteboard',
      'Whiteboard',
      'whiteboard.tool.eraser-stroke',
      () =>
        new MockWhiteboardEditorHandle(
          emptySurface(infiniteFrame()),
          () => undefined,
        ),
    ],
  ] as const)(
    '%s handle exposes prefixed tools',
    (prefix, context, toolId, create) => {
      const handle = create();
      try {
        const tools = handle.tools!;
        expect(tools.snapshot().context).toBe(context);
        expect(tools.execute(toolId)).toBe(true);
        expect(
          (
            tools
              .snapshot()
              .controls.find(
                (control) => (control as { id: string }).id === toolId,
              ) as unknown as { active?: boolean }
          ).active,
        ).toBe(true);
        expect(tools.execute(`${prefix}.nope`)).toBe(false);
      } finally {
        handle.destroy();
      }
    },
  );

  it('whiteboard mock speaks the short production keys', () => {
    const handle = new MockWhiteboardEditorHandle(
      emptySurface(infiniteFrame()),
      () => undefined,
    );
    try {
      // Short keys match production (`whiteboard.tool.pen`, not the full
      // surface id) so a provider swap stays transparent to consumers.
      expect(
        handle
          .tools!.snapshot()
          .controls.map((control) => (control as { id: string }).id),
      ).toEqual([
        'whiteboard.tool.pen',
        'whiteboard.tool.highlighter',
        'whiteboard.tool.select',
        'whiteboard.tool.eraser-stroke',
        'whiteboard.tool.lasso',
        'whiteboard.tool.text',
        'whiteboard.tool.card',
        'whiteboard.tool.rect',
        'whiteboard.tool.ellipse',
        'whiteboard.tool.line',
        'whiteboard.color',
        'whiteboard.width',
        'whiteboard.eraser-radius',
        'whiteboard.image',
        'whiteboard.zoom-out',
        'whiteboard.zoom-reset',
        'whiteboard.zoom',
        'whiteboard.zoom-slider',
        'whiteboard.zoom-in',
        'whiteboard.fit',
      ]);
    } finally {
      handle.destroy();
    }
  });
});
