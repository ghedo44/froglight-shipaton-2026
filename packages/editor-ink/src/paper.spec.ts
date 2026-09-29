import { describe, expect, it } from 'vitest';
import {
  canonicalSurfaceJson,
  emptySurface,
  infiniteFrame,
} from '@froglight/foundation';
import {
  executeSurfacePaperControl,
  surfacePaper,
  surfacePaperControls,
} from './paper.js';

describe('Ink and Whiteboard paper', () => {
  it('starts white with dots and exposes the same paper choices as Notebook', () => {
    const model = emptySurface(infiniteFrame());
    expect(surfacePaper(model)).toEqual({ template: 'froglight.dots' });
    expect(
      surfacePaperControls(model, 'whiteboard').find(
        (item) => item.id === 'whiteboard.paper-template',
      ),
    ).toMatchObject({ value: 'froglight.dots' });
  });

  it('saves paper without losing title, properties, or unknown paper members', () => {
    const model = emptySurface(infiniteFrame());
    model.unknownFields = {
      meta: {
        title: 'Board',
        properties: { category: 'ideas' },
        paper: { extra: true },
      },
    };
    let changed = 0;
    const execute = (id: string, value?: string) =>
      executeSurfacePaperControl(
        model,
        'whiteboard',
        id,
        value,
        () => changed++,
      );
    expect(execute('whiteboard.paper-template', 'froglight.grid')).toBe(true);
    expect(execute('whiteboard.paper-spacing', '42')).toBe(true);
    expect(execute('whiteboard.paper-color', '#faf7ef')).toBe(true);
    expect(changed).toBe(3);
    expect(surfacePaper(model)).toEqual({
      template: 'froglight.grid',
      spacing: 42,
      paperColor: '#faf7ef',
    });
    expect(JSON.parse(canonicalSurfaceJson(model)).meta).toEqual({
      title: 'Board',
      properties: { category: 'ideas' },
      paper: {
        extra: true,
        template: 'froglight.grid',
        spacing: 42,
        paperColor: '#faf7ef',
      },
    });
    expect(execute('whiteboard.paper-reset')).toBe(true);
    expect(JSON.parse(canonicalSurfaceJson(model)).meta).toEqual({
      title: 'Board',
      properties: { category: 'ideas' },
      paper: { extra: true },
    });
  });
});
