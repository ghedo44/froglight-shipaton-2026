/**
 * Tests for the unified toolbar placement registry.
 *
 * Pins the repository lifecycle invariant (activate → one registration,
 * dispose → zero, reactivate → one), same-id shadow-and-restore, deterministic
 * ordering independent of registration order, kind/when filtering, and change
 * notifications.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  createToolbarPlacementRegistry,
  documentToolbarPlacementPlugin,
  documentToolbarPlacementToken,
} from './placement-registry.js';
import type { DocumentToolbarContext } from '../document-toolbar-registry.js';

function context(kindId: string): DocumentToolbarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId,
    editor: { context: 'Paragraph', controls: [] },
  };
}

describe('ToolbarPlacementRegistry', () => {
  it('register → one; dispose → zero; reactivate → one', async () => {
    const runtime = new Runtime();
    const capturedRef: {
      current: ReturnType<
        typeof createToolbarPlacementRegistry
      >['registry'] | null;
    } = { current: null };
    const owner = definePlugin({
      id: 'test.placement-owner',
      requirements: { requires: [documentToolbarPlacementToken] },
      activate: (ctx) => {
        const registry = ctx.require(documentToolbarPlacementToken);
        capturedRef.current = registry;
        ctx.effect(
          () =>
            registry.register({
              id: 'test.history',
              anchor: 'float.top-left',
              controlIds: [],
            }).dispose,
        );
      },
    });

    await runtime.registerSlot({
      id: 'document-toolbar-placement',
      plugin: documentToolbarPlacementPlugin,
      config: {},
    });
    await runtime.registerSlot({ id: 'placement-owner', plugin: owner });
    expect(
      capturedRef.current?.placementsFor(context('froglight.ink')).length,
    ).toBe(1);

    await runtime.removeSlot('placement-owner');
    expect(
      capturedRef.current?.placementsFor(context('froglight.ink')),
    ).toEqual([]);

    await runtime.registerSlot({ id: 'placement-owner', plugin: owner });
    expect(
      capturedRef.current?.placementsFor(context('froglight.ink')).length,
    ).toBe(1);
    await runtime.dispose();
  });

  it('a same-id registration shadows the previous; disposing the replacement restores it', () => {
    const { registry } = createToolbarPlacementRegistry();
    const firstHandle = registry.register({
      id: 'shared',
      anchor: 'topbar-center',
      controlIds: ['a'],
    });
    const secondHandle = registry.register({
      id: 'shared',
      anchor: 'float.top-center',
      controlIds: ['b'],
    });

    expect(
      registry.placementsFor(context('froglight.ink')).map((p) => p.anchor),
    ).toEqual(['float.top-center']);
    secondHandle.dispose();
    expect(
      registry.placementsFor(context('froglight.ink')).map((p) => p.anchor),
    ).toEqual(['topbar-center']);
    firstHandle.dispose();
    expect(registry.placementsFor(context('froglight.ink'))).toEqual([]);
  });

  it('orders placements deterministically independent of registration order', () => {
    const { registry } = createToolbarPlacementRegistry();
    registry.register({
      id: 'b-second',
      anchor: 'topbar-center',
      order: 20,
      controlIds: [],
    });
    registry.register({
      id: 'a-first',
      anchor: 'topbar-center',
      order: 5,
      controlIds: [],
    });
    registry.register({
      id: 'c-tied',
      anchor: 'topbar-center',
      order: 20,
      controlIds: [],
    });

    expect(
      registry.placementsFor(context('froglight.ink')).map((p) => p.id),
    ).toEqual(['a-first', 'b-second', 'c-tied']);
  });

  it('filters by kindIds and when predicates', () => {
    const { registry } = createToolbarPlacementRegistry();
    registry.register({
      id: 'ink-only',
      kindIds: ['froglight.ink'],
      anchor: 'topbar-center',
      controlIds: ['ink.tool'],
    });
    registry.register({
      id: 'conditional',
      anchor: 'float.top-center',
      controlIds: ['markdown.bold'],
      when: ({ editor }) => editor?.context === 'Markdown heading 2',
    });

    // ink context has Paragraph, so conditional (heading-only) is excluded.
    expect(
      registry.placementsFor(context('froglight.ink')).map((p) => p.id),
    ).toEqual(['ink-only']);
    expect(
      registry
        .placementsFor({
          pane: 'main',
          documentId: 'doc-1',
          kindId: 'froglight.markdown',
          editor: { context: 'Markdown heading 2', controls: [] },
        })
        .map((p) => p.id),
    ).toEqual(['conditional']);
  });

  it('notifies listeners on membership changes until the listener is disposed', () => {
    const { registry } = createToolbarPlacementRegistry();
    const events: string[] = [];
    const subscription = registry.onDidChange(() => events.push('change'));

    const handle = registry.register({
      id: 'a',
      anchor: 'topbar-center',
      controlIds: [],
    });
    expect(events).toEqual(['change']);
    handle.dispose();
    expect(events).toEqual(['change', 'change']);

    subscription.dispose();
    registry.register({ id: 'b', anchor: 'topbar-center', controlIds: [] });
    expect(events).toEqual(['change', 'change']);
  });
});
