// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  createIcon,
  defaultIconRegistry,
  DEFAULT_ICON_PATHS,
  resolveIconPath,
} from './icons.js';

describe('icon registry', () => {
  it('resolves the default drawn set', () => {
    for (const name of Object.keys(DEFAULT_ICON_PATHS)) {
      expect(defaultIconRegistry.has(name)).toBe(true);
    }
  });

  it('renders an svg with the registered path', () => {
    const svg = createIcon('folder', 18);
    expect(svg.tagName).toBe('svg');
    expect(svg.getAttribute('width')).toBe('18');
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(DEFAULT_ICON_PATHS.folder);
  });

  it('lets plugins override an icon reversibly', () => {
    const override = 'M2 2h20v20H2z';
    const registration = defaultIconRegistry.register('file', override);
    expect(createIcon('file').querySelector('path')?.getAttribute('d')).toBe(override);
    registration.dispose();
    expect(createIcon('file').querySelector('path')?.getAttribute('d')).toBe(
      DEFAULT_ICON_PATHS.file,
    );
  });

  it('stacks overrides: disposing the top restores the previous one', () => {
    const first = defaultIconRegistry.register('graph', 'M1 1');
    const second = defaultIconRegistry.register('graph', 'M2 2');
    second.dispose();
    expect(defaultIconRegistry.get('graph')).toBe('M1 1');
    first.dispose();
    expect(defaultIconRegistry.get('graph')).toBe(DEFAULT_ICON_PATHS.graph);
  });

  it('accepts brand-new plugin-defined icon names and forgets them on dispose', () => {
    const registration = defaultIconRegistry.register('plugin.sparkle', 'M5 5');
    expect(defaultIconRegistry.has('plugin.sparkle')).toBe(true);
    expect(defaultIconRegistry.names()).toContain('plugin.sparkle');
    registration.dispose();
    expect(defaultIconRegistry.has('plugin.sparkle')).toBe(false);
  });

  it('resolves the pen family to distinct approved paths', () => {
    // Ball/Fountain/Brush/Pencil/Highlighter each carry their
    // own registry glyph so Ink/Notebook/Whiteboard toolbars, the shelf
    // family selector, and the squeeze palette stay distinct everywhere
    // they render through resolveIconPath.
    const names = ['pen', 'fountain', 'brush', 'pencil', 'highlighter'];
    const paths = names.map((name) => resolveIconPath(name));
    for (const [index, name] of names.entries()) {
      expect(paths[index], `icon '${name}'`).toBeDefined();
    }
    expect(new Set(paths).size).toBe(names.length);
  });
});
