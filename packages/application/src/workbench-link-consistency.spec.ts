/**
 * Internal-link consistency across document kinds.
 *
 * Cross-editor link matrix: create → copy-link (canonical JSON identity +
 * sub-document address) → reopen → follow → exact reveal. Plus rename/move
 * preservation, [[ flavor convergence, and open-beside split-pane.
 *
 * Addresses are opaque sub-document locations: Markdown heading slugs,
 * block ids, notebook page ids, whiteboard object ids. The controller
 * passes them verbatim to the existing `revealAddress` seams.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySearchService,
  appendPage,
  blockPageKind,
  blockPageKindId,
  buildAddressIndex,
  emptyBlockPage,
  emptySurface,
  infiniteFrame,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  emptyNotebook,
  notebookKind,
  notebookKindId,
  notebookPage,
  paragraphBlock,
  whiteboardKind,
  whiteboardKindId,
  workspacePath,
  type BlockPageModel,
  type DocumentEditorProvider,
  type DocumentKindId,
  type DocumentSession,
  type NotebookModel,
  type SurfaceModel,
} from '@froglight/foundation';
import { WhiteboardDocumentEditorProvider } from '@froglight/editor-whiteboard';
import { BlockPageDocumentEditorProvider } from '@froglight/editor-blockpage';
import { createApp, createWorkbenchController } from './index.js';
import {
  LINK_ERROR_CODES,
  MAX_LINK_ADDRESS_LENGTH,
  MAX_LINK_DESTINATION_LENGTH,
  MAX_LINK_ID_LENGTH,
  MAX_LINK_PATH_LENGTH,
  formatResourceLink,
  isResourceLinkTarget,
  parseResourceLink,
  resolveResourceTarget,
} from './link-resolution.js';
import { FroglightError } from '@froglight/foundation';

function capturingProvider(
  kindId: DocumentKindId,
  prefix: string,
  revealed: string[],
): DocumentEditorProvider {
  return {
    id: `t11-${prefix}`,
    kindIds: [kindId],
    createEditor() {
      return {
        focus() {
          /* test double: focus is unobserved */
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        revealAddress(address: string) {
          revealed.push(`${prefix}:${address}`);
        },
        destroy() {
          /* test double: nothing to tear down */
        },
      };
    },
  };
}

async function makeLinkApp() {
  const revealed: string[] = [];
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind, blockPageKind, notebookKind, whiteboardKind],
    documentEditorProviders: [
      capturingProvider(markdownKindId, 'markdown', revealed),
      capturingProvider(blockPageKindId, 'blockpage', revealed),
      capturingProvider(notebookKindId, 'notebook', revealed),
      capturingProvider(whiteboardKindId, 'whiteboard', revealed),
    ],
  });
  const controller = createWorkbenchController(app);
  await controller.initialize({});
  return { app, controller, revealed };
}

/**
 *  single-owner mirror of the controller's private `#owningPaneFor`:
 * after a duplicate open redirects to the live owner, the requested pane
 * may be empty. Resolve where the document actually lives for attach
 * assertions — never the stale requested pane.
 */
function owningPaneFor(
  controller: ReturnType<typeof createWorkbenchController>,
  documentId: string,
  preferred: string,
): string {
  const states = controller.paneStates();
  if (states.find((pane) => pane.pane === preferred)?.documentId === documentId) {
    return preferred;
  }
  return states.find((pane) => pane.documentId === documentId)?.pane ?? preferred;
}

/**
 * Headless equivalent of the shell mounting a destination before the link's
 * final reveal. A bare controller open may finish before a host exists; these
 * exact-reveal tests exercise the mounted-destination case, not that timing.
 * Never replay an address here: only the real link operation may reveal it.
 */
function mountLinkDestinations(controller: ReturnType<typeof createWorkbenchController>) {
  const open = controller.openDocument.bind(controller);
  const hosts = new Map<string, object>();
  return vi.spyOn(controller, 'openDocument').mockImplementation(async (id, parent, opts = {}) => {
    await open(id, parent, opts);
    const requested = opts.pane ?? 'main';
    if (parent !== undefined) return;
    // redirect: a duplicate open focuses the live owner and leaves the
    // requested pane untouched, so mount/attach where the document ended up.
    const pane = owningPaneFor(controller, String(id), requested);
    let host = hosts.get(pane);
    if (host === undefined) { host = {}; hosts.set(pane, host); }
    if (!controller.isPaneAttached(pane, host)) {
      await controller.reattachPane(pane, host);
    }
    expect(controller.isPaneAttached(pane, host)).toBe(true);
  });
}

async function seedMarkdown(
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  raw = '# Guide\n## Getting Started\nBody',
): Promise<string> {
  const workspace = app.getWorkspace()!;
  const ref = await workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath(path),
    initialModel: markdownModel(raw),
  });
  await workspace.rebuildDerivedState();
  return String(ref.documentId);
}

async function seedBlockPage(
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  blockId = 'b1',
): Promise<{ id: string; blockId: string }> {
  const workspace = app.getWorkspace()!;
  const model = emptyBlockPage({ title: 'Blocks' });
  model.rootOrder = [blockId];
  model.blocks[blockId] = paragraphBlock(blockId, [{ text: 'hello block' }]);
  const ref = await workspace.createDocument({
    kindId: blockPageKindId,
    path: workspacePath(path),
    initialModel: model,
  });
  await workspace.rebuildDerivedState();
  return { id: String(ref.documentId), blockId };
}

