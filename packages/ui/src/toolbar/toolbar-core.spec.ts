/**
 * Toolbar core review fixes (slice 1): ownership, groups, history placement,
 * single computation metadata, and responsive compaction.
 *
 * - One semantic id has exactly one visual/execution owner (provider >
 *   shell > contribution); duplicates never hijack execution.
 * - Placement groups survive with id/anchor/order/priority/compact.
 * - Priority + compact affect observable responsive output via the pure
 *   planner (no second full-width row, group boundaries intact).
 * - History participates as shell-owned placement controls.
 */

import { describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import type { DocumentToolbarContext } from '../document-toolbar-registry.js';
import type { ToolbarPlacementContribution } from './placement-registry.js';
import {
  assembleOwnedPool,
  planToolbarCompaction,
  resolveToolbarGroups,
  shellHistoryOwnedControls,
  type ResolvedToolbarGroup,
} from './placement-resolver.js';
import { updateWidthCache } from '../react/UnifiedToolbar.js';
import { defaultToolbarPlacements } from './default-placements.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';

const button = (id: string): DocumentToolControl => ({
  kind: 'button',
  id,
  group: 'test',
  label: id,
});

function context(kindId: string): DocumentToolbarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId,
    editor: { context: 'test', controls: [] },
  };
}

function group(
  id: string,
  anchor: ResolvedToolbarGroup['anchor'],
  order: number,
  priority: number,
  compact: ResolvedToolbarGroup['compact'] = 'auto',
): ResolvedToolbarGroup {
  return {
    id,
    anchor,
    order,
    priority,
    compact,
    controls: [],
  };
}

describe('assembleOwnedPool (execution ownership)', () => {
  it('keeps provider control when a contribution claims the same id', () => {
    const { ownedPool, diagnostics } = assembleOwnedPool({
      providerControls: [button('markdown.bold')],
      contributions: [
        {
          contributionId: 'acme.override',
          controls: [button('markdown.bold')],
        },
      ],
    });
    expect(ownedPool).toHaveLength(1);
    expect(ownedPool[0]?.owner).toEqual({ kind: 'provider' });
    expect(ownedPool[0]?.control.id).toBe('markdown.bold');
    expect(diagnostics.join('\n')).toContain('markdown.bold');
    expect(diagnostics.join('\n')).toContain('acme.override');
  });

  it('gives shell precedence over contributions but not providers', () => {
    const shell: DocumentToolControl = {
      kind: 'button',
      id: 'shell.history.undo',
      group: 'history',
      label: 'Undo',
    };
    const { ownedPool, diagnostics } = assembleOwnedPool({
      providerControls: [],
      shellControls: [shell],
      contributions: [
        {
          contributionId: 'acme.undo',
          controls: [
            {
              kind: 'button',
              id: 'shell.history.undo',
              group: 'history',
              label: 'Undo',
            },
          ],
        },
      ],
    });
    expect(ownedPool).toHaveLength(1);
    expect(ownedPool[0]?.owner).toEqual({ kind: 'shell', command: 'undo' });
    expect(diagnostics.join('\n')).toContain('shell.history.undo');
  });

  it('first contribution wins among duplicates', () => {
    const { ownedPool, diagnostics } = assembleOwnedPool({
      providerControls: [],
      contributions: [
        { contributionId: 'a-first', controls: [button('acme.tool')] },
        { contributionId: 'b-second', controls: [button('acme.tool')] },
      ],
    });
    expect(ownedPool).toHaveLength(1);
    expect(ownedPool[0]?.owner).toEqual({
      kind: 'contribution',
      contributionId: 'a-first',
    });
    expect(diagnostics.join('\n')).toContain('b-second');
  });

  it('rejects unknown shell-owned controls instead of defaulting to Undo', () => {
    const unknown = button('shell.mystery.tool');
    const { ownedPool, diagnostics } = assembleOwnedPool({
      providerControls: [],
      shellControls: [unknown],
    });
    expect(ownedPool).toEqual([]);
    expect(diagnostics.join('\n')).toContain('shell.mystery.tool');
  });
});

