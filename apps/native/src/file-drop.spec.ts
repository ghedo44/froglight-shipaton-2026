import { describe, expect, it, vi } from 'vitest';
import {
  FILE_DROP_NATIVE_EVENT_CHANNEL,
  externalFileDropToken,
  type ExternalDropEvent,
} from '@froglight/foundation';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  FILE_DROP_READ_COMMAND,
  FILE_DROP_RELEASE_COMMAND,
  createNativeFileDrop,
  installNativeFileDropEventForwarder,
} from './file-drop.js';

describe('native file-drop adapter', () => {
  it('forwards direct-eval native events into the service', () => {
    const host = createNativeFileDrop(async () => new Uint8Array());
    const scope: Record<string, unknown> = {};
    const uninstall = installNativeFileDropEventForwarder(
      host.service,
      scope,
    );
    const hook = scope[FILE_DROP_NATIVE_EVENT_CHANNEL] as (
      event: string,
      payload: unknown,
    ) => void;
    expect(typeof hook).toBe('function');
    const seen: ExternalDropEvent[] = [];
    host.service.listen((event) => seen.push(event));
    hook('enter', { x: 1, y: 2 });
    hook('over', { x: 3, y: 4 });
    hook('leave', {});
    hook('bogus', { x: 1, y: 1 });
    expect(seen).toEqual([
      { type: 'enter', position: { x: 1, y: 2 } },
      { type: 'over', position: { x: 3, y: 4 } },
      { type: 'leave' },
    ]);
    uninstall();
    expect(scope[FILE_DROP_NATIVE_EVENT_CHANNEL]).toBeUndefined();
    uninstall();
  });

  it('resolves drop bytes through the trusted read_drop_file command', async () => {
    const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe(FILE_DROP_READ_COMMAND);
      expect(args).toEqual({ token: 'tok-1' });
      return [10, 20, 30];
    });
    const host = createNativeFileDrop(call);
    const seen: ExternalDropEvent[] = [];
    host.service.listen((event) => seen.push(event));
    const scope: Record<string, unknown> = {};
    const uninstall = installNativeFileDropEventForwarder(
      host.service,
      scope,
    );
    try {
      const hook = scope[FILE_DROP_NATIVE_EVENT_CHANNEL] as (
        event: string,
        payload: unknown,
      ) => void;
      hook('drop', {
        x: 5,
        y: 6,
        files: [{ token: 'tok-1', name: 'paper.pdf' }],
      });
      expect(seen).toHaveLength(1);
      const drop = seen[0];
      if (drop.type !== 'drop') throw new Error('expected drop');
      // Application handles carry names only — no token/URI/path leaks.
      expect(drop.files[0]).not.toHaveProperty('token');
      expect(await drop.files[0]!.readBytes()).toEqual(
        new Uint8Array([10, 20, 30]),
      );
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it('accepts Uint8Array payloads without copying semantics loss', async () => {
    const host = createNativeFileDrop(async () => new Uint8Array([7, 8]));
    const seen: ExternalDropEvent[] = [];
    host.service.listen((event) => seen.push(event));
    host.service.handleNativeEvent('drop', {
      x: 0,
      y: 0,
      files: [{ token: 't', name: 'a.md' }],
    });
    const drop = seen[0];
    if (drop?.type !== 'drop') throw new Error('expected drop');
    expect([...(await drop.files[0]!.readBytes())]).toEqual([7, 8]);
  });

  it('provides the token binding through the runtime lifecycle', async () => {
    const runtime = new Runtime();
    const host = createNativeFileDrop(async () => new Uint8Array());
    await runtime.registerSlot({
      id: 'file-drop',
      plugin: host.definition,
    });
    let seen = false;
    await runtime.registerSlot({
      id: 'file-drop-consumer',
      plugin: definePlugin({
        id: 'froglight.file-drop.native-consumer',
        requirements: { requires: [externalFileDropToken] },
        activate: (ctx) => {
          seen = ctx.require(externalFileDropToken) === host.service;
        },
      }),
    });
    expect(seen).toBe(true);
    await runtime.dispose();
  });

  it('exposes stable trusted command names', () => {
    expect(FILE_DROP_READ_COMMAND).toBe(
      'plugin:froglight-file-drop|read_drop_file',
    );
    expect(FILE_DROP_RELEASE_COMMAND).toBe(
      'plugin:froglight-file-drop|release_drop_file',
    );
  });
});