async function seedNotebook(
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  pageId = 'page-1',
): Promise<{ id: string; pageId: string }> {
  const workspace = app.getWorkspace()!;
  const model = emptyNotebook('Notebook');
  appendPage(model, notebookPage(pageId as never));
  const ref = await workspace.createDocument({
    kindId: notebookKindId,
    path: workspacePath(path),
    initialModel: model,
  });
  await workspace.rebuildDerivedState();
  return { id: String(ref.documentId), pageId };
}

async function seedWhiteboard(
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  objectId = 'obj-1',
): Promise<{ id: string; objectId: string }> {
  const workspace = app.getWorkspace()!;
  const model = emptySurface(infiniteFrame());
  model.objects[objectId] = {
    id: objectId,
    type: 'froglight.text',
    x: 5,
    y: 5,
    text: 'board label',
  };
  model.order.push(objectId);
  const ref = await workspace.createDocument({
    kindId: whiteboardKindId,
    path: workspacePath(path),
    initialModel: model,
  });
  await workspace.rebuildDerivedState();
  return { id: String(ref.documentId), objectId };
}

describe('copy-link codec (canonical JSON identity)', () => {
  it('round-trips documentId/kindId/resourceId/address with stable key order', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const id = await seedMarkdown(app, 'notes/Codec.md');
      const link = controller.copyLinkFor(id, 'getting-started');
      expect(link).not.toBeNull();
      const parsed = parseResourceLink(link!);
      expect(parsed?.documentId).toBe(id);
      expect(parsed?.address).toBe('getting-started');
      // Canonical key order: documentId, kindId, resourceId, address.
      expect(Object.keys(JSON.parse(link!))).toEqual([
        'documentId',
        'kindId',
        'resourceId',
        'address',
      ]);
      expect(parseResourceLink(formatResourceLink(parsed!))).toEqual(parsed);
    } finally {
      await app.dispose();
    }
  });

  it('rejects URL schemes and malformed text (never throws, never a URL)', async () => {
    expect(parseResourceLink('https://example.com/note')).toBeNull();
    expect(parseResourceLink('froglight:notes/Note.md')).toBeNull();
    expect(parseResourceLink('not json at all')).toBeNull();
    expect(parseResourceLink('')).toBeNull();
    expect(parseResourceLink('{"documentId":"d"}')).toBeNull();
    expect(
      parseResourceLink(
        '{"documentId":"d","kindId":"k","resourceId":"r","address":""}',
      ),
    ).toBeNull();
  });
});

describe('cross-editor link matrix (create→copy→reopen→follow→reveal)', () => {
  it('markdown: heading slug follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const id = await seedMarkdown(app, 'notes/Guide.md');
      const link = controller.copyLinkFor(id, 'getting-started')!;
      // Reopen elsewhere so follow must restore the session + reveal.
      const other = await seedMarkdown(app, 'notes/Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(revealed).toContain('markdown:getting-started');
    } finally {
      await app.dispose();
    }
  });

  it('blockpage: block id follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const { id, blockId } = await seedBlockPage(app, 'pages/blocks.blockpage');
      const link = controller.copyLinkFor(id, blockId)!;
      const other = await seedMarkdown(app, 'notes/Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(revealed).toContain(`blockpage:${blockId}`);
    } finally {
      await app.dispose();
    }
  });

  it('notebook: page id follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const { id, pageId } = await seedNotebook(app, 'notes/field.notebook');
      const link = controller.copyLinkFor(id, pageId)!;
      const other = await seedMarkdown(app, 'notes/Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(revealed).toContain(`notebook:${pageId}`);
    } finally {
      await app.dispose();
    }
  });

  it('whiteboard: object id follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const { id, objectId } = await seedWhiteboard(app, 'boards/ideas.whiteboard');
      const link = controller.copyLinkFor(id, objectId)!;
      const other = await seedMarkdown(app, 'notes/Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(revealed).toContain(`whiteboard:${objectId}`);
    } finally {
      await app.dispose();
    }
  });
});

