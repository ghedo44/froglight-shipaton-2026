// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  documentKindId,
  InMemoryDocumentEditorRegistry,
  InMemoryDocumentRegistry,
  PropertyCatalog,
  type DatabaseController,
  type DocumentEditorHandle,
  type DocumentEditorProvider,
  type DocumentSession,
} from '@froglight/foundation';
import { DatabaseTemplateCreator } from './DatabaseTemplateCreator.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{
  root: ReturnType<typeof createRoot>;
  host: HTMLElement;
}> = [];

afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount());
    item.host.remove();
  }
});

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setup(withExisting = false) {
  const kindId = documentKindId('example.template-editor');
  const documents = new InMemoryDocumentRegistry();
  documents.register({
    id: kindId,
    creation: {
      label: 'Example document',
      extension: '.example',
      createInitialModel: (title) => ({ body: title }),
    },
    cloneTemplate: (model: { body: string }) => ({ ...model }),
    decode: () => ({ model: { body: '' }, metadata: {}, relationships: [] }),
    encode: () => new Uint8Array(),
  });
  const model = createDatabase('Research');
  model.properties.push({ id: 'status', name: 'Status', type: 'text' });
  if (withExisting) {
    model.templates.push({
      id: 'existing-template',
      name: 'Existing',
      kindId,
      model: { body: 'Stored content' },
      defaults: { status: 'Draft' },
    });
  }
  const saveTemplate = vi.fn(async () => undefined);
  const createMember = vi.fn(async () => undefined);
  const controller = {
    model,
    properties: { catalog: new PropertyCatalog() },
    saveTemplate,
    createMember,
  } as unknown as DatabaseController;
  const mutate = vi.fn(async (operation: () => Promise<unknown>) => {
    await operation();
  });
  const editors = new InMemoryDocumentEditorRegistry();
  const destroy = vi.fn();
  const flush = vi.fn();
  const contexts: unknown[] = [];
  const sessions: DocumentSession[] = [];
  const provider = {
    id: 'example.editor',
    kindIds: [kindId],
    createEditor({ session, parent, context }) {
      contexts.push(context);
      sessions.push(session);
      const host = parent as HTMLElement;
      const textarea = document.createElement('textarea');
      textarea.setAttribute('aria-label', 'Provider template content');
      textarea.value = (session.model as { body: string }).body;
      textarea.addEventListener('input', () => {
        (session.model as { body: string }).body = textarea.value;
        session.markDirty();
      });
      host.append(textarea);
      return {
        focus: () => textarea.focus(),
        hasFocus: () => document.activeElement === textarea,
        execCommand: () => false,
        flush,
        destroy: () => {
          destroy();
          textarea.remove();
        },
      } satisfies DocumentEditorHandle;
    },
  } satisfies DocumentEditorProvider;
  const registration = editors.register(provider);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const render = () =>
    root.render(
      <DatabaseTemplateCreator
        controller={controller}
        disabled={false}
        mutate={mutate}
        documents={documents}
        editors={editors}
        relationChoices={{}}
      />,
    );
  return {
    controller,
    contexts,
    createMember,
    destroy,
    documents,
    editors,
    flush,
    host,
    kindId,
    mutate,
    provider,
    registration,
    render,
    root,
    saveTemplate,
    sessions,
  };
}

