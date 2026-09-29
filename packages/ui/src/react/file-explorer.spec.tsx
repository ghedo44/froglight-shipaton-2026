// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  InMemoryExternalFileDropService,
  memoryVaultPlugin,
  workspacePlugin,
  type ExternalFileDropService,
} from '@froglight/foundation';
import type { FileTreeNode } from '../file-tree.js';
import type { FileExplorerService } from '../file-explorer.js';
import { viewRegistryToken, viewRegistryPlugin } from '../view-registry.js';
import { fileExplorerPlugin } from '../file-explorer.js';
import { workspaceEvents } from '../ui-events.js';
import type { ViewDef } from '../view-registry.js';
import { FileExplorerView } from './FileExplorerView.jsx';
import { TEST_NOTE_KINDS } from '../testing/note-kind-options.js';
import { installWebviewDropGuard } from '../drop-guard.js';
import styles from './FileExplorer.module.css';
import { ViewSlot } from './ViewSlot.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Presentation selectors resolve through the CSS module object, so the
// specs track the component's own mapping instead of global class names.
// Identity hooks (datasets, aria labels) stay literal: they are the stable
// contract shared with the shell.
const row = `.${styles['tree-row']}`;
const activate = `.${styles['tree-activate']}`;
const folderRow = `${row}.${styles['tree-folder']}`;
const fileRow = `${row}.${styles['tree-file']}`;
const docFile = (id: string): string => `${fileRow}[data-document-id="${id}"]`;

const FIXTURE_TREE: readonly FileTreeNode[] = [
  {
    kind: 'folder',
    name: 'notes',
    path: 'notes',
    children: [
      {
        kind: 'file',
        name: 'welcome.md',
        path: 'notes/welcome.md',
        documentId: 'doc-1',
      },
    ],
  },
  {
    kind: 'file',
    name: 'todo.md',
    path: 'todo.md',
    documentId: 'doc-2',
  },
  { kind: 'file', name: 'clip.mp4', path: 'clip.mp4' },
];