describe('no divergent [[ flavors', () => {
  it('picker/paste/menu converge: explicit target, JSON paste, and path#fragment reveal identically', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const id = await seedMarkdown(app, 'notes/Converge.md');
      const link = controller.copyLinkFor(id, 'getting-started')!;
      const target = parseResourceLink(link)!;

      // Flavor 1 (picker/menu): explicit validated target.
      revealed.length = 0;
      const viaTarget = await controller.openResourceTarget(target);
      expect(viaTarget.created).toBe(false);
      expect(viaTarget.documentId).toBe(id);
      expect(revealed).toContain('markdown:getting-started');

      // Flavor 2 (paste): the same canonical JSON string.
      revealed.length = 0;
      const viaPaste = await controller.openLink(link);
      expect(viaPaste.documentId).toBe(id);
      expect(revealed).toContain('markdown:getting-started');

      // Flavor 3 (menu/[[): path with fragment resolves the same document.
      revealed.length = 0;
      const viaPath = await controller.openLink('notes/Converge.md#getting-started');
      expect(viaPath.documentId).toBe(id);
      expect(revealed).toContain('markdown:getting-started');
    } finally {
      await app.dispose();
    }
  });

  it('divergent payloads are rejected by the single isResourceTarget-class validation', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      await seedMarkdown(app, 'notes/Anchor.md');
      // Path/title-shaped payloads are not identity targets.
      await expect(
        controller.openResourceTarget({ path: 'notes/Anchor.md' }),
      ).rejects.toThrow();
      await expect(
        controller.openResourceTarget({ title: 'Anchor' }),
      ).rejects.toThrow();
      await expect(
        controller.openResourceTarget({ documentId: 'only-id' }),
      ).rejects.toThrow();
      // Unknown identity never resolves.
      await expect(
        controller.openResourceTarget({
          documentId: 'missing',
          kindId: String(markdownKindId),
          resourceId: 'missing',
        }),
      ).rejects.toThrow();
      // Identity resolution agrees: unknown targets stay null.
      expect(
        resolveResourceTarget(app.getWorkspace()!, {
          documentId: 'missing',
          kindId: String(markdownKindId),
          resourceId: 'missing',
        }),
      ).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  it('browser URLs are never canonical: openLink rejects URL schemes without creating', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const before = controller.listDocuments().length;
      await expect(
        controller.openLink('https://example.com/notes/Remote'),
      ).rejects.toThrow();
      expect(controller.listDocuments()).toHaveLength(before);
    } finally {
      await app.dispose();
    }
  });

  it('open-beside keeps the source visible in a split pane with exact reveal', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    const mounting = mountLinkDestinations(controller);
    try {
      const sourceId = await seedMarkdown(app, 'notes/Source.md');
      const { id: targetId, blockId } = await seedBlockPage(
        app,
        'pages/Target.blockpage',
      );
      await controller.openDocument(sourceId, {}, { pane: 'main' });
      const link = controller.copyLinkFor(targetId, blockId)!;
      revealed.length = 0;
      const result = await controller.openLink(link, { openBeside: true });
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(targetId);
      // Split-pane: two panes, source still visible where it was.
      const panes = controller.paneStates();
      expect(panes).toHaveLength(2);
      expect(panes.map((pane) => pane.documentId)).toContain(sourceId);
      expect(panes.map((pane) => pane.documentId)).toContain(targetId);
      expect(revealed).toContain(`blockpage:${blockId}`);
    } finally {
      mounting.mockRestore();
      await controller.dispose();
      await app.dispose();
    }
  });
});

describe('rename/move preserves links (identity-based)', () => {
  it('a copied link follows exact after the target is renamed', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const { id, blockId } = await seedBlockPage(app, 'pages/Before.blockpage');
      const link = controller.copyLinkFor(id, blockId)!;
      const other = await seedMarkdown(app, 'notes/Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      // Rename/move: identity must survive, path must not be canonical.
      await controller.moveDocumentTo(id, 'pages/After.blockpage');
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(revealed).toContain(`blockpage:${blockId}`);
      // Path flavor tracks the moved document too.
      revealed.length = 0;
      const viaPath = await controller.openLink('pages/After.blockpage');
      expect(viaPath.documentId).toBe(id);
    } finally {
      await app.dispose();
    }
  });
});

/** Editor double WITHOUT a reveal seam: document opens, exact reveal degrades. */
function plainProvider(kindId: DocumentKindId): DocumentEditorProvider {
  return {
    id: `t11-plain-${String(kindId)}`,
    kindIds: [kindId],
    createEditor() {
      return {
        focus() {
          /* test double: focus is unobserved */
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        destroy() {
          /* test double: nothing to tear down */
        },
      };
    },
  };
}

describe('cross-codec vectors (hardcoded outputs)', () => {
  // Fixtures below are byte-exact outputs of the picker codec
  // (`packages/ui/src/react/picker/resource-link.ts`, READ-ONLY reference):
  // plain JSON, fixed key order, no browser URL, no path/title. Pinned here
  // by value so either codec drifting fails loudly. No `@froglight/ui`
  // import: the application layer must not depend on the UI package.
  it('parses copy-link output without address', () => {
    const t07 =
      '{"documentId":"doc-1","kindId":"froglight.markdown","resourceId":"res-1"}';
    const parsed = parseResourceLink(t07);
    expect(parsed).toEqual({
      documentId: 'doc-1',
      kindId: 'froglight.markdown',
      resourceId: 'res-1',
    });
    expect(Object.keys(JSON.parse(t07))).toEqual([
      'documentId',
      'kindId',
      'resourceId',
    ]);
  });

  it('parses copy-link output with address and re-serializes byte-stable', () => {
    const t07 =
      '{"documentId":"doc-1","kindId":"froglight.markdown","resourceId":"res-1","address":"getting-started"}';
    const parsed = parseResourceLink(t07);
    expect(parsed?.address).toBe('getting-started');
    expect(formatResourceLink(parsed!)).toBe(t07);
    expect(Object.keys(JSON.parse(t07))).toEqual([
      'documentId',
      'kindId',
      'resourceId',
      'address',
    ]);
  });

  it('tolerates extra unknown members when identity members validate', () => {
    const t07Extra =
      '{"documentId":"doc-1","kindId":"froglight.markdown","resourceId":"res-1","address":"a","label":"Board"}';
    const parsed = parseResourceLink(t07Extra);
    expect(parsed).toEqual({
      documentId: 'doc-1',
      kindId: 'froglight.markdown',
      resourceId: 'res-1',
      address: 'a',
    });
    // Re-serialization drops the unknown member (canonical form).
    expect(formatResourceLink(parsed!)).toBe(
      '{"documentId":"doc-1","kindId":"froglight.markdown","resourceId":"res-1","address":"a"}',
    );
  });

  it('rejects empty-address output (never a valid target)', () => {
    expect(
      parseResourceLink(
        '{"documentId":"doc-1","kindId":"froglight.markdown","resourceId":"res-1","address":""}',
      ),
    ).toBeNull();
  });
});

describe('link guards (: empty address, non-string input)', () => {
  it('formatResourceLink omits empty addresses (mirrors resourceTargetForDocument)', () => {
    expect(
      formatResourceLink({
        documentId: 'd',
        kindId: 'k',
        resourceId: 'r',
        address: '',
      }),
    ).toBe('{"documentId":"d","kindId":"k","resourceId":"r"}');
    expect(
      formatResourceLink({ documentId: 'd', kindId: 'k', resourceId: 'r' }),
    ).toBe('{"documentId":"d","kindId":"k","resourceId":"r"}');
  });

  it('parseResourceLink returns null for non-string input (never throws)', () => {
    expect(parseResourceLink(null)).toBeNull();
    expect(parseResourceLink(undefined)).toBeNull();
    expect(parseResourceLink(42)).toBeNull();
    expect(parseResourceLink({})).toBeNull();
    expect(parseResourceLink([])).toBeNull();
  });

  it('openLink rejects non-string destinations with a coded error and creates nothing', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const before = controller.listDocuments().length;
      await expect(
        controller.openLink(42 as unknown as string),
      ).rejects.toMatchObject({ code: LINK_ERROR_CODES.INVALID_RESOURCE_LINK });
      expect(controller.listDocuments()).toHaveLength(before);
    } finally {
      await app.dispose();
    }
  });
});

