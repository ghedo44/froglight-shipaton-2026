// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codeBlock,
  emptyBlockPage,
  headingBlock,
  paragraphBlock,
  type BlockPageEditorHandle,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from '../editor.js';
import { HeadlessBlockpageEditorHandle } from '../headless-handle.js';
import hostStyles from '../react/BlockpageHost.module.css';

/**
 * BlockPage typography/cards/tokens alignment.
 *
 * The BlockPage provider owns two stylesheets: the React host module
 * (`react/BlockpageHost.module.css`, React-owned chrome) and the plain
 * provider stylesheet (`styles/prose-mirror.css`, ProseMirror/engine-owned
 * DOM). Both must consume `--fl-*` theme tokens only — no legacy
 * `--bg-*`/`--text-*` drift, no hard-coded palette — and share one heading
 * scale with the composition cards so headings/body/cards stay consistent
 * in light and dark worlds. Typography must survive a save/reopen
 * round-trip with React still owning presentation.
 */

const proseCss = fs.readFileSync(
  path.resolve(__dirname, 'prose-mirror.css'),
  'utf8',
);
const hostModuleCss = fs.readFileSync(
  path.resolve(__dirname, '..', 'react', 'BlockpageHost.module.css'),
  'utf8',
);
const themeContractSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'ui', 'src', 'theme-contract.ts'),
  'utf8',
);
const modeFreeTokens = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'ui',
    'src',
    'styles',
    'tokens.css',
  ),
  'utf8',
);
const lightTheme = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'ui', 'src', 'themes', 'light.css'),
  'utf8',
);
const darkTheme = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'ui', 'src', 'themes', 'dark.css'),
  'utf8',
);

const SHEETS: ReadonlyArray<readonly [string, string]> = [
  ['prose-mirror.css', proseCss],
  ['BlockpageHost.module.css', hostModuleCss],
];

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Data-URI payloads (e.g. the to-do check glyph) are fixed art, not theme. */
function stripUrls(css: string): string {
  return css.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()');
}

