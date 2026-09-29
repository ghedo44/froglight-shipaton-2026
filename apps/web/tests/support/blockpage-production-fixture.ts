import type { Page } from '@playwright/test';
import {
  calloutBlock,
  codeBlock,
  dividerBlock,
  emptyBlockPage,
  headingBlock,
  imageBlock,
  linkedViewBlock,
  listBlock,
  paragraphBlock,
  quoteBlock,
  resourceEmbedBlock,
  resourceLinkBlock,
  tableBlock,
  toggleBlock,
  transclusionBlock,
  type BlockPageModel,
  type ResourceTarget,
} from '@froglight/foundation';

const MISSING_SHA = '0'.repeat(64);
const target: ResourceTarget = {
  documentId: 'fixture-missing-document',
  kindId: 'froglight.markdown',
  resourceId: 'fixture-missing-resource',
};

/**
 * Realistic, canonical all-block document used only by browser acceptance.
 * Missing media/resources are deliberate: the fixture exercises stable
 * offline/unavailable UI without network access or production demo data.
 */
export function comprehensiveBlockpageFixture(): BlockPageModel {
  const model = emptyBlockPage({
    title: 'Block Page production fixture',
    tags: ['fixture', 'release-hardening'],
    properties: {},
  });
  model.rootOrder = [
    'empty',
    'intro',
    'long',
    'h1',
    'h2',
    'h3',
    'h5',
    'rich',
    'bullets',
    'numbers',
    'todos',
    'quote',
    'callout',
    'toggle',
    'code',
    'divider',
    'image',
    'video',
    'audio',
    'file',
    'resource-link',
    'resource-embed',
    'transclusion',
    'linked-view',
    'math',
    'diagram',
    'table-small',
    'table-wide',
    'opaque',
    ...Array.from({ length: 18 }, (_, index) => `tail-${index}`),
  ];
  model.blocks = {
    empty: paragraphBlock('empty', [{ text: '' }]),
    intro: paragraphBlock('intro', [
      { text: 'A short opening paragraph establishes the document rhythm.' },
    ]),
    long: paragraphBlock('long', [
      {
        text: 'This intentionally long paragraph wraps across several lines in narrow panes and split views. It contains enough ordinary prose to expose uncomfortable measures, unexpected horizontal overflow, unstable handles, and spacing that only looks correct with short placeholder copy.',
      },
    ]),
    h1: headingBlock('h1', 1, [{ text: 'Document hierarchy' }]),
    h2: headingBlock('h2', 2, [{ text: 'Writing and structure' }]),
    h3: headingBlock('h3', 3, [{ text: 'Detailed section' }]),
    h5: headingBlock('h5', 5, [{ text: 'Lower-level heading' }]),
    rich: paragraphBlock('rich', [
      { text: 'Bold', marks: ['bold'] },
      { text: ', ' },
      { text: 'italic', marks: ['italic'] },
      { text: ', ' },
      { text: 'struck', marks: ['strikethrough'] },
      { text: ', ' },
      { text: 'inline code', marks: ['code'] },
      { text: ', and ' },
      {
        text: 'an external link',
        marks: [{ type: 'link', href: 'https://example.com' }],
      },
      { text: '.' },
    ]),
    bullets: listBlock('bullets', false, [
      {
        runs: [
          { text: 'First bullet with a readable wrapped line for alignment.' },
        ],
      },
      {
        runs: [{ text: 'Nested bullet parent' }],
        children: ['bullets-nested'],
      },
    ]),
    'bullets-nested': listBlock('bullets-nested', false, [
      { runs: [{ text: 'Nested bullet child' }] },
      { runs: [{ text: 'Second nested child' }] },
    ]),
    numbers: listBlock('numbers', true, [
      { runs: [{ text: 'Ordered step one' }] },
      { runs: [{ text: 'Ordered step two with longer explanatory content.' }] },
    ]),
    todos: listBlock('todos', false, [
      { runs: [{ text: 'Unchecked task' }], checked: false },
      { runs: [{ text: 'Completed task' }], checked: true },
      {
        runs: [
          {
            text: 'A long wrapped task keeps its checkbox aligned to the first line while the text continues naturally below it.',
          },
        ],
        checked: false,
        children: ['todos-nested'],
      },
    ]),
    'todos-nested': listBlock('todos-nested', false, [
      { runs: [{ text: 'Nested follow-up task' }], checked: false },
    ]),
    quote: quoteBlock('quote', [
      {
        text: 'A blockquote should remain part of the document, not become a generic card.',
      },
    ]),
    callout: {
      ...calloutBlock(
        'callout',
        [{ text: 'A restrained callout with nested context.' }],
        {
          icon: 'i',
          tone: 'info',
        },
      ),
      children: ['callout-child'],
    },
    'callout-child': paragraphBlock('callout-child', [
      { text: 'Supporting text inside the callout.' },
    ]),
    toggle: {
      ...toggleBlock('toggle', [{ text: 'Expandable project details' }]),
      children: ['toggle-child', 'nested-toggle'],
    },
    'toggle-child': paragraphBlock('toggle-child', [
      { text: 'The toggle body stays visually connected to its summary.' },
    ]),
    'nested-toggle': {
      ...toggleBlock('nested-toggle', [{ text: 'Nested toggle' }]),
      children: ['nested-toggle-child'],
    },
    'nested-toggle-child': paragraphBlock('nested-toggle-child', [
      { text: 'Deeply nested content remains understandable.' },
    ]),
    code: codeBlock(
      'code',
      "const veryLongIdentifier = 'This line is intentionally wider than a narrow pane and must scroll inside the code block only';\nconsole.log(veryLongIdentifier);",
      'typescript',
    ),
    divider: dividerBlock('divider'),
    image: imageBlock(
      'image',
      'fixtures/missing-image.png',
      MISSING_SHA,
      'Missing fixture image',
    ),
    video: {
      id: 'video',
      type: 'froglight.video',
      src: 'fixtures/missing-video.mp4',
      sha256: MISSING_SHA,
      name: 'Planning walkthrough.mp4',
      caption: 'Unavailable offline fixture video',
    },
    audio: {
      id: 'audio',
      type: 'froglight.audio',
      src: 'fixtures/missing-audio.mp3',
      sha256: MISSING_SHA,
      name: 'Interview notes.mp3',
      caption: 'Unavailable offline fixture audio',
    },
    file: {
      id: 'file',
      type: 'froglight.file',
      src: 'fixtures/missing-file.pdf',
      sha256: MISSING_SHA,
      name: 'Very long research attachment name that must not widen the document.pdf',
    },
    'resource-link': resourceLinkBlock(
      'resource-link',
      target,
      'Unavailable linked note',
    ),
    'resource-embed': resourceEmbedBlock('resource-embed', target, {
      label: 'Unavailable embedded note with a deliberately descriptive label',
      presentation: { showTitle: true, compact: false, maxLines: 4 },
    }),
    transclusion: transclusionBlock(
      'transclusion',
      { ...target, address: 'block:missing' },
      { label: 'Unavailable transcluded section' },
    ),
    'linked-view': linkedViewBlock('linked-view', target, 'missing-view', {
      label: 'Unavailable linked view',
    }),
    math: {
      id: 'math',
      type: 'froglight.math',
      source: String.raw`\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}`,
    },
    diagram: {
      id: 'diagram',
      type: 'froglight.diagram',
      source:
        'flowchart LR\n  Draft --> Review\n  Review --> Ship\n  Review --> Draft',
    },
    'table-small': tableBlock(
      'table-small',
      3,
      [
        {
          cells: [
            [{ text: 'Item' }],
            [{ text: 'Owner' }],
            [{ text: 'Status' }],
          ],
        },
        {
          cells: [
            [{ text: 'Editor polish' }],
            [{ text: 'Team' }],
            [{ text: 'In progress' }],
          ],
        },
      ],
      { header: true, align: ['left', 'left', 'center'] },
    ),
    'table-wide': tableBlock(
      'table-wide',
      6,
      [
        {
          cells: Array.from({ length: 6 }, (_, index) => [
            { text: `Column ${index + 1}` },
          ]),
        },
        {
          cells: Array.from({ length: 6 }, (_, index) => [
            {
              text:
                index === 2
                  ? 'A long cell value that must wrap or remain inside the table scroller'
                  : `Value ${index + 1}`,
            },
          ]),
        },
      ],
      { header: true },
    ),
    opaque: {
      id: 'opaque',
      type: 'fixture.kanban',
      title: 'Plugin-owned planning board',
      lanes: ['Backlog', 'Doing', 'Done'],
      children: ['opaque-child'],
    },
    'opaque-child': paragraphBlock('opaque-child', [
      { text: 'Preserved nested fallback content.' },
    ]),
    ...Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [
        `tail-${index}`,
        paragraphBlock(`tail-${index}`, [
          {
            text: `Long-document paragraph ${index + 1}. Scrolling must keep handles, menus, selection, and overlays attached to the intended block.`,
          },
        ]),
      ]),
    ),
  };
  return model;
}

/** Write a canonical fixture into a disposable browser OPFS vault. */
export async function installBlockpageFixture(
  page: Page,
  vaultName: string,
  fileName = 'Production fixture.blockpage',
): Promise<void> {
  const bytes = `${JSON.stringify(comprehensiveBlockpageFixture(), null, 2)}\n`;
  await page.evaluate(
    async ({ vaultName: name, fileName: file, bytes: content }) => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(name);
      const handle = await vault.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
    },
    { vaultName, fileName, bytes },
  );
}