describe('link caps (: destination, identity, address, path)', () => {
  it('parse rejects over-long destinations pre-parse and over-long members', () => {
    expect(parseResourceLink('x'.repeat(MAX_LINK_DESTINATION_LENGTH + 1))).toBeNull();
    const longId = 'd'.repeat(MAX_LINK_ID_LENGTH + 1);
    expect(
      parseResourceLink(
        JSON.stringify({ documentId: longId, kindId: 'k', resourceId: 'r' }),
      ),
    ).toBeNull();
    expect(
      parseResourceLink(
        JSON.stringify({ documentId: 'd', kindId: 'k'.repeat(513), resourceId: 'r' }),
      ),
    ).toBeNull();
    expect(
      parseResourceLink(
        JSON.stringify({ documentId: 'd', kindId: 'k', resourceId: 'r'.repeat(600) }),
      ),
    ).toBeNull();
    expect(
      parseResourceLink(
        JSON.stringify({
          documentId: 'd',
          kindId: 'k',
          resourceId: 'r',
          address: 'a'.repeat(MAX_LINK_ADDRESS_LENGTH + 1),
        }),
      ),
    ).toBeNull();
    // Boundary members validate.
    expect(
      isResourceLinkTarget({
        documentId: 'd'.repeat(MAX_LINK_ID_LENGTH),
        kindId: 'k',
        resourceId: 'r',
        address: 'a'.repeat(MAX_LINK_ADDRESS_LENGTH),
      }),
    ).toBe(true);
    expect(
      isResourceLinkTarget({
        documentId: 'd'.repeat(MAX_LINK_ID_LENGTH + 1),
        kindId: 'k',
        resourceId: 'r',
      }),
    ).toBe(false);
  });

  it('openLink rejects over-long destinations without creating', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const before = controller.listDocuments().length;
      await expect(
        controller.openLink('n'.repeat(MAX_LINK_DESTINATION_LENGTH + 1)),
      ).rejects.toMatchObject({
        code: LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
      });
      expect(controller.listDocuments()).toHaveLength(before);
    } finally {
      await app.dispose();
    }
  });

  it('openLink rejects absurd path candidates without creating', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const before = controller.listDocuments().length;
      await expect(
        controller.openLink('q'.repeat(MAX_LINK_PATH_LENGTH + 100)),
      ).rejects.toMatchObject({
        code: LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
      });
      expect(controller.listDocuments()).toHaveLength(before);
    } finally {
      await app.dispose();
    }
  });
});

describe('coded link failures', () => {
  it('exports stable codes and throws FroglightError with those codes', async () => {
    expect(LINK_ERROR_CODES.INVALID_RESOURCE_LINK).toBe('INVALID_RESOURCE_LINK');
    expect(LINK_ERROR_CODES.UNKNOWN_RESOURCE_TARGET).toBe('UNKNOWN_RESOURCE_TARGET');
    expect(LINK_ERROR_CODES.INVALID_LINK_DESTINATION).toBe('INVALID_LINK_DESTINATION');
    const { app, controller } = await makeLinkApp();
    try {
      await seedMarkdown(app, 'notes/Coded.md');
      const divergent = controller.openResourceTarget({ path: 'notes/Coded.md' });
      await expect(divergent).rejects.toBeInstanceOf(FroglightError);
      await expect(divergent).rejects.toMatchObject({
        code: LINK_ERROR_CODES.INVALID_RESOURCE_LINK,
      });
      const unknown = controller.openResourceTarget({
        documentId: 'missing',
        kindId: String(markdownKindId),
        resourceId: 'missing',
      });
      await expect(unknown).rejects.toMatchObject({
        code: LINK_ERROR_CODES.UNKNOWN_RESOURCE_TARGET,
      });
      const url = controller.openLink('https://example.com/x');
      await expect(url).rejects.toMatchObject({
        code: LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
      });
    } finally {
      await app.dispose();
    }
  });
});