describe('database template authoring', () => {
  it('saves provider-authored content and staged defaults without creating a document', async () => {
    const env = setup();
    await act(async () => env.render());
    const name = env.host.querySelector<HTMLInputElement>('input[required]')!;
    await act(async () => setInput(name, 'Research note'));
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Customize template')!
        .click(),
    );
    expect(env.contexts).toEqual([
      expect.objectContaining({
        kind: 'template',
        templateId: expect.any(String),
      }),
    ]);
    const content = env.host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Provider template content"]',
    )!;
    await act(async () => {
      content.value = 'Provider-authored body';
      content.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(env.host.textContent).toContain('Unsaved content');
    await expect(env.sessions[0]!.save()).resolves.toMatchObject({
      committed: true,
    });
    expect(env.saveTemplate).not.toHaveBeenCalled();
    expect(env.createMember).not.toHaveBeenCalled();
    const defaultInput = env.host.querySelector<HTMLInputElement>(
      'input[aria-label="Status"]',
    )!;
    await act(async () => {
      defaultInput.focus();
      setInput(defaultInput, 'In review');
      defaultInput.blur();
    });
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Save template')!
        .click(),
    );
    expect(env.flush).toHaveBeenCalledOnce();
    expect(env.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Research note',
        kindId: env.kindId,
        model: { body: 'Provider-authored body' },
        defaults: { status: 'In review' },
      }),
    );
    expect(env.createMember).not.toHaveBeenCalled();
  });

  it('saves edits to an existing template under the same identity', async () => {
    const env = setup(true);
    await act(async () => env.render());
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Edit')!
        .click(),
    );
    const content = env.host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Provider template content"]',
    )!;
    await act(async () => {
      content.value = 'Updated content';
      content.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Save template')!
        .click(),
    );
    expect(env.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'existing-template',
        model: { body: 'Updated content' },
        defaults: { status: 'Draft' },
      }),
    );
    expect(env.createMember).not.toHaveBeenCalled();
  });

  it('disposes a cancelled draft without mutating stored content', async () => {
    const env = setup(true);
    await act(async () => env.render());
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Edit')!
        .click(),
    );
    expect(
      env.host.querySelector<HTMLTextAreaElement>(
        '[aria-label="Provider template content"]',
      )?.value,
    ).toBe('Stored content');
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Cancel')!
        .click(),
    );
    expect(env.destroy).toHaveBeenCalledOnce();
    expect(env.sessions[0]?.state).toBe('closed');
    expect(env.saveTemplate).not.toHaveBeenCalled();
    expect(env.controller.model.templates[0]?.model).toEqual({
      body: 'Stored content',
    });
  });

  it('withdraws the provider cleanly and blocks saving instead of falling back', async () => {
    const env = setup();
    await act(async () => env.render());
    await act(async () =>
      setInput(
        env.host.querySelector<HTMLInputElement>('input[required]')!,
        'Draft',
      ),
    );
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Customize template')!
        .click(),
    );
    await act(async () => env.registration.dispose());
    expect(env.destroy).toHaveBeenCalledOnce();
    expect(env.host.textContent).toContain('Editor unavailable');
    expect(
      [...env.host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Save template',
      )?.disabled,
    ).toBe(true);
    expect(env.saveTemplate).not.toHaveBeenCalled();
  });

  it('reactivates one provider over the same unsaved draft without duplicate callbacks', async () => {
    const env = setup();
    await act(async () => env.render());
    await act(async () =>
      setInput(
        env.host.querySelector<HTMLInputElement>('input[required]')!,
        'Draft',
      ),
    );
    await act(async () =>
      [...env.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Customize template')!
        .click(),
    );
    const content = env.host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Provider template content"]',
    )!;
    await act(async () => {
      content.value = 'Unsaved plugin content';
      content.dispatchEvent(new Event('input', { bubbles: true }));
      env.registration.dispose();
    });
    expect(env.destroy).toHaveBeenCalledOnce();

    await act(async () => {
      env.editors.register(env.provider);
    });
    expect(env.contexts).toHaveLength(2);
    expect(env.sessions).toHaveLength(2);
    expect(
      env.host.querySelectorAll('[aria-label="Provider template content"]'),
    ).toHaveLength(1);
    expect(
      env.host.querySelector<HTMLTextAreaElement>(
        '[aria-label="Provider template content"]',
      )?.value,
    ).toBe('Unsaved plugin content');
    expect(env.saveTemplate).not.toHaveBeenCalled();
  });
});
