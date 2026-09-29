/**
 * Surface Object Type registry behavior: namespaced ids,
 * reversible effect-owned registrations mirroring the Block Registry.
 */

import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { rectangleObject } from './model.js';
import type { SurfaceObjectRecord } from './model.js';
import {
  InMemorySurfaceObjectTypeRegistry,
} from './registry.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import type { SurfaceObjectTypeDescriptor } from './registry.js';

const marker: SurfaceObjectTypeDescriptor = {
  typeId: 'acme.callout',
  version: 1,
  compile: () => ({ kind: 'placeholder', objectId: 'x', bounds: { x: 0, y: 0, width: 0, height: 0 }, rotation: 0, label: 'acme.callout' }),
};

describe('surface object type registry', () => {
  it('registers, lists, and disposes reversibly', () => {
    const registry = new InMemorySurfaceObjectTypeRegistry();
    const disposer = registry.register(marker);
    expect(registry.get('acme.callout')).toBe(marker);
    expect(registry.list()).toEqual([marker]);
    disposer.dispose();
    expect(registry.get('acme.callout')).toBeNull();
    // Dispose is idempotent and re-registration after disposal works.
    disposer.dispose();
    expect(() => registry.register(marker)).not.toThrow();
  });

  it('rejects non-namespaced and duplicate type ids with structured errors', () => {
    const registry = new InMemorySurfaceObjectTypeRegistry();
    try {
      registry.register({ ...marker, typeId: 'callout' });
      expect.unreachable('expected INVALID_SURFACE_OBJECT_TYPE_ID');
    } catch (error) {
      expect((error as FroglightError).code).toBe('INVALID_SURFACE_OBJECT_TYPE_ID');
    }
    registry.register(marker);
    try {
      registry.register(marker);
      expect.unreachable('expected DUPLICATE_SURFACE_OBJECT_TYPE');
    } catch (error) {
      expect((error as FroglightError).code).toBe('DUPLICATE_SURFACE_OBJECT_TYPE');
    }
  });

  it('ships a default registry holding exactly the closed core type set', () => {
    const registry = createDefaultSurfaceObjectTypeRegistry();
    expect(registry.list().map((d) => d.typeId).sort()).toEqual([
      'froglight.card',
      'froglight.ellipse',
      'froglight.group',
      'froglight.image',
      'froglight.ink.stroke',
      'froglight.line',
      'froglight.rectangle',
      'froglight.resource-embed',
      'froglight.text',
    ]);
  });

  it('descriptors expose headless geometry predicates', () => {
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const rect = rectangleObject('r', { x: 10, y: 10, width: 4, height: 2 });
    const descriptor = registry.get('froglight.rectangle')!;
    expect(descriptor.boundsOf!(rect)).toEqual({ x: 10, y: 10, width: 4, height: 2 });
    expect(descriptor.hitTest!(rect, 11, 11)).toBe(true);
    expect(descriptor.hitTest!(rect, 20, 11)).toBe(false);
  });
});

import { definePlugin, Runtime } from '@froglight/runtime';
import { surfaceObjectRegistryToken } from '../tokens.js';
import type { SurfaceObjectTypeRegistry } from './registry.js';

describe('surface registry effect ownership', () => {
  it('registrations follow the fiber lifecycle across slot replacement', async () => {
    const runtime = new Runtime();
    const registry = new InMemorySurfaceObjectTypeRegistry();
    let live: SurfaceObjectTypeRegistry | null = null;

    const registryBinding = definePlugin({
      id: 'froglight.surface-registry.binding',
      activate: (ctx) => {
        live = registry;
        ctx.provide(surfaceObjectRegistryToken, registry);
      },
    });

    const surfaceTypesPlugin = definePlugin({
      id: 'acme.surface-types',
      requirements: { requires: [surfaceObjectRegistryToken] },
      activate: (ctx) => {
        const reg = ctx.require(surfaceObjectRegistryToken);
        ctx.effect(() =>
          reg.register({
            typeId: 'acme.sticky-note',
            version: 1,
            compile: (record: SurfaceObjectRecord) => ({
              kind: 'placeholder' as const,
              objectId: record.id,
              bounds: { x: 0, y: 0, width: 1, height: 1 },
              rotation: 0,
              label: record.type,
            }),
          }).dispose,
        );
      },
    });

    await runtime.registerSlot({ id: 'surface-registry', plugin: registryBinding });
    const slot = await runtime.registerSlot({ id: 'acme-surface-types', plugin: surfaceTypesPlugin });
    expect(live!.list()).toHaveLength(1);

    // Dispose → zero registrations.
    await runtime.removeSlot(slot.id);
    expect(live!.list()).toHaveLength(0);

    // Reactivate → exactly one registration again (hot-reload invariant).
    await runtime.registerSlot({ id: 'acme-surface-types', plugin: surfaceTypesPlugin });
    expect(live!.list()).toEqual([expect.objectContaining({ typeId: 'acme.sticky-note', version: 1 })]);

    await runtime.dispose();
  });
});