describe('malformed copy-link JSON never creates', () => {
  it('openLink rejects JSON-like breakage with INVALID_RESOURCE_LINK', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const before = controller.listDocuments().length;
      await expect(
        controller.openLink('{"documentId":"d","kindId":"k","resourceId"'),
      ).rejects.toMatchObject({ code: LINK_ERROR_CODES.INVALID_RESOURCE_LINK });
      await expect(
        controller.openLink('["not","a","link"]'),
      ).rejects.toMatchObject({ code: LINK_ERROR_CODES.INVALID_RESOURCE_LINK });
      expect(controller.listDocuments()).toHaveLength(before);
    } finally {
      await app.dispose();
    }
  });

  it('openLinkBeside rejects JSON-like breakage without splitting or creating', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const sourceId = await seedMarkdown(app, 'notes/BesideSrc.md');
      await controller.openDocument(sourceId, {}, { pane: 'main' });
      const panesBefore = controller.paneStates().length;
      const docsBefore = controller.listDocuments().length;
      await expect(
        controller.openLinkBeside('{"documentId":"d","kindId":"k"'),
      ).rejects.toMatchObject({ code: LINK_ERROR_CODES.INVALID_RESOURCE_LINK });
      await expect(
        controller.openLinkBeside('["not","a","link"]'),
      ).rejects.toMatchObject({ code: LINK_ERROR_CODES.INVALID_RESOURCE_LINK });
      expect(controller.paneStates()).toHaveLength(panesBefore);
      expect(controller.listDocuments()).toHaveLength(docsBefore);
    } finally {
      await app.dispose();
    }
  });
});

describe('beside failing path creates no pane and keeps focus', () => {
  it('unsanitizable and URL destinations leave pane count and focus unchanged', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const sourceId = await seedMarkdown(app, 'notes/Focus.md');
      await controller.openDocument(sourceId, {}, { pane: 'main' });
      controller.focusPane('main');
      const panesBefore = controller.paneStates().length;
      const focusBefore = controller.focusedPane;
      await expect(controller.openLinkBeside('///')).rejects.toMatchObject({
        code: LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
      });
      await expect(
        controller.openLinkBeside('https://example.com/remote'),
      ).rejects.toMatchObject({
        code: LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
      });
      expect(controller.paneStates()).toHaveLength(panesBefore);
      expect(controller.focusedPane).toBe(focusBefore);
    } finally {
      await app.dispose();
    }
  });
});

describe('background links preserve focus', () => {
  it('openDocument with address + preserveFocus reveals without moving focus', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const sourceId = await seedMarkdown(app, 'notes/BgSrc.md');
      const targetId = await seedMarkdown(app, 'notes/BgTarget.md');
      await controller.openDocument(sourceId, {}, { pane: 'main' });
      const beside = controller.splitPane('main', 'right');
      controller.focusPane('main');
      expect(controller.focusedPane).toBe('main');
      revealed.length = 0;
      await controller.openDocument(
        targetId,
        {},
        { pane: beside, address: 'getting-started', preserveFocus: true },
      );
      expect(controller.focusedPane).toBe('main');
      expect(
        controller.paneStates().find((pane) => pane.pane === beside)?.documentId,
      ).toBe(targetId);
      expect(revealed).toContain('markdown:getting-started');
    } finally {
      await app.dispose();
    }
  });

  it('openResourceTarget with address + preserveFocus reveals without moving focus', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    const mounting = mountLinkDestinations(controller);
    try {
      const sourceId = await seedMarkdown(app, 'notes/BgSrc2.md');
      const targetId = await seedMarkdown(app, 'notes/BgTarget2.md');
      await controller.openDocument(sourceId, {}, { pane: 'main' });
      const beside = controller.splitPane('main', 'right');
      controller.focusPane('main');
      const link = controller.copyLinkFor(targetId, 'getting-started')!;
      const target = parseResourceLink(link)!;
      revealed.length = 0;
      const result = await controller.openResourceTarget(target, {
        pane: beside,
        preserveFocus: true,
      });
      expect(result.revealed).toBe(true);
      expect(controller.focusedPane).toBe('main');
      expect(
        controller.paneStates().find((pane) => pane.pane === beside)?.documentId,
      ).toBe(targetId);
      expect(revealed).toContain('markdown:getting-started');
    } finally {
      mounting.mockRestore();
      await controller.dispose();
      await app.dispose();
    }
  });

  it('openLink/openLinkBeside with preserveFocus keep focus and still reveal', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    const mounting = mountLinkDestinations(controller);
    try {
      const sourceId = await seedMarkdown(app, 'notes/BgSrc3.md');
      const targetId = await seedMarkdown(app, 'notes/BgTarget3.md');
      await controller.openDocument(sourceId, {}, { pane: 'main' });
      controller.focusPane('main');
      const link = controller.copyLinkFor(targetId, 'getting-started')!;
      revealed.length = 0;
      const viaLink = await controller.openLink(link, {
        openBeside: true,
        preserveFocus: true,
      });
      expect(viaLink.revealed).toBe(true);
      expect(controller.focusedPane).toBe('main');
      expect(revealed).toContain('markdown:getting-started');
      expect(controller.paneStates()).toHaveLength(2);

      revealed.length = 0;
      const viaBeside = await controller.openLinkBeside('notes/BgTarget3.md#getting-started', {
        preserveFocus: true,
      });
      expect(viaBeside.revealed).toBe(true);
      expect(controller.focusedPane).toBe('main');
      expect(revealed).toContain('markdown:getting-started');
    } finally {
      mounting.mockRestore();
      await controller.dispose();
      await app.dispose();
    }
  });
});

