// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newResourceId } from '@froglight/foundation';
import { DatabaseRelationPicker } from './DatabaseRelationPicker.js';
import { databasePropertyActionHref } from './DatabaseDocumentProperties.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('database document property interactions', () => {
  it('loads bounded relation pages on demand and searches through the provider', async () => {
    const choices = Array.from({ length: 60 }, (_, index) => ({
      id: newResourceId(),
      title: `Related ${String(index + 1).padStart(2, '0')}`,
    }));
    const signals: AbortSignal[] = [];
    const loadChoices = vi.fn(
      async (
        search: string,
        selected: readonly string[],
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        const matches = choices.filter((choice) =>
          choice.title.includes(search),
        );
        return {
          choices: matches.slice(0, 50),
          selected: choices.filter((choice) => selected.includes(choice.id)),
          hasMore: matches.length > 50,
        };
      },
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <DatabaseRelationPicker
          label="References"
          value={[]}
          busy={false}
          lookupScope="provider-a"
          loadChoices={loadChoices}
          onWrite={() => undefined}
        />,
      );
    });

    expect(loadChoices).not.toHaveBeenCalled();
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(loadChoices).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(50);
    expect(host.textContent).toContain('Showing the first 50 results');

    const search = host.querySelector<HTMLInputElement>('input[type="search"]');
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (!search || !valueSetter) throw new Error('Search input unavailable');
    await act(async () => {
      valueSetter.call(search, 'Related 60');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(host.textContent).toContain('Related 60');
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(loadChoices).toHaveBeenLastCalledWith(
      'Related 60',
      [],
      expect.any(AbortSignal),
    );
  });

  it('cancels stale lookups and retains unresolved selections on provider switch', async () => {
    const unresolved = newResourceId();
    type RelationLoader = Parameters<
      typeof DatabaseRelationPicker
    >[0]['loadChoices'];
    type RelationPage = Awaited<ReturnType<RelationLoader>>;
    let resolveFirst: ((value: RelationPage) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const first: RelationLoader = (_search, _selected, signal) => {
      firstSignal = signal;
      return new Promise<RelationPage>((resolve) => {
        resolveFirst = resolve;
      });
    };
    const second = vi.fn(async () => ({
      choices: [],
      selected: [],
      hasMore: false,
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const render = async (scope: string, loadChoices: RelationLoader) =>
      act(async () => {
        root?.render(
          <DatabaseRelationPicker
            label="References"
            value={[unresolved]}
            busy={false}
            lookupScope={scope}
            loadChoices={loadChoices}
            onWrite={() => undefined}
          />,
        );
      });

    await render('provider-a', first);
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(firstSignal?.aborted).toBe(false);
    await render('provider-b', second);
    expect(firstSignal?.aborted).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(`Unavailable resource (${unresolved})`);

    await act(async () => {
      resolveFirst?.({
        choices: [{ id: newResourceId(), title: 'Stale provider result' }],
        selected: [],
        hasMore: false,
      });
    });
    expect(host.textContent).not.toContain('Stale provider result');
  });

  it('creates actions only for safe URL, email, and phone values', () => {
    expect(databasePropertyActionHref('url', 'froglight.app/docs')).toBe(
      'https://froglight.app/docs',
    );
    expect(databasePropertyActionHref('url', 'javascript:alert(1)')).toBeNull();
    expect(databasePropertyActionHref('email', 'notes@example.com')).toBe(
      'mailto:notes@example.com',
    );
    expect(
      databasePropertyActionHref('email', 'notes@example.com?body=unsafe'),
    ).toBeNull();
    expect(databasePropertyActionHref('phone', '+39 (02) 123-456')).toBe(
      'tel:+3902123456',
    );
  });
});
