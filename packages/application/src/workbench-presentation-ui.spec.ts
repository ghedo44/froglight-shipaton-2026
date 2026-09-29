// @vitest-environment jsdom
// Exercise the public mount without adding React as an application dependency.
async function act(run: () => Promise<void>) {
  await run();
}
import { afterEach, expect, it } from 'vitest';
import {
  InMemorySearchService,
  latexKind,
  latexKindId,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  type DocumentSession,
  type LaTeXModel,
  type MarkdownModel,
  type DocumentEditorProvider,
  type DocumentReaderProvider,
} from '@froglight/foundation';
import { installDefaultUi, mountFroglightApp } from '@froglight/ui';
import { createApp, createWorkbenchController } from './index.js';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  document.body.replaceChildren();
});

it('real workspace clicks Edit → Split → View, preserves unsaved session and gates non-LaTeX modes', async () => {
  const sessions: DocumentSession<LaTeXModel | MarkdownModel>[] = [];
  const editor: DocumentEditorProvider = {
    id: 'presentation-test-editor',
    kindIds: [latexKindId, markdownKindId],
    createEditor({ session, parent }) {
      const textSession = session as DocumentSession<LaTeXModel | MarkdownModel>;
      sessions.push(textSession);
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Test source');
      input.value = textSession.model.raw;
      input.oninput = () => {
        (textSession.model as { raw: string }).raw = input.value;
        textSession.markDirty();
      };
      (parent as HTMLElement).append(input);
      return {
        focus: () => input.focus(),
        hasFocus: () => document.activeElement === input,
        execCommand: () => false,
        setReadOnly: (value) => {
          input.readOnly = value;
        },
        destroy: () => input.remove(),
      };
    },
  };
  const reader: DocumentReaderProvider = {
    id: 'presentation-test-reader',
    kindIds: [latexKindId, markdownKindId],
    createReader({ session, parent }) {
      const output = document.createElement('output');
      const update = () => {
        output.textContent = (session.model as LaTeXModel | MarkdownModel).raw;
      };
      (parent as HTMLElement).append(output);
      update();
      return { update, destroy: () => output.remove() };
    },
  };
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind, latexKind],
    documentEditorProviders: [editor],
    documentReaderProviders: [reader],
  });
  const controller = createWorkbenchController(app);
  const ui = await installDefaultUi(app.runtime);
  const root = document.createElement('div');
  document.body.append(root);
  const choice = {
    id: 'test',
    name: 'Presentation vault',
    location: 'Memory',
    activate: async () => undefined,
  };
  let mount: Awaited<ReturnType<typeof mountFroglightApp>>;
  await act(async () => {
    mount = await mountFroglightApp(
      root,
      controller,
      {
        listRecent: async () => [choice],
        openForBackup: async () => { throw new Error('Backup is outside this fixture'); },
        chooseCreateLocation: async () => null,
        openVault: async () => choice,
        forgetVault: async () => undefined,
      },
      ui,
    );
  });
  dispose = async () => {
    await act(async () => {
      await mount.dispose();
    });
    await app.dispose();
  };
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  async function click(element: Element | null) {
    expect(element).not.toBeNull();
    await act(async () => {
      (element as HTMLElement).click();
    });
    await settle();
  }
  await expect
    .poll(() => root.querySelector('[class*="recent-vault-card"]'))
    .not.toBeNull();
  await click(root.querySelector('[class*="recent-vault-card"]'));
  await settle();
  await act(async () => {
    await controller.createAndOpen('Paper.tex', undefined, {
      kindId: latexKindId,
    });
  });
  await settle();
  const group = () =>
    root.querySelector('[role="group"][aria-label="Document presentation"]');
  const mode = (label: string) =>
    [...(group()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === label,
    ) ?? null;
  expect(group(), 'visible shared mode selector').not.toBeNull();
  expect(
    [...group()!.querySelectorAll('button')].map((b) => b.textContent),
  ).toEqual(['Edit', 'Split', 'View']);
  await click(mode('Edit'));
  const source = root.querySelector('textarea')!;
  await act(async () => {
    source.value = 'Unsaved source';
    source.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const session = sessions.at(-1);
  await click(mode('Split'));
  expect(controller.tabMode('main')).toBe('split');
  expect(
    root.querySelector<HTMLElement>('.fl-pane-editor')!.style.display,
  ).toBe('flex');
  expect(
    root.querySelector('[aria-label="Document preview"] output')?.textContent,
  ).toBe('Unsaved source');
  expect(mode('Split')?.getAttribute('aria-pressed')).toBe('true');
  await click(mode('View'));
  expect(controller.tabMode('main')).toBe('reading');
  expect(
    root.querySelector<HTMLElement>('.fl-pane-editor')!.style.display,
  ).toBe('none');
  expect(root.querySelector('output')?.textContent).toBe('Unsaved source');
  await click(mode('Edit'));
  expect(sessions.at(-1)).toBe(session);
  expect(root.querySelector('textarea')?.value).toBe('Unsaved source');
  expect(controller.paneStates()[0]?.dirty).toBe(true);
  await act(async () => {
    await controller.createAndOpen('Note.md');
  });
  await settle();
  expect(
    [...group()!.querySelectorAll('button')].map((b) => b.textContent),
  ).toEqual(['Edit', 'View']);
  await click(mode('View'));
  expect(controller.tabMode('main')).toBe('reading');
  await click(mode('Edit'));
  expect(controller.tabMode('main')).toBe('edit');
});