describe('reveal honesty', () => {
  it('propagates the reveal seam boolean: exact where the seam exists', async () => {
    const { app, controller, revealed } = await makeLinkApp();
    try {
      const id = await seedMarkdown(app, 'notes/Honest.md');
      const link = controller.copyLinkFor(id, 'getting-started')!;
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.revealed).toBe(true);
      expect(revealed).toContain('markdown:getting-started');
      // The seam itself reports success where it exists.
      expect(controller.revealAddress('main', 'getting-started')).toBe(true);
    } finally {
      await app.dispose();
    }
  });

  it('degrades to document-open-only where no reveal seam exists (no silent success)', async () => {
    const revealed: string[] = [];
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, blockPageKind, notebookKind, whiteboardKind],
      documentEditorProviders: [
        capturingProvider(markdownKindId, 'markdown', revealed),
        plainProvider(blockPageKindId),
        capturingProvider(notebookKindId, 'notebook', revealed),
        plainProvider(whiteboardKindId),
      ],
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    try {
      // Markdown (seam present): exact reveal, revealed true.
      const mdId = await seedMarkdown(app, 'notes/Degrade.md');
      const mdLink = controller.copyLinkFor(mdId, 'getting-started')!;
      revealed.length = 0;
      const mdResult = await controller.openLink(mdLink);
      expect(mdResult.documentId).toBe(mdId);
      expect(mdResult.revealed).toBe(true);

      // Blockpage (no seam in this wiring): document still opens, but the
      // result honestly reports document-open-only.
      const { id: blockId, blockId: address } = await seedBlockPage(
        app,
        'pages/Degrade.blockpage',
      );
      const blockLink = controller.copyLinkFor(blockId, address)!;
      const blockResult = await controller.openLink(blockLink);
      expect(blockResult.created).toBe(false);
      expect(blockResult.documentId).toBe(blockId);
      expect(blockResult.revealed).toBe(false);
      expect(controller.revealAddress('main', address)).toBe(false);

      // Whiteboard (no seam in this wiring): same degrade.
      const { id: boardId, objectId } = await seedWhiteboard(
        app,
        'boards/Degrade.whiteboard',
      );
      const boardLink = controller.copyLinkFor(boardId, objectId)!;
      const boardResult = await controller.openLink(boardLink);
      expect(boardResult.documentId).toBe(boardId);
      expect(boardResult.revealed).toBe(false);
    } finally {
      await app.dispose();
    }
  });
});