describe('resolveToolbarGroups (placement groups survive)', () => {
  it('preserves id/anchor/order/priority/compact through resolution', () => {
    const placements: ToolbarPlacementContribution[] = [
      {
        id: 'test.primary',
        anchor: 'topbar-center',
        order: 10,
        controlIds: ['a'],
        priority: 100,
        compact: 'never',
      },
      {
        id: 'test.format',
        anchor: 'float.top-center',
        order: 20,
        controlIds: ['b'],
        priority: 90,
        compact: 'auto',
      },
    ];
    const { groups } = resolveToolbarGroups({
      placements,
      ownedPool: [
        { control: button('a'), owner: { kind: 'provider' } },
        { control: button('b'), owner: { kind: 'provider' } },
      ],
      context: context('froglight.markdown'),
    });
    expect(groups.map((g) => g.id)).toEqual(['test.primary', 'test.format']);
    expect(groups[0]).toMatchObject({
      anchor: 'topbar-center',
      order: 10,
      priority: 100,
      compact: 'never',
    });
    expect(groups[1]).toMatchObject({
      anchor: 'float.top-center',
      order: 20,
      priority: 90,
      compact: 'auto',
    });
    expect(groups[0]?.controls.map((c) => c.control.id)).toEqual(['a']);
  });

  it('reports duplicate placement claims without rendering twice', () => {
    const placements: ToolbarPlacementContribution[] = [
      { id: 'a-first', anchor: 'topbar-center', order: 1, controlIds: ['x'] },
      {
        id: 'b-second',
        anchor: 'float.top-center',
        order: 2,
        controlIds: ['x'],
      },
    ];
    const { groups, diagnostics, owned } = resolveToolbarGroups({
      placements,
      ownedPool: [{ control: button('x'), owner: { kind: 'provider' } }],
      context: context('froglight.markdown'),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('a-first');
    expect(owned).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('b-second');
  });

  it('omits empty groups (absent ids skipped without gaps)', () => {
    const { groups, unplaced } = resolveToolbarGroups({
      placements: [
        { id: 'empty', anchor: 'topbar-center', controlIds: ['missing'] },
      ],
      ownedPool: [{ control: button('real'), owner: { kind: 'provider' } }],
      context: context('froglight.markdown'),
    });
    expect(groups).toEqual([]);
    expect(unplaced).toEqual(['real']);
  });
});

describe('planToolbarCompaction (responsive priority)', () => {
  const widths = new Map([
    ['p-primary', 200],
    ['p-format', 200],
    ['p-insert', 200],
  ]);

  it('keeps all groups when everything fits', () => {
    const groups = [
      group('p-primary', 'topbar-center', 10, 100),
      group('p-format', 'topbar-center', 20, 90),
      group('p-insert', 'topbar-center', 21, 80),
    ];
    const { visible, overflow } = planToolbarCompaction(groups, 600, widths);
    expect(visible.map((g) => g.id)).toEqual([
      'p-primary',
      'p-format',
      'p-insert',
    ]);
    expect(overflow).toEqual([]);
  });

  it('priority 100 survives when only one group fits', () => {
    const groups = [
      group('p-primary', 'topbar-center', 10, 100),
      group('p-format', 'topbar-center', 20, 90),
      group('p-insert', 'topbar-center', 21, 80),
    ];
    const { visible, overflow } = planToolbarCompaction(groups, 244, widths);
    expect(visible.map((g) => g.id)).toEqual(['p-primary']);
    expect(overflow.map((g) => g.id).sort()).toEqual(
      ['p-format', 'p-insert'].sort(),
    );
  });

  it('moves lower-priority auto groups to overflow first', () => {
    const groups = [
      group('p-primary', 'topbar-center', 10, 100),
      group('p-format', 'topbar-center', 20, 90),
      group('p-insert', 'topbar-center', 21, 80),
    ];
    const { visible, overflow } = planToolbarCompaction(groups, 444, widths);
    expect(visible.map((g) => g.id)).toEqual(['p-primary', 'p-format']);
    expect(overflow.map((g) => g.id)).toEqual(['p-insert']);
  });

  it('preserves compact:never and overflows compact:always', () => {
    const groups = [
      group('req', 'topbar-center', 10, 0, 'never'),
      group('auto', 'topbar-center', 20, 50, 'auto'),
      group('always', 'topbar-center', 30, 100, 'always'),
    ];
    const measured = new Map([
      ['req', 200],
      ['auto', 200],
      ['always', 200],
    ]);
    const { visible, overflow } = planToolbarCompaction(groups, 1000, measured);
    expect(visible.map((g) => g.id)).toContain('req');
    expect(overflow.map((g) => g.id)).toContain('always');
  });

  it('keeps group boundaries intact (no split groups)', () => {
    const withControls: ResolvedToolbarGroup[] = [
      {
        ...group('p-a', 'topbar-center', 10, 100),
        controls: [
          { control: button('a1'), owner: { kind: 'provider' } },
          { control: button('a2'), owner: { kind: 'provider' } },
        ],
      },
      {
        ...group('p-b', 'topbar-center', 20, 10),
        controls: [{ control: button('b1'), owner: { kind: 'provider' } }],
      },
    ];
    const measured = new Map([
      ['p-a', 200],
      ['p-b', 200],
    ]);
    const { visible, overflow } = planToolbarCompaction(
      withControls,
      244,
      measured,
    );
    // Whole groups move; a1/a2 stay together in visible.
    expect(visible).toHaveLength(1);
    expect(visible[0]?.controls.map((c) => c.control.id)).toEqual(['a1', 'a2']);
    expect(overflow).toHaveLength(1);
  });

  it('reserves the overflow trigger inside the width budget', () => {
    const groups = [
      group('p-a', 'topbar-center', 10, 100),
      group('p-b', 'topbar-center', 20, 90),
    ];
    const measured = new Map([
      ['p-a', 100],
      ['p-b', 100],
    ]);
    // Exact fit needs no trigger.
    const exact = planToolbarCompaction(groups, 200, measured, {
      overflowWidth: 40,
      overflowGap: 4,
    });
    expect(exact.visible.map((g) => g.id)).toEqual(['p-a', 'p-b']);
    expect(exact.overflow).toEqual([]);
    // One px over forces one group out; the trigger itself fits in budget.
    const tight = planToolbarCompaction(groups, 199, measured, {
      overflowWidth: 40,
      overflowGap: 4,
    });
    expect(tight.visible.map((g) => g.id)).toEqual(['p-a']);
    expect(tight.overflow.map((g) => g.id)).toEqual(['p-b']);
    expect(100 + 40 + 4).toBeLessThanOrEqual(199);
  });

  it('holds recently-overflowed groups out across 1px dither (hysteresis)', () => {
    const groups = [
      group('p-a', 'topbar-center', 10, 100),
      group('p-b', 'topbar-center', 20, 90),
    ];
    const measured = new Map([
      ['p-a', 100],
      ['p-b', 100],
    ]);
    // 199px overflows p-b with a 40px trigger + 4px gap reserved.
    const tight = planToolbarCompaction(groups, 199, measured, {
      overflowWidth: 40,
      overflowGap: 4,
    });
    expect(tight.overflow.map((g) => g.id)).toEqual(['p-b']);
    // Growing by 1px would readmit p-b without hysteresis (100 + 44 <= 200).
    const dither = planToolbarCompaction(groups, 200, measured, {
      overflowWidth: 40,
      overflowGap: 4,
    });
    expect(dither.overflow).toEqual([]);
    // With hysteresis the sticky group needs 8px more to return: still out.
    const held = planToolbarCompaction(groups, 200, measured, {
      overflowWidth: 40,
      overflowGap: 4,
      hysteresis: 8,
      overflowIds: new Set(tight.overflow.map((g) => g.id)),
    });
    expect(held.overflow.map((g) => g.id)).toEqual(['p-b']);
    // Past the hysteresis band it returns and the trigger is released.
    const returned = planToolbarCompaction(groups, 208, measured, {
      overflowWidth: 40,
      overflowGap: 4,
      hysteresis: 8,
      overflowIds: new Set(tight.overflow.map((g) => g.id)),
    });
    expect(returned.visible.map((g) => g.id)).toEqual(['p-a', 'p-b']);
    expect(returned.overflow).toEqual([]);
  });

  it('ignores hysteresis for groups that were not overflowing', () => {
    const groups = [
      group('p-a', 'topbar-center', 10, 100),
      group('p-b', 'topbar-center', 20, 90),
    ];
    const measured = new Map([
      ['p-a', 100],
      ['p-b', 100],
    ]);
    const { visible, overflow } = planToolbarCompaction(groups, 200, measured, {
      overflowWidth: 40,
      overflowGap: 4,
      hysteresis: 8,
      overflowIds: new Set(['unrelated']),
    });
    expect(visible.map((g) => g.id)).toEqual(['p-a', 'p-b']);
    expect(overflow).toEqual([]);
  });

  it('keeps always-overflow groups reachable when required groups exceed the budget', () => {
    const groups = [
      group('req', 'topbar-center', 10, 100, 'never'),
      group('always', 'topbar-center', 20, 10, 'always'),
    ];
    const measured = new Map([
      ['req', 300],
      ['always', 100],
    ]);
    const { visible, overflow } = planToolbarCompaction(groups, 200, measured);
    expect(visible.map((g) => g.id)).toEqual(['req']);
    expect(overflow.map((g) => g.id)).toEqual(['always']);
  });
});

describe('shell history participates in placement resolution', () => {
  it('exposes undo/redo as shell-owned controls', () => {
    const owned = shellHistoryOwnedControls({ canUndo: true, canRedo: false });
    expect(owned.map((o) => o.control.id)).toEqual([
      'shell.history.undo',
      'shell.history.redo',
    ]);
    expect(owned[0]?.owner).toEqual({ kind: 'shell', command: 'undo' });
    expect(owned[1]?.owner).toEqual({ kind: 'shell', command: 'redo' });
    const redo = owned[1]?.control;
    expect(redo?.kind).toBe('button');
    if (redo?.kind === 'button') expect(redo.disabled).toBe(true);
  });

  it('default placements resolve history at float.top-left', () => {
    const placements = defaultToolbarPlacements();
    const history = placements.find(
      (p) => p.id === 'froglight.toolbar-placement.history',
    );
    expect(history).toBeDefined();
    expect(history?.anchor).toBe('float.top-left');
    expect(history?.controlIds).toEqual([
      'shell.history.undo',
      'shell.history.redo',
    ]);
    expect(history?.priority).toBe(100);

    const shellOwned = shellHistoryOwnedControls({
      canUndo: true,
      canRedo: true,
    });
    const { groups } = resolveToolbarGroups({
      placements,
      ownedPool: shellOwned,
      context: context('froglight.markdown'),
    });
    const historyGroup = groups.find((g) => g.id === history?.id);
    expect(historyGroup?.controls.map((c) => c.control.id)).toEqual([
      'shell.history.undo',
      'shell.history.redo',
    ]);
  });

  it('first-party placements retain deterministic order (order, then id)', () => {
    const placements = defaultToolbarPlacements();
    const shellOwned = shellHistoryOwnedControls({
      canUndo: true,
      canRedo: true,
    });
    const { groups } = resolveToolbarGroups({
      placements,
      ownedPool: [
        ...shellOwned,
        { control: button('ink.color'), owner: { kind: 'provider' } },
      ],
      context: context('froglight.ink'),
    });
    // History is kind-agnostic (no kindIds) so it also matches ink;
    // keeps no topbar-center primaries, so the first geometric
    // group after history is a float island, ordered after history.
    const ids = groups.map((g) => g.id);
    expect(ids).toContain('froglight.toolbar-placement.history');
    expect(ids).not.toContain('froglight.toolbar-placement.markdown.primary');
    expect(ids.indexOf('froglight.toolbar-placement.history')).toBe(0);
  });
});

describe('owned execution cannot be hijacked', () => {
  it('contribution executeOwned only runs its own owner', async () => {
    const { registry } = createDocumentToolbarRegistry();
    let acmeCalls = 0;
    let otherCalls = 0;
    registry.register({
      id: 'acme.cite',
      controls: () => [button('acme.cite')],
      execute: () => {
        acmeCalls += 1;
        return true;
      },
    });
    registry.register({
      id: 'other.tool',
      controls: () => [button('other.tool')],
      execute: () => {
        otherCalls += 1;
        return true;
      },
    });
    const ctx = context('froglight.markdown');
    expect(await registry.executeOwned('acme.cite', ctx, 'acme.cite')).toBe(
      true,
    );
    expect(acmeCalls).toBe(1);
    expect(otherCalls).toBe(0);
    // Wrong owner cannot trigger another contribution.
    expect(await registry.executeOwned('other.tool', ctx, 'acme.cite')).toBe(
      false,
    );
    expect(acmeCalls).toBe(1);
  });

  it('provider duplicate keeps provider owner so execution never reaches the contribution', () => {
    const { registry } = createDocumentToolbarRegistry();
    registry.register({
      id: 'acme.bold-override',
      controls: () => [button('markdown.bold')],
      execute: () => true,
    });
    const ctx = context('froglight.markdown');
    // The contribution does expose the id in isolation...
    expect(registry.ownerOf(ctx, 'markdown.bold')).toBe('acme.bold-override');
    // ...but assembly with provider precedence keeps the provider owner,
    // so the toolbar routes to the provider channel, never executeOwned.
    const assembled = assembleOwnedPool({
      providerControls: [button('markdown.bold')],
      contributions: registry.entries(ctx),
    });
    expect(assembled.ownedPool).toHaveLength(1);
    expect(assembled.ownedPool[0]?.owner).toEqual({ kind: 'provider' });
    expect(assembled.diagnostics.join('\n')).toContain('acme.bold-override');
  });
});

describe('updateWidthCache (overflow measurement stability)', () => {
  it('retains overflowed widths instead of forgetting them to zero', () => {
    const cache = new Map([
      ['a', 200],
      ['b', 200],
    ]);
    // Only `a` still visible; `b` overflowed and unobserved.
    const next = updateWidthCache(
      cache,
      new Map([['a', 200]]),
      new Set(['a', 'b']),
    );
    expect(next.get('b')).toBe(200);
  });

  it('prunes ids only when their group truly disappears', () => {
    const cache = new Map([
      ['a', 200],
      ['gone', 100],
    ]);
    const next = updateWidthCache(
      cache,
      new Map([['a', 200]]),
      new Set(['a']),
    );
    expect(next.has('gone')).toBe(false);
    expect(next.get('a')).toBe(200);
  });

  it('does not oscillate at a resize threshold (repeated narrow widths)', () => {
    const groups: ResolvedToolbarGroup[] = [
      {
        id: 'a',
        anchor: 'topbar-center',
        order: 1,
        priority: 100,
        compact: 'auto',
        controls: [],
      },
      {
        id: 'b',
        anchor: 'topbar-center',
        order: 2,
        priority: 90,
        compact: 'auto',
        controls: [],
      },
    ];
    // 250 + 250 = 500 of groups against a 499px toolbar: `b` must overflow
    // and stay overflowed. Without retention the second measure would see
    // `b` as missing (width 0) and wrongly re-show it, oscillating.
    const cache = new Map([
      ['a', 250],
      ['b', 250],
    ]);
    const partitions: string[] = [];
    for (const width of [499, 499, 499, 499]) {
      // Each cycle the planner sees the retained cache (overflowed groups
      // keep last-known widths), so the partition cannot alternate.
      const { visible, overflow } = planToolbarCompaction(
        groups,
        width,
        cache,
      );
      expect(visible.map((g) => g.id)).toEqual(['a']);
      expect(overflow.map((g) => g.id)).toEqual(['b']);
      partitions.push(
        `v:${visible.map((g) => g.id).join(',')}/o:${overflow.map((g) => g.id).join(',')}`,
      );
      // Simulate the next measure: only visible groups observed.
      const observed = new Map(
        visible.map((g) => [g.id, cache.get(g.id) ?? 0] as const),
      );
      updateWidthCache(
        cache,
        observed,
        new Set(groups.map((g) => g.id)),
      );
    }
    expect(new Set(partitions).size).toBe(1);
  });
});
