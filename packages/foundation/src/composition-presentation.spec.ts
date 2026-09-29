import { expect, it } from 'vitest';
import {
  InMemoryCompositionPresentationRegistry,
  type CompositionPresenter,
  type CompositionSnapshot,
} from './composition.js';

it('replaces presenters for live slots and releases every owned mount', () => {
  const registry = new InMemoryCompositionPresentationRegistry();
  const snapshot: CompositionSnapshot = {
    state: 'ready',
    presentation: { type: 'example.view', data: { value: 1 } },
  };
  let live = 0;
  let unavailable = 0;
  let updated = 0;
  const presenter: CompositionPresenter = {
    mount: () => {
      live++;
      return {
        update: () => {
          updated++;
        },
        dispose: () => {
          live--;
        },
      };
    },
  };
  const slot = registry.mount({
    parent: {},
    snapshot,
    readOnly: false,
    invoke: async () => undefined,
    onUnavailable: () => {
      unavailable++;
    },
  });
  expect(live).toBe(0);
  expect(unavailable).toBe(1);
  const first = registry.register('example', presenter);
  expect(live).toBe(1);
  slot?.update(snapshot, true);
  expect(updated).toBe(1);
  first.dispose();
  expect(live).toBe(0);
  expect(unavailable).toBe(2);
  const second = registry.register('example', presenter);
  first.dispose();
  expect(live).toBe(1);
  slot?.dispose();
  expect(live).toBe(0);
  second.dispose();
  expect(live).toBe(0);
});

it('selects a new presenter when a live slot changes presentation type', () => {
  const registry = new InMemoryCompositionPresentationRegistry();
  const mounts: string[] = [];
  const disposals: string[] = [];
  for (const type of ['alpha', 'beta'])
    registry.register(type, {
      mount: ({ snapshot }) => {
        if (snapshot.state !== 'ready' || snapshot.presentation?.type !== type)
          return null;
        mounts.push(type);
        return {
          update: () => undefined,
          dispose: () => {
            disposals.push(type);
          },
        };
      },
    });
  const slot = registry.mount({
    parent: {},
    readOnly: false,
    invoke: async () => undefined,
    snapshot: { state: 'ready', presentation: { type: 'alpha', data: {} } },
  });
  slot?.update(
    { state: 'ready', presentation: { type: 'beta', data: {} } },
    false,
  );
  expect(mounts).toEqual(['alpha', 'beta']);
  expect(disposals).toEqual(['alpha']);
  slot?.dispose();
  expect(disposals).toEqual(['alpha', 'beta']);
});
