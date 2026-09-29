/**
 * Effect ownership of surface editing instances: editing
 * bindings are created inside effect scopes and disposal tears them down
 * deterministically — activate → one live binding, dispose → destroyed,
 * reactivate → one.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { infiniteFrame, rectangleObject, type SurfaceModel } from './model.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import { SurfaceInteractionController } from './controller.js';

function board(): SurfaceModel {
  return {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['r1'],
    objects: { r1: rectangleObject('r1', { x: 0, y: 0, width: 10, height: 10 }) },
  };
}

describe('surface editing instance effect ownership', () => {
  it('controller lifecycle follows the owning fiber across slot replacement', async () => {
    const runtime = new Runtime();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    let controller: SurfaceInteractionController | null = null;

    const editorPlugin = definePlugin({
      id: 'acme.surface-editor',
      activate: (ctx) => {
        ctx.effect(() => {
          const instance = new SurfaceInteractionController({
            model: board(),
            registry,
          });
          controller = instance;
          // Disposing the scope must destroy the interaction binding.
          return () => instance.destroy();
        });
      },
    });

    const slot = await runtime.registerSlot({ id: 'acme-surface-edit', plugin: editorPlugin });
    expect(controller).not.toBeNull();

    // Dispose → the owned binding is destroyed and rejects further events.
    await runtime.removeSlot(slot.id);
    expect(() => controller!.pointerDown({ point: { x: 0, y: 0 } })).toThrowError();

    // Reactivate → exactly one fresh binding again.
    await runtime.registerSlot({ id: 'acme-surface-edit', plugin: editorPlugin });
    expect(() => controller!.pointerDown({ point: { x: 5, y: 5 } })).not.toThrow();
    expect(controller!.selection()).toEqual(['r1']);

    await runtime.dispose();
  });
});