function stubService(
  overrides: Partial<FileExplorerService> = {},
): FileExplorerService & { emit(): void } {
  const listeners = new Set<() => void>();
  return {
    tree: async () => FIXTURE_TREE,
    resolveRawFileLink: async () => null,
    creatableKinds: () => TEST_NOTE_KINDS,
    createFolder: async () => undefined,
    createNote: async () => 'doc-new',
    moveDocument: async () => undefined,
    duplicateDocument: async () => 'doc-duplicate',
    listTrash: () => [],
    restoreDocument: async () => 'doc-restored',
    permanentlyDeleteDocument: async () => undefined,
    moveFolder: async () => undefined,
    deleteDocument: async () => undefined,
    deleteFolder: async () => 0,
    importFile: async () => undefined,
    moveRawFile: async () => undefined,
    deleteRawFile: async () => undefined,
    readRawFile: async () => new Uint8Array(),
    createNotebookFromPdf: async () => 'doc-nb',
    createInkFromImage: async () => 'doc-ink',
    onDidChange(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    refresh() {
      for (const listener of [...listeners]) listener();
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountExplorer(
  service: FileExplorerService,
  externalDrop?: ExternalFileDropService | null,
): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(ViewSlot, {
        view: {
          id: 'file-explorer',
          area: 'sidebar',
          title: 'Files',
          component: () =>
            createElement(FileExplorerView, { service, externalDrop }),
        },
      }),
    );
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('file explorer React view (ViewSlot seam)', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'file-explorer',
      'explorer-header',
      'explorer-actions',
      'explorer-tree',
      'explorer-empty',
      'explorer-error-toast',
      'tree-row',
      'tree-folder',
      'tree-file',
      'tree-activate',
      'tree-caret',
      'tree-folder-icon',
      'tree-file-icon',
      'tree-label',
      'tree-children',
      'row-menu',
      'open',
      'active',
      'drop-target',
      'drop-beside',
      'dragging',
      'drop-root',
      'external-drop',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('renders New above the tree and a compact empty state', async () => {
    const mounted = await mountExplorer(stubService({ tree: async () => [] }));
    expect(
      mounted.querySelector(`.${styles['explorer-header']} .sidebar-heading`)
        ?.textContent,
    ).toBe('Documents');
    expect(mounted.querySelector('button[aria-label="New"]')).not.toBeNull();
    expect(mounted.querySelector('button[aria-label="Search workspace"]')).toBeNull();
    expect(
      mounted.querySelector(
        `.${styles['explorer-actions']} input[type="file"]`,
      ),
    ).not.toBeNull();
    expect(
      mounted.querySelector(`.${styles['explorer-empty']}`)?.textContent,
    ).toContain('No documents yet');
    expect(
      mounted.querySelector(`.${styles['explorer-empty']} button`),
    ).not.toBeNull();
  });

  it('opens a compact creation and import menu', async () => {
    const mounted = await mountExplorer(stubService());
    const newButton = mounted.querySelector<HTMLButtonElement>(
      'button[aria-label="New"]',
    )!;
    await act(async () => newButton.click());
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('New document');
    expect(menu?.textContent).not.toContain('Markdown');
    expect(menu?.textContent).not.toContain('Notebook');
    expect(menu?.textContent).toContain('New folder');
    expect(menu?.textContent).toContain('Import PDF as notebook');
    expect(menu?.textContent).toContain('Import image as ink');
    expect(menu?.textContent).toContain('Import file');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

  });

  it('renders folders and files with identity datasets and indentation', async () => {
    const mounted = await mountExplorer(stubService());
    const folder = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    );
    expect(folder).not.toBeNull();
    expect(folder?.dataset.kind).toBe('folder');
    expect(folder?.style.paddingLeft).toBe('0px');
    const file = mounted.querySelector<HTMLElement>(docFile('doc-2'));
    expect(file).not.toBeNull();
    expect(file?.dataset.path).toBe('todo.md');
    expect(file?.draggable).toBe(true);
    // Root files align after the folder caret.
    expect(file?.style.paddingLeft).toBe('16px');
    const raw = mounted.querySelector<HTMLElement>(
      `${fileRow}[data-path="clip.mp4"]:not([data-document-id])`,
    );
    expect(raw).not.toBeNull();
  });

  it('expands and collapses folders in place', async () => {
    const mounted = await mountExplorer(stubService());
    const folder = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    );
    expect(folder).not.toBeNull();
    expect(mounted.querySelector(docFile('doc-1'))).toBeNull();
    const toggle = folder!.querySelector<HTMLElement>(activate);
    expect(toggle?.tagName).toBe('BUTTON');
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(folder?.classList.contains(styles.open)).toBe(true);
    const child = mounted.querySelector<HTMLElement>(docFile('doc-1'));
    expect(child).not.toBeNull();
    expect(child?.style.marginLeft).toBe('28px');
    expect(child?.style.width).toBe('calc(100% - 30px)');
    expect(child?.style.paddingLeft).toBe('4px');
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(folder?.classList.contains(styles.open)).toBe(false);
    expect(mounted.querySelector(docFile('doc-1'))).toBeNull();
  });

  it('exposes folder toggles as buttons with expanded state', async () => {
    const mounted = await mountExplorer(stubService());
    const folder = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    );
    const toggle = folder!.querySelector<HTMLButtonElement>(activate);
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.type).toBe('button');
    // Native buttons are keyboard-focusable: Enter/Space activation follows
    // from platform semantics, so folders are operable without a pointer.
    expect(toggle?.tabIndex).toBe(0);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens a document on file click and marks it active', async () => {
    const mounted = await mountExplorer(stubService());
    const opened: string[] = [];
    mounted.addEventListener(workspaceEvents.open, (event) => {
      opened.push(
        (event as CustomEvent<{ documentId: string }>).detail.documentId,
      );
    });
    const file = mounted.querySelector<HTMLElement>(docFile('doc-2'));
    const target = file!.querySelector<HTMLElement>(activate);
    await act(async () => {
      target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toEqual(['doc-2']);
    expect(
      mounted
        .querySelector(docFile('doc-2'))
        ?.classList.contains(styles.active),
    ).toBe(true);
  });

  it('never nests interactive controls (hydration-safe)', async () => {
    const mounted = await mountExplorer(stubService());
    // Expand the folder so both folder and file rows render.
    const folder = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    );
    await act(async () => {
      folder!
        .querySelector(activate)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const rows = [...mounted.querySelectorAll<HTMLElement>(row)];
    expect(rows.length).toBeGreaterThan(0);
    for (const treeRow of rows) {
      // The row itself must not be a <button> nor carry a button role:
      // it hosts the menu <button> as a sibling of the activation target.
      expect(treeRow.tagName).not.toBe('BUTTON');
      expect(treeRow.getAttribute('role')).not.toBe('button');
      expect(treeRow.querySelectorAll('button button')).toHaveLength(0);
      // Exactly one dedicated activation target plus the sibling menu.
      const activators = treeRow.querySelectorAll(
        `:scope > button.${styles['tree-activate']}`,
      );
      expect(activators).toHaveLength(1);
      const menus = treeRow.querySelectorAll(
        `:scope > button.${styles['row-menu']}`,
      );
      expect(menus).toHaveLength(1);
      // The menu is a sibling of the activator, never its descendant.
      expect(activators[0]?.contains(menus[0] as Node)).toBe(false);
    }
  });

  it('activates files through a keyboard-focusable activation button', async () => {
    const mounted = await mountExplorer(stubService());
    const opened: string[] = [];
    mounted.addEventListener(workspaceEvents.open, (event) => {
      opened.push(
        (event as CustomEvent<{ documentId: string }>).detail.documentId,
      );
    });
    const file = mounted.querySelector<HTMLElement>(docFile('doc-2'));
    const target = file!.querySelector<HTMLButtonElement>(activate);
    expect(target?.tagName).toBe('BUTTON');
    expect(target?.type).toBe('button');
    // Native buttons are keyboard-focusable with platform Enter/Space
    // activation; no custom key handler is needed (or wanted — it would
    // double-fire alongside the native click).
    expect(target?.tabIndex).toBe(0);
    await act(async () => {
      target!.click();
    });
    expect(opened).toEqual(['doc-2']);
    // The active file stays marked on its activator for assistive tech.
    expect(target?.getAttribute('aria-current')).toBe('true');
  });

  it('forwards row-padding clicks to the activation target', async () => {
    const mounted = await mountExplorer(stubService());
    const opened: string[] = [];
    mounted.addEventListener(workspaceEvents.open, (event) => {
      opened.push(
        (event as CustomEvent<{ documentId: string }>).detail.documentId,
      );
    });
    // Clicking the container itself (padding/indent, not the button) still
    // opens exactly once; button clicks bubbling up must not double-fire.
    const file = mounted.querySelector<HTMLElement>(docFile('doc-2'))!;
    await act(async () => {
      file.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toEqual(['doc-2']);
    // Folder padding toggles the same way.
    const folder = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    )!;
    await act(async () => {
      folder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(folder.classList.contains(styles.open)).toBe(true);
  });

  it('opens the file in the background on middle-click', async () => {
    const mounted = await mountExplorer(stubService());
    const background: string[] = [];
    mounted.addEventListener(workspaceEvents.openBackground, (event) => {
      background.push(
        (event as CustomEvent<{ documentId: string }>).detail.documentId,
      );
    });
    const target = mounted
      .querySelector<HTMLElement>(docFile('doc-2'))!
      .querySelector<HTMLElement>(activate)!;
    await act(async () => {
      target.dispatchEvent(
        new MouseEvent('auxclick', { button: 1, bubbles: true }),
      );
    });
    expect(background).toEqual(['doc-2']);
  });

  it('does not open the file when its row-menu button is activated', async () => {
    const mounted = await mountExplorer(stubService());
    const opened: string[] = [];
    mounted.addEventListener(workspaceEvents.open, (event) => {
      opened.push(
        (event as CustomEvent<{ documentId: string }>).detail.documentId,
      );
    });
    const menu = mounted.querySelector<HTMLElement>(
      `${docFile('doc-2')} .${styles['row-menu']}`,
    );
    expect(menu?.tagName).toBe('BUTTON');
    // The menu stays independently keyboard-focusable.
    expect(menu?.tabIndex).toBe(0);
    await act(async () => {
      menu!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toEqual([]);
  });

  it('starts row drags with the node payload', async () => {
    const mounted = await mountExplorer(stubService());
    const file = mounted.querySelector<HTMLElement>(docFile('doc-2'))!;
    const seen: Array<[string, string]> = [];
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        setData: (mime: string, data: string) => void seen.push([mime, data]),
        effectAllowed: 'none' as string,
      },
    });
    await act(async () => {
      file.dispatchEvent(event);
    });
    const payload = seen.find(
      ([mime]) => mime === 'application/x-froglight-node',
    );
    expect(payload).toBeDefined();
    expect(JSON.parse(payload![1])).toMatchObject({
      path: 'todo.md',
      kind: 'file',
      documentId: 'doc-2',
    });
  });

  it('mirrors the shell active-document event onto rows', async () => {
    const mounted = await mountExplorer(stubService());
    await act(async () => {
      document.dispatchEvent(
        new CustomEvent(workspaceEvents.activeDocument, {
          detail: { documentId: 'doc-2', reveal: false },
        }),
      );
    });
    expect(
      mounted
        .querySelector(docFile('doc-2'))
        ?.classList.contains(styles.active),
    ).toBe(true);
  });

  it('refreshes rows when the service notifies', async () => {
    const service = stubService();
    const mounted = await mountExplorer(service);
    expect(mounted.querySelector(docFile('doc-2'))).not.toBeNull();
    service.tree = async () => [];
    await act(async () => {
      service.emit();
    });
    expect(
      mounted.querySelector(`.${styles['explorer-empty']}`),
    ).not.toBeNull();
  });

  it('file-explorer plugin registers a component-only view', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    await runtime.registerSlot({ id: 'views', plugin: viewRegistryPlugin });
    await runtime.registerSlot({
      id: 'file-explorer',
      plugin: fileExplorerPlugin,
    });
    let current = null as unknown as ViewDef | undefined;
    await runtime.registerSlot({
      id: 'file-explorer-probe',
      plugin: definePlugin({
        id: 'test.file-explorer-probe',
        requirements: { requires: [viewRegistryToken] },
        activate: (ctx) => {
          current = ctx.require(viewRegistryToken).get('file-explorer');
        },
      }),
    });
    expect(current?.component).toBeDefined();
    expect(current).not.toHaveProperty('render');
    await runtime.dispose();
  });
});

describe('file explorer external file drops (browser DataTransfer seam)', () => {
  function mockFile(name: string, bytes: Uint8Array): File {
    return {
      name,
      arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    } as unknown as File;
  }

  function dropTransfer(files: File[]): DataTransfer {
    return {
      types: ['Files'],
      files: files as unknown as FileList,
      getData: () => '',
      setData: () => undefined,
      dropEffect: 'none',
      effectAllowed: 'all',
    } as unknown as DataTransfer;
  }

  function dragOverTransfer(): DataTransfer {
    // WebKit protected phase: types carry Files while files stays empty.
    return {
      types: ['Files'],
      files: [] as unknown as FileList,
      getData: () => '',
      setData: () => undefined,
      dropEffect: 'none',
      effectAllowed: 'all',
    } as unknown as DataTransfer;
  }

  function internalTransfer(payload: unknown): DataTransfer {
    return {
      types: ['application/x-froglight-node'],
      files: [] as unknown as FileList,
      getData: (mime: string) =>
        mime === 'application/x-froglight-node' ? JSON.stringify(payload) : '',
      setData: () => undefined,
      dropEffect: 'none',
      effectAllowed: 'all',
    } as unknown as DataTransfer;
  }

  function dispatchDrop(target: Element, dataTransfer: DataTransfer): void {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(event);
  }

  function dispatchDragOver(target: Element, dataTransfer: DataTransfer): void {
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(event);
  }

  it('accepts dragover with types=["Files"] while files is empty (WebKit)', async () => {
    const mounted = await mountExplorer(stubService());
    const tree = mounted.querySelector(
      `.${styles['explorer-tree']}`,
    ) as HTMLElement;
    await act(async () => {
      dispatchDragOver(tree, dragOverTransfer());
    });
    expect(tree.classList.contains(styles['drop-root'])).toBe(true);
    expect(tree.classList.contains(styles['external-drop'])).toBe(true);
  });

  it('imports an external file dropped on the root', async () => {
    const imported: Array<{ folder: string; name: string }> = [];
    const service = stubService({
      importFile: async (folder: string, name: string) => {
        imported.push({ folder, name });
      },
    });
    const mounted = await mountExplorer(service);
    const tree = mounted.querySelector(
      `.${styles['explorer-tree']}`,
    ) as HTMLElement;
    await act(async () => {
      dispatchDrop(
        tree,
        dropTransfer([mockFile('hello.md', new Uint8Array([1]))]),
      );
    });
    // Let the async import + refresh settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(imported).toEqual([{ folder: '', name: 'hello.md' }]);
  });

  it('imports an external file dropped on a folder', async () => {
    const imported: Array<{ folder: string; name: string }> = [];
    const service = stubService({
      importFile: async (folder: string, name: string) => {
        imported.push({ folder, name });
      },
    });
    const mounted = await mountExplorer(service);
    const folderEl = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    );
    // Expand first so the folder row exists (it always renders at root).
    expect(folderEl).not.toBeNull();
    await act(async () => {
      dispatchDrop(
        folderEl!,
        dropTransfer([mockFile('photo.png', new Uint8Array([2]))]),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(imported).toEqual([{ folder: 'notes', name: 'photo.png' }]);
  });

  it("routes a file-row drop to the file's parent folder", async () => {
    const imported: Array<{ folder: string; name: string }> = [];
    const service = stubService({
      importFile: async (folder: string, name: string) => {
        imported.push({ folder, name });
      },
    });
    const mounted = await mountExplorer(service);
    // Expand notes so the child file row renders.
    const folderToggle = mounted
      .querySelector<HTMLElement>(`${folderRow}[data-path="notes"]`)!
      .querySelector(activate)!;
    await act(async () => {
      folderToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const child = mounted.querySelector<HTMLElement>(docFile('doc-1'))!;
    await act(async () => {
      dispatchDrop(
        child,
        dropTransfer([mockFile('sidecar.pdf', new Uint8Array([3]))]),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(imported).toEqual([{ folder: 'notes', name: 'sidecar.pdf' }]);
  });

  it('imports multiple external files in one drop', async () => {
    const imported: string[] = [];
    const service = stubService({
      importFile: async (_folder: string, name: string) => {
        imported.push(name);
      },
    });
    const mounted = await mountExplorer(service);
    const tree = mounted.querySelector(
      `.${styles['explorer-tree']}`,
    ) as HTMLElement;
    await act(async () => {
      dispatchDrop(
        tree,
        dropTransfer([
          mockFile('a.md', new Uint8Array([1])),
          mockFile('b.png', new Uint8Array([2])),
        ]),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(imported).toEqual(['a.md', 'b.png']);
  });

  it('continues after a partial import failure', async () => {
    const imported: string[] = [];
    const service = stubService({
      importFile: async (_folder: string, name: string) => {
        if (name === 'bad.md') throw new Error('decode blew up');
        imported.push(name);
      },
    });
    const mounted = await mountExplorer(service);
    const tree = mounted.querySelector(
      `.${styles['explorer-tree']}`,
    ) as HTMLElement;
    await act(async () => {
      dispatchDrop(
        tree,
        dropTransfer([
          mockFile('bad.md', new Uint8Array([9])),
          mockFile('good.md', new Uint8Array([7])),
        ]),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(imported).toEqual(['good.md']);
  });

  it('imports tree drops with the shell drop guard installed', async () => {
    // The window-level navigation guard (drop-guard.ts) must never break
    // the explorer's own import path: preventDefault without propagation
    // interference.
    const uninstall = installWebviewDropGuard(window);
    try {
      const imported: Array<{ folder: string; name: string }> = [];
      const service = stubService({
        importFile: async (folder: string, name: string) => {
          imported.push({ folder, name });
        },
      });
      const mounted = await mountExplorer(service);
      const tree = mounted.querySelector(
        `.${styles['explorer-tree']}`,
      ) as HTMLElement;
      await act(async () => {
        dispatchDrop(
          tree,
          dropTransfer([mockFile('guarded.md', new Uint8Array([1]))]),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(imported).toEqual([{ folder: '', name: 'guarded.md' }]);
    } finally {
      uninstall();
    }
  });

  it('keeps the internal node payload on the move path', async () => {
    const moved: Array<{ id: string; to: string }> = [];
    let imported = 0;
    const service = stubService({
      moveDocument: async (id: string, to: string) => {
        moved.push({ id, to });
      },
      importFile: async () => {
        imported += 1;
      },
    });
    const mounted = await mountExplorer(service);
    const tree = mounted.querySelector(
      `.${styles['explorer-tree']}`,
    ) as HTMLElement;
    await act(async () => {
      dispatchDrop(
        tree,
        internalTransfer({
          path: 'todo.md',
          kind: 'file',
          documentId: 'doc-2',
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(imported).toBe(0);
    // Dropping todo.md on the root is a no-op move (same name) → no call.
    expect(moved).toEqual([]);
    // Dropping into a real folder moves instead of importing.
    const folderRowEl = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    )!;
    await act(async () => {
      dispatchDrop(
        folderRowEl,
        internalTransfer({
          path: 'todo.md',
          kind: 'file',
          documentId: 'doc-2',
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(moved).toEqual([{ id: 'doc-2', to: 'notes/todo.md' }]);
    expect(imported).toBe(0);
  });
});

describe('file explorer native file-drop source (froglight.file-drop seam)', () => {
  function mockHit(element: Element | null): void {
    const doc = document as Document & {
      elementFromPoint?: (x: number, y: number) => Element | null;
    };
    if (typeof doc.elementFromPoint !== 'function') {
      Object.defineProperty(doc, 'elementFromPoint', {
        value: vi.fn(),
        configurable: true,
        writable: true,
      });
    }
    const mock = vi.mocked(
      doc.elementFromPoint as (...args: unknown[]) => Element | null,
    );
    mock.mockReset();
    mock.mockReturnValueOnce(element);
  }

  function nativeFile(name: string, bytes: Uint8Array) {
    return {
      name,
      readBytes: async () => bytes,
    };
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('imports a native drop on a folder row into that folder', async () => {
    const imported: Array<{ folder: string; name: string }> = [];
    const service = stubService({
      importFile: async (folder: string, name: string) => {
        imported.push({ folder, name });
      },
    });
    const drop = new InMemoryExternalFileDropService();
    const mounted = await mountExplorer(service, drop);
    const folderEl = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    )!;
    mockHit(folderEl);
    await act(async () => {
      drop.emit({
        type: 'drop',
        position: { x: 10, y: 10 },
        files: [nativeFile('native.pdf', new Uint8Array([1]))],
      });
    });
    await settle();
    expect(imported).toEqual([{ folder: 'notes', name: 'native.pdf' }]);
  });

  it("routes a native drop on a file row to the file's parent", async () => {
    const imported: Array<{ folder: string; name: string }> = [];
    const service = stubService({
      importFile: async (folder: string, name: string) => {
        imported.push({ folder, name });
      },
    });
    const drop = new InMemoryExternalFileDropService();
    const mounted = await mountExplorer(service, drop);
    // Expand notes so the child file row renders.
    const toggle = mounted
      .querySelector<HTMLElement>(`${folderRow}[data-path="notes"]`)!
      .querySelector(activate)!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const child = mounted.querySelector<HTMLElement>(docFile('doc-1'))!;
    mockHit(child);
    await act(async () => {
      drop.emit({
        type: 'drop',
        position: { x: 10, y: 10 },
        files: [nativeFile('sidecar.png', new Uint8Array([2]))],
      });
    });
    await settle();
    expect(imported).toEqual([{ folder: 'notes', name: 'sidecar.png' }]);
  });

  it('routes a native drop on tree whitespace to the vault root', async () => {
    const imported: Array<{ folder: string; name: string }> = [];
    const service = stubService({
      importFile: async (folder: string, name: string) => {
        imported.push({ folder, name });
      },
    });
    const drop = new InMemoryExternalFileDropService();
    const mounted = await mountExplorer(service, drop);
    const tree = mounted.querySelector(`.${styles['explorer-tree']}`)!;
    mockHit(tree);
    await act(async () => {
      drop.emit({
        type: 'drop',
        position: { x: 5, y: 300 },
        files: [nativeFile('root.md', new Uint8Array([3]))],
      });
    });
    await settle();
    expect(imported).toEqual([{ folder: '', name: 'root.md' }]);
  });

  it('rejects native drops outside the explorer', async () => {
    let imported = 0;
    const released: string[] = [];
    const service = stubService({
      importFile: async () => {
        imported += 1;
      },
    });
    const drop = new InMemoryExternalFileDropService({
      resolver: {
        readBytes: async () => new Uint8Array([1]),
        release: (token: string) => void released.push(token),
      },
    });
    await mountExplorer(service, drop);
    const outside = document.createElement('div');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    try {
      mockHit(outside);
      await act(async () => {
        drop.emit({
          type: 'drop',
          position: { x: 9999, y: 9999 },
          files: [
            {
              name: 'nope.md',
              readBytes: async () => new Uint8Array([4]),
              release: () => void released.push('rejected'),
            },
          ],
        });
      });
      await settle();
      expect(imported).toBe(0);
      // Rejected native handles release instead of leaking permissions.
      expect(released).toEqual(['rejected']);
    } finally {
      outside.remove();
    }
  });

  it('drives the same drop-target visuals for native enter/over', async () => {
    const service = stubService();
    const drop = new InMemoryExternalFileDropService();
    const mounted = await mountExplorer(service, drop);
    const folderEl = mounted.querySelector<HTMLElement>(
      `${folderRow}[data-path="notes"]`,
    )!;
    mockHit(folderEl);
    await act(async () => {
      drop.emit({ type: 'enter', position: { x: 10, y: 10 } });
    });
    expect(folderEl.classList.contains(styles['drop-target'])).toBe(true);
    mockHit(folderEl);
    await act(async () => {
      drop.emit({ type: 'over', position: { x: 11, y: 11 } });
    });
    expect(folderEl.classList.contains(styles['drop-target'])).toBe(true);
    await act(async () => {
      drop.emit({ type: 'leave' });
    });
    expect(folderEl.classList.contains(styles['drop-target'])).toBe(false);
  });

  it('stops delivering after the view unmounts (dispose)', async () => {
    let imported = 0;
    const service = stubService({
      importFile: async () => {
        imported += 1;
      },
    });
    const drop = new InMemoryExternalFileDropService();
    await mountExplorer(service, drop);
    unmount();
    // No hit mock needed: the disposed listener never reaches
    // elementFromPoint, so nothing may import after unmount.
    drop.emit({
      type: 'drop',
      position: { x: 1, y: 1 },
      files: [nativeFile('late.md', new Uint8Array([5]))],
    });
    await settle();
    expect(imported).toBe(0);
  });

  it('imports native files through the shared candidate seam (partial failure)', async () => {
    const imported: string[] = [];
    const service = stubService({
      importFile: async (_folder: string, name: string) => {
        if (name === 'bad.md') throw new Error('nope');
        imported.push(name);
      },
    });
    const drop = new InMemoryExternalFileDropService();
    const mounted = await mountExplorer(service, drop);
    const tree = mounted.querySelector(`.${styles['explorer-tree']}`)!;
    mockHit(tree);
    await act(async () => {
      drop.emit({
        type: 'drop',
        position: { x: 1, y: 1 },
        files: [
          nativeFile('bad.md', new Uint8Array([9])),
          nativeFile('good.md', new Uint8Array([7])),
        ],
      });
    });
    await settle();
    // Both candidates reach importFile (one fails inside the service);
    // the shared seam keeps the good file.
    expect(imported).toEqual(['good.md']);
  });
});