describe('link-resolution perf gate (: no per-keystroke rebuild)', () => {
  it('resolveResourceTarget is stateless: repeated calls return fresh equal results', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const mdId = await seedMarkdown(app, 'notes/Guide.md');
      const workspace = app.getWorkspace()!;
      const link = controller.copyLinkFor(mdId, 'getting-started')!;
      const target = parseResourceLink(link)!;
      expect(isResourceLinkTarget(target)).toBe(true);
      const first = resolveResourceTarget(workspace, target);
      expect(String(first?.ref.documentId)).toBe(mdId);
      // Each per-keystroke resolution re-reads workspace state and allocates
      // a fresh result wrapper: equal by value, never the same cached object,
      // with stable identity members. There is no module-level cache object
      // to invalidate and no listeners registered by this read path.
      const listSpy = vi.spyOn(workspace, 'listDocuments');
      for (let i = 0; i < 5; i += 1) {
        const again = resolveResourceTarget(workspace, target);
        expect(again).toEqual(first);
        expect(again).not.toBe(first);
        expect(String(again?.ref.documentId)).toBe(
          String(first?.ref.documentId),
        );
        expect(String(again?.ref.documentId)).toBe(mdId);
      }
      // Every call re-reads (nothing retained between keystrokes).
      expect(listSpy).toHaveBeenCalledTimes(5);
      listSpy.mockRestore();
      // Unknown targets stay null across repeats (no sticky partial state).
      // Both stable identities miss here: documentId AND the resourceId
      // fallback (identity rule), so nothing resolves.
      const missingLink = controller.copyLinkFor(mdId, 'getting-started')!;
      const missing = {
        ...parseResourceLink(missingLink)!,
        documentId: 'doc-missing',
        resourceId: 'res-missing',
      };
      expect(resolveResourceTarget(workspace, missing)).toBeNull();
      expect(resolveResourceTarget(workspace, missing)).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  it('documents the uncapped-validator divergence (: caps live at the parse boundary)', async () => {
    const { app, controller } = await makeLinkApp();
    try {
      const mdId = await seedMarkdown(app, 'notes/Guide.md');
      const workspace = app.getWorkspace()!;
      const link = controller.copyLinkFor(mdId, 'getting-started')!;
      const target = parseResourceLink(link)!;
      const overlong = {
        ...target,
        address: 'a'.repeat(MAX_LINK_ADDRESS_LENGTH + 1),
      };
      // Capped validators reject the over-long address (parse boundary).
      expect(isResourceLinkTarget(overlong)).toBe(false);
      expect(parseResourceLink(formatResourceLink(overlong))).toBeNull();
      // The uncapped resolver still resolves by stable identity (it validates
      // with plain isResourceTarget and carries the address verbatim); DoS
      // caps are enforced before this read path is ever reached.
      const resolved = resolveResourceTarget(workspace, overlong);
      expect(String(resolved?.ref.documentId)).toBe(mdId);
      expect(resolved?.address).toBe(overlong.address);
    } finally {
      await app.dispose();
    }
  });
});

describe('resolve-aware exact reveal (closes / gap)', () => {
  /**
   * Resolve-aware provider wiring (not blind capturing doubles): each seam
   * resolves the opaque verbatim address against the live canonical model
   * using production logic (`buildAddressIndex` for Markdown slugs, block /
   * page / object id existence otherwise) and records ONLY on hit. The
   * recorded `prefix:address` is the exact-target signal; `revealed:true`
   * from the controller confirms the seam exists. Unknown addresses record
   * nothing (handle-level fail-closed); the controller's `revealed` flag is
   * seam-existence-based until seam-boolean propagation lands (filed
   * follow-up, out of scope — hence unknown-address assertions below
   * check the record, not the flag).
   */
  function resolvingProvider(
    kindId: DocumentKindId,
    prefix: string,
    revealed: string[],
    resolves: (model: unknown, address: string) => boolean,
  ): DocumentEditorProvider {
    return {
      id: `t14-${prefix}`,
      kindIds: [kindId],
      createEditor(input: { session: DocumentSession; parent: unknown }) {
        const session = input.session as DocumentSession<{ raw?: string }>;
        return {
          focus() {
            /* test double: focus is unobserved */
          },
          hasFocus() {
            return false;
          },
          execCommand() {
            return false;
          },
          revealAddress(address: string) {
            if (typeof address !== 'string' || address === '') return;
            let model: unknown = null;
            try {
              model = (session as DocumentSession).model ?? null;
            } catch {
              return;
            }
            if (model !== null && resolves(model, address)) {
              revealed.push(`${prefix}:${address}`);
            }
          },
          destroy() {
            /* test double: nothing to tear down */
          },
        };
      },
    };
  }

  function markdownResolves(model: unknown, address: string): boolean {
    const raw =
      (model as { raw?: unknown }).raw !== undefined
        ? String((model as { raw?: unknown }).raw)
        : '';
    try {
      return buildAddressIndex(raw).has(address);
    } catch {
      return false;
    }
  }

  function blockPageResolves(model: unknown, address: string): boolean {
    const blocks = (model as BlockPageModel).blocks;
    return (
      typeof blocks === 'object' &&
      blocks !== null &&
      (blocks as Record<string, unknown>)[address] !== undefined
    );
  }

  function notebookResolves(model: unknown, address: string): boolean {
    const pages = (model as NotebookModel).pages;
    return (
      typeof pages === 'object' &&
      pages !== null &&
      (pages as Record<string, unknown>)[address] !== undefined
    );
  }

  function whiteboardResolves(model: unknown, address: string): boolean {
    const objects = (model as SurfaceModel).objects;
    return (
      typeof objects === 'object' &&
      objects !== null &&
      (objects as Record<string, unknown>)[address] !== undefined
    );
  }

  async function makeResolvingLinkApp() {
    const revealed: string[] = [];
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, blockPageKind, notebookKind, whiteboardKind],
      documentEditorProviders: [
        resolvingProvider(markdownKindId, 'markdown', revealed, markdownResolves),
        resolvingProvider(blockPageKindId, 'blockpage', revealed, blockPageResolves),
        resolvingProvider(notebookKindId, 'notebook', revealed, notebookResolves),
        resolvingProvider(whiteboardKindId, 'whiteboard', revealed, whiteboardResolves),
      ],
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    return { app, controller, revealed };
  }

  it('markdown: heading slug follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeResolvingLinkApp();
    try {
      const id = await seedMarkdown(app, 'notes/T14Guide.md');
      const link = controller.copyLinkFor(id, 'getting-started')!;
      const other = await seedMarkdown(app, 'notes/T14Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(result.revealed).toBe(true);
      expect(revealed).toContain('markdown:getting-started');
    } finally {
      await app.dispose();
    }
  });

  it('blockpage: block id follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeResolvingLinkApp();
    try {
      const { id, blockId } = await seedBlockPage(app, 'pages/t14-blocks.blockpage');
      const link = controller.copyLinkFor(id, blockId)!;
      const other = await seedMarkdown(app, 'notes/T14Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(result.revealed).toBe(true);
      expect(revealed).toContain(`blockpage:${blockId}`);
    } finally {
      await app.dispose();
    }
  });

  it('notebook: page id follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeResolvingLinkApp();
    try {
      const { id, pageId } = await seedNotebook(app, 'notes/t14-field.notebook');
      const link = controller.copyLinkFor(id, pageId)!;
      const other = await seedMarkdown(app, 'notes/T14Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(result.revealed).toBe(true);
      expect(revealed).toContain(`notebook:${pageId}`);
    } finally {
      await app.dispose();
    }
  });

  it('whiteboard: object id follows exact after reopen', async () => {
    const { app, controller, revealed } = await makeResolvingLinkApp();
    try {
      const { id, objectId } = await seedWhiteboard(app, 'boards/t14-ideas.whiteboard');
      const link = controller.copyLinkFor(id, objectId)!;
      const other = await seedMarkdown(app, 'notes/T14Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      revealed.length = 0;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(result.revealed).toBe(true);
      expect(revealed).toContain(`whiteboard:${objectId}`);
    } finally {
      await app.dispose();
    }
  });

  it('unknown addresses record nothing (handle-level fail-closed)', async () => {
    const { app, controller, revealed } = await makeResolvingLinkApp();
    try {
      const { id, blockId } = await seedBlockPage(app, 'pages/t14-unknown.blockpage');
      const { objectId } = await seedWhiteboard(app, 'boards/t14-unknown.whiteboard');
      void blockId;
      void objectId;
      const mdId = await seedMarkdown(app, 'notes/T14Unknown.md');
      const mdLink = controller.copyLinkFor(mdId, 'getting-started')!;
      const mdTarget = parseResourceLink(mdLink)!;
      // Unknown block id: resolve-aware seam records nothing.
      revealed.length = 0;
      controller.revealAddress('main', 'ghost-block');
      expect(revealed).not.toContain('blockpage:ghost-block');
      // Unknown object id: same degrade.
      controller.revealAddress('main', 'ghost-object');
      expect(revealed).not.toContain('whiteboard:ghost-object');
      // Unknown slug against a real markdown session: nothing recorded.
      await controller.openDocument(mdId, {}, { pane: 'main' });
      revealed.length = 0;
      controller.revealAddress('main', 'no-such-heading');
      expect(revealed).not.toContain('markdown:no-such-heading');
      // Unknown identity still throws (existing fail-closed contract kept).
      await expect(
        controller.openResourceTarget({
          ...mdTarget,
          documentId: 'missing',
          resourceId: 'missing',
        }),
      ).rejects.toThrow();
      void id;
    } finally {
      await app.dispose();
    }
  });

  it('background block/whiteboard reveals preserve focus and still record exact', async () => {
    const { app, controller, revealed } = await makeResolvingLinkApp();
    const mounting = mountLinkDestinations(controller);
    try {
      const sourceId = await seedMarkdown(app, 'notes/T14BgSrc.md');
      const { id: blockId, blockId: address } = await seedBlockPage(
        app,
        'pages/T14Bg.blockpage',
      );
      const { id: boardId, objectId } = await seedWhiteboard(
        app,
        'boards/T14Bg.whiteboard',
      );
      await controller.openDocument(sourceId, {}, { pane: 'main' });
      const beside = controller.splitPane('main', 'right');
      controller.focusPane('main');
      revealed.length = 0;
      const blockLink = controller.copyLinkFor(blockId, address)!;
      const blockResult = await controller.openResourceTarget(
        parseResourceLink(blockLink)!,
        { pane: beside, preserveFocus: true },
      );
      expect(blockResult.revealed).toBe(true);
      expect(controller.focusedPane).toBe('main');
      expect(revealed).toContain(`blockpage:${address}`);
      revealed.length = 0;
      const boardLink = controller.copyLinkFor(boardId, objectId)!;
      const boardResult = await controller.openResourceTarget(
        parseResourceLink(boardLink)!,
        { pane: beside, preserveFocus: true },
      );
      expect(boardResult.revealed).toBe(true);
      expect(controller.focusedPane).toBe('main');
      expect(revealed).toContain(`whiteboard:${objectId}`);
    } finally {
      mounting.mockRestore();
      await controller.dispose();
      await app.dispose();
    }
  });

  it('production whiteboard wiring reveals exact through the real provider', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, whiteboardKind],
      documentEditorProviders: [new WhiteboardDocumentEditorProvider()],
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    try {
      const { id, objectId } = await seedWhiteboard(app, 'boards/t14-prod.whiteboard');
      const link = controller.copyLinkFor(id, objectId)!;
      const other = await seedMarkdown(app, 'notes/T14ProdOther.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      const result = await controller.openLink(link);
      // Headless production seam (node env): resolve-only, exact on hit.
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(result.revealed).toBe(true);
      expect(controller.revealAddress('main', objectId)).toBe(true);
    } finally {
      await app.dispose();
    }
  });

  /**
   * Coverage split note: the suites above run in node, so the
   * production whiteboard provider mounts its headless resolve-only
   * handle here. The canvas `setSelection` path (exact select + `true`
   * on hit, selection untouched + `false` on unknown) is exercised in
   * the provider's own jsdom suite
   * (`packages/editor-whiteboard/src/reveal-address.spec.ts`), which
   * stubs canvas 2d and reads back `getSelectionIdsForTest`.
   */
  it('production blockpage wiring reveals exact through the real provider', async () => {
    const revealed: string[] = [];
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, blockPageKind],
      documentEditorProviders: [
        resolvingProvider(markdownKindId, 'markdown', revealed, markdownResolves),
      ],
      // Spec-only production wiring: no application→editor-blockpage prod
      // dep (see package.json devDependencies — mirrors the whiteboard
      // devDep pattern). In this node env the provider mounts its
      // headless boolean handle; the Tiptap scroll+highlight path is
      // covered in the provider's own jsdom suite.
      blockPageEditorProvider: new BlockPageDocumentEditorProvider(),
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    try {
      const { id, blockId } = await seedBlockPage(app, 'pages/t14-prod.blockpage');
      const link = controller.copyLinkFor(id, blockId)!;
      const other = await seedMarkdown(app, 'notes/T14ProdBlockOther.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(result.revealed).toBe(true);
      expect(controller.revealAddress('main', blockId)).toBe(true);
    } finally {
      await app.dispose();
    }
  });

  it('unknown block address with a boolean seam reports revealed:false and still opens', async () => {
    const revealed: string[] = [];
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, blockPageKind],
      documentEditorProviders: [
        resolvingProvider(markdownKindId, 'markdown', revealed, markdownResolves),
      ],
      blockPageEditorProvider: new BlockPageDocumentEditorProvider(),
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    try {
      const { id } = await seedBlockPage(app, 'pages/t14-unknown-seam.blockpage');
      const link = controller.copyLinkFor(id, 'ghost-block')!;
      const result = await controller.openLink(link);
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      // honesty: the boolean seam resolves false on unknown, and the
      // controller propagates it instead of over-reporting exact success.
      expect(result.revealed).toBe(false);
      // Document-open-only degrade: the document still opened.
      expect(
        controller.paneStates().find((pane) => pane.pane === 'main')?.documentId,
      ).toBe(id);
      expect(controller.revealAddress('main', 'ghost-block')).toBe(false);
    } finally {
      await app.dispose();
    }
  });
});