function consumedFlTokens(css: string): Set<string> {
  const found = new Set<string>();
  for (const match of stripComments(css).matchAll(/var\(\s*(--fl-[a-z-]+)/g)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return found;
}

describe('blockpage token discipline (--fl-* plus private --_fl-* only)', () => {
  it('consumes only public or private Froglight properties (no legacy var drift)', () => {
    for (const [name, css] of SHEETS) {
      expect(
        stripComments(css),
        `${name} uses a non-Froglight variable`,
      ).not.toMatch(/var\(\s*--(?!(?:fl-|_fl-))/);
    }
  });

  it('contains no hard-coded color literals outside tokens', () => {
    for (const [name, css] of SHEETS) {
      const body = stripUrls(stripComments(css));
      expect(body, `${name} has a hex literal`).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b/,
      );
      expect(body, `${name} has an rgb()/rgba() literal`).not.toMatch(
        /\brgba?\s*\(/,
      );
      expect(body, `${name} has an hsl()/hsla() literal`).not.toMatch(
        /\bhsla?\s*\(/,
      );
    }
  });

  it('routes radii and shadows through theme tokens', () => {
    for (const [name, css] of SHEETS) {
      const body = stripComments(css);
      for (const decl of body.match(/border(?:-[a-z]+)*-radius\s*:[^;]+;/g) ??
        []) {
        expect(decl, `${name}: ${decl.trim()} bypasses radii tokens`).toContain(
          'var(--fl-radius',
        );
      }
      for (const decl of body.match(/box-shadow\s*:[^;]+;/g) ?? []) {
        expect(
          decl,
          `${name}: ${decl.trim()} bypasses shadow tokens`,
        ).toContain('var(--fl-shadow');
      }
    }
  });

  it('consumes only contract tokens with values in both light and dark worlds', () => {
    const contract = new Set(
      [...themeContractSrc.matchAll(/'--fl-[a-z-]+'/g)].map((m) =>
        m[0].slice(1, -1),
      ),
    );
    expect(contract.size).toBeGreaterThan(0);
    for (const [name, css] of SHEETS) {
      for (const token of consumedFlTokens(css)) {
        expect(
          contract,
          `${name} consumes ${token} outside the contract`,
        ).toContain(token);
        if (modeFreeTokens.includes(`${token}:`)) continue;
        expect(lightTheme, `${token} has no light value`).toContain(
          `${token}:`,
        );
        expect(darkTheme, `${token} has no dark value`).toContain(`${token}:`);
      }
    }
  });
});

describe('blockpage type scale (headings/body/contained objects)', () => {
  it('keeps heading metrics single-owned by provider chrome', () => {
    for (const size of ['1.8em', '1.45em', '1.2em', '1.05em']) {
      expect(
        proseCss,
        `provider chrome misses the shared ${size} step`,
      ).toContain(`font-size: ${size}`);
      expect(
        hostModuleCss,
        `host module duplicates the provider-owned ${size} step`,
      ).not.toContain(`font-size: ${size}`);
    }
  });

  it('uses pane-relative responsive geometry instead of viewport breakpoints', () => {
    expect(hostModuleCss).toContain('container-name: flbp-pane');
    expect(hostModuleCss).toContain('clamp(20px, 8%, 76px)');
    expect(proseCss).not.toContain('@media (max-width: 760px)');
  });

  it('keeps one body line-height and the mono token for code', () => {
    for (const [name, css] of SHEETS) {
      expect(css, `${name} diverges from the shared body rhythm`).toContain(
        'line-height: 1.65',
      );
      expect(css, `${name} bypasses the mono token`).toContain(
        'var(--fl-font-mono)',
      );
    }
  });

  it('styles contained records from the same token/type system', () => {
    expect(proseCss).toMatch(
      /\.flbp-composition-title\s*\{[^}]*var\(--fl-text-primary\)/,
    );
    expect(proseCss).toMatch(
      /\.flbp-composition-summary\s*\{[^}]*var\(--fl-text-secondary\)/,
    );
    expect(proseCss).toMatch(
      /\.flbp-composition\s*\{[^}]*var\(--fl-surface-editor\)/,
    );
    expect(proseCss).toMatch(
      /\.flbp-composition\s*\{[^}]*var\(--fl-border-default\)/,
    );
    expect(proseCss).toMatch(
      /\.flbp-composition\s*\{[^}]*var\(--fl-radius-lg\)/,
    );
  });
});

describe('blockpage typography round-trip (React owns presentation)', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  function fixture(): BlockPageModel {
    const model = emptyBlockPage({
      title: 'Fixture',
      tags: [],
      properties: {},
    });
    model.rootOrder = ['h1', 'h2', 'p1', 'c1', 'x1'];
    model.blocks = {
      h1: headingBlock('h1', 1, [{ text: 'Title' }]),
      h2: headingBlock('h2', 2, [{ text: 'Section' }]),
      p1: paragraphBlock('p1', [
        { text: 'plain ' },
        { text: 'bold', marks: ['bold'] },
      ]),
      c1: codeBlock('c1', 'const x = 1;', 'js'),
      x1: {
        id: 'x1',
        type: 'acme.kanban',
        lanes: [1, 2],
        payload: { nested: [1, 2] },
      },
    };
    return model;
  }

  function mount(model: BlockPageModel) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    let latest: BlockPageModel | null = null;
    const handle: BlockPageEditorHandle =
      new BlockPageDocumentEditorProvider().createEditor({
        session: {} as never,
        parent,
        initialModel: model,
        onDirtyModel: (next: BlockPageModel) => {
          latest = next;
        },
      });
    return {
      parent,
      handle,
      latest: () => latest as BlockPageModel | null,
      cleanup: () => {
        handle.destroy();
        parent.remove();
      },
    };
  }

  function command(
    env: ReturnType<typeof mount>,
    id: string,
    arg?: unknown,
  ): boolean {
    const run = env.handle.blockCommand;
    if (run === undefined)
      throw new Error('block command channel is unavailable');
    return run.call(env.handle, id, arg);
  }

  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 4));

  it('keeps headings/marks/code/opaque payloads byte-faithful across save/reopen', async () => {
    const env = mount(fixture());
    try {
      // React owns presentation: one committed host, engine DOM inside it.
      expect(env.parent.children).toHaveLength(1);
      const host = env.parent.firstElementChild as HTMLElement;
      expect(host.classList.contains(hostStyles['froglight-blockpage'])).toBe(
        true,
      );
      expect(host.classList.contains('flbp-host')).toBe(true);
      expect(host.querySelector('.ProseMirror')).not.toBeNull();
      expect(host.querySelector('.flbp-slash')).not.toBeNull();
      expect(host.querySelector('.flbp-drag-handle')).not.toBeNull();
      expect(host.querySelector('.flbp-list-drag-handle')).not.toBeNull();

      // Typed edit inside the h1 folds into canonical without touching peers.
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'insert-text', { text: '!' })).toBe(true);
      const latest = env.latest();
      expect(latest).not.toBeNull();
      expect(latest!.blocks.h1).toMatchObject({ runs: [{ text: 'Ti!tle' }] });
      expect(latest!.blocks.h2).toEqual(fixture().blocks.h2);
      expect(latest!.blocks.p1).toEqual(fixture().blocks.p1);
      expect(latest!.blocks.c1).toEqual(fixture().blocks.c1);
      expect(latest!.blocks.x1).toEqual(fixture().blocks.x1);

      // Save/reopen: the dirty model reopens byte-faithful, still React-hosted.
      const reopenParent = document.createElement('div');
      document.body.appendChild(reopenParent);
      let reopened: BlockPageEditorHandle | undefined;
      try {
        reopened = new BlockPageDocumentEditorProvider().createEditor({
          session: {} as never,
          parent: reopenParent,
          initialModel: latest!,
          onDirtyModel: () => undefined,
        });
        const live = reopened as unknown as {
          getModelForTest(): BlockPageModel;
        };
        expect(live.getModelForTest()).toEqual(latest);
        const surface = reopenParent.querySelector('.ProseMirror')!;
        expect(surface.querySelector('h1')?.textContent).toContain('Ti!tle');
        expect(surface.querySelector('h2')?.textContent).toContain('Section');
        expect(surface.textContent).toContain('bold');
        expect(surface.textContent).toContain('const x = 1;');
        const opaque = surface.querySelector('.flbp-opaque');
        expect(opaque).not.toBeNull();
        expect(
          JSON.parse(opaque!.querySelector('script')!.textContent ?? '{}'),
        ).toMatchObject({ lanes: [1, 2] });
        expect(
          reopenParent.firstElementChild?.classList.contains(
            hostStyles['froglight-blockpage'],
          ),
        ).toBe(true);
      } finally {
        reopened?.destroy();
        reopenParent.remove();
      }

      // Replaceability: the same model opens headless, without the editor.
      const headless = new HeadlessBlockpageEditorHandle({
        session: {} as never,
        parent: {},
        initialModel: latest!,
        onDirtyModel: () => undefined,
      });
      try {
        expect(headless.getModelForTest().blocks.h1).toEqual(latest!.blocks.h1);
        expect(headless.getModelForTest().blocks.x1).toEqual(latest!.blocks.x1);
      } finally {
        headless.destroy();
      }
    } finally {
      env.cleanup();
    }
    await flush();
  });
});
