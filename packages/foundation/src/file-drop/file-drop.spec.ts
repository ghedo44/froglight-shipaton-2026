/**
 * External file-drop capability conformance (`froglight.file-drop`).
 *
 * Trusted-tier host infrastructure: opaque native tokens, lazy reads, no
 * paths or base64 through JS. Malformed native payloads are ignored;
 * disposal follows the runtime lifecycle invariant.
 */

import { describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { externalFileDropToken } from '../tokens.js';
import {
  FILE_DROP_NATIVE_EVENT_CHANNEL,
  type ExternalDropEvent,
} from './contract.js';
import { InMemoryExternalFileDropService } from './service.js';
import { createFileDropHost } from './plugin.js';

describe('external file-drop service', () => {
  it('fans out enter/over/leave/drop to listeners and stops after dispose', () => {
    const service = new InMemoryExternalFileDropService();
    const seen: ExternalDropEvent[] = [];
    const sub = service.listen((event) => seen.push(event));
    service.emit({ type: 'enter', position: { x: 1, y: 2 } });
    service.emit({ type: 'over', position: { x: 3, y: 4 } });
    service.emit({ type: 'leave' });
    service.emit({
      type: 'drop',
      position: { x: 5, y: 6 },
      files: [{ name: 'a.md', readBytes: async () => new Uint8Array([1]) }],
    });
    expect(seen).toHaveLength(4);
    expect(seen[0]).toEqual({ type: 'enter', position: { x: 1, y: 2 } });
    expect(seen[2]).toEqual({ type: 'leave' });
    sub.dispose();
    service.emit({ type: 'leave' });
    expect(seen).toHaveLength(4);
  });

  it('delivers each event once per listener (no duplicate delivery)', () => {
    const service = new InMemoryExternalFileDropService();
    const first: ExternalDropEvent[] = [];
    const second: ExternalDropEvent[] = [];
    const a = service.listen((event) => first.push(event));
    const b = service.listen((event) => second.push(event));
    service.emit({ type: 'leave' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    a.dispose();
    service.emit({ type: 'leave' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    b.dispose();
  });

  it('listener failures never break dispatch', () => {
    const service = new InMemoryExternalFileDropService();
    const seen: ExternalDropEvent[] = [];
    service.listen(() => {
      throw new Error('boom');
    });
    service.listen((event) => seen.push(event));
    service.emit({ type: 'leave' });
    expect(seen).toHaveLength(1);
  });

  it('parses well-formed native drop payloads into lazy file handles', async () => {
    const bytes = new Map<string, Uint8Array>([
      ['tok-1', new Uint8Array([10, 20])],
      ['tok-2', new Uint8Array([30])],
    ]);
    const readBytes = vi.fn(async (token: string) => {
      const found = bytes.get(token);
      if (found === undefined) throw new Error(`unknown token ${token}`);
      return found;
    });
    const service = new InMemoryExternalFileDropService({
      resolver: { readBytes },
    });
    const seen: ExternalDropEvent[] = [];
    service.listen((event) => seen.push(event));
    service.handleNativeEvent('drop', {
      x: 12,
      y: 34,
      files: [
        { token: 'tok-1', name: 'paper.pdf', mimeType: 'application/pdf', size: 2 },
        { token: 'tok-2', name: 'notes.md' },
      ],
    });
    expect(seen).toHaveLength(1);
    const drop = seen[0];
    expect(drop.type).toBe('drop');
    if (drop.type !== 'drop') throw new Error('expected drop');
    expect(drop.position).toEqual({ x: 12, y: 34 });
    expect(drop.files).toHaveLength(2);
    expect(drop.files[0]).toMatchObject({
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 2,
    });
    // No native paths or URIs leak into the application handle.
    expect(drop.files[0]).not.toHaveProperty('token');
    expect(drop.files[0]).not.toHaveProperty('uri');
    expect(drop.files[0]).not.toHaveProperty('path');
    expect([...(await drop.files[0]!.readBytes())]).toEqual([10, 20]);
    expect([...(await drop.files[1]!.readBytes())]).toEqual([30]);
    expect(readBytes).toHaveBeenCalledWith('tok-1');
    // Reading is lazy: nothing is read until readBytes() is called.
    expect(readBytes).toHaveBeenCalledTimes(2);
  });

  it('forwards native enter/over positions without file reads', () => {
    const readBytes = vi.fn(async () => new Uint8Array());
    const service = new InMemoryExternalFileDropService({
      resolver: { readBytes },
    });
    const seen: ExternalDropEvent[] = [];
    service.listen((event) => seen.push(event));
    service.handleNativeEvent('enter', { x: 1, y: 2 });
    service.handleNativeEvent('over', { x: 3, y: 4 });
    expect(seen).toEqual([
      { type: 'enter', position: { x: 1, y: 2 } },
      { type: 'over', position: { x: 3, y: 4 } },
    ]);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('ignores malformed native payloads without emitting', () => {
    const service = new InMemoryExternalFileDropService({
      resolver: { readBytes: async () => new Uint8Array() },
    });
    const seen: ExternalDropEvent[] = [];
    service.listen((event) => seen.push(event));
    service.handleNativeEvent('enter', { x: Number.NaN, y: 1 });
    service.handleNativeEvent('over', null);
    service.handleNativeEvent('drop', null);
    service.handleNativeEvent('drop', { x: 1, y: 2, files: [] });
    service.handleNativeEvent('drop', {
      x: 1,
      y: 2,
      files: [{ token: '', name: 'empty-token.md' }],
    });
    service.handleNativeEvent('drop', {
      x: 1,
      y: 2,
      files: [{ token: 't', name: '' }],
    });
    service.handleNativeEvent('bogus-phase', { x: 1, y: 2 });
    expect(seen).toEqual([]);
  });

  it('skips malformed files but keeps well-formed ones in the same drop', () => {
    const service = new InMemoryExternalFileDropService({
      resolver: { readBytes: async () => new Uint8Array([1]) },
    });
    const seen: ExternalDropEvent[] = [];
    service.listen((event) => seen.push(event));
    service.handleNativeEvent('drop', {
      x: 0,
      y: 0,
      files: [
        { token: 'good', name: 'good.md' },
        { token: '', name: 'bad.md' },
        null,
      ],
    });
    expect(seen).toHaveLength(1);
    const drop = seen[0];
    if (drop.type !== 'drop') throw new Error('expected drop');
    expect(drop.files.map((file) => file.name)).toEqual(['good.md']);
  });

  it('readBytes without a resolver rejects instead of hanging', async () => {
    const service = new InMemoryExternalFileDropService();
    const seen: ExternalDropEvent[] = [];
    service.listen((event) => seen.push(event));
    service.handleNativeEvent('drop', {
      x: 1,
      y: 1,
      files: [{ token: 'tok', name: 'a.md' }],
    });
    expect(seen).toHaveLength(1);
    const drop = seen[0];
    if (drop.type !== 'drop') throw new Error('expected drop');
    await expect(drop.files[0]!.readBytes()).rejects.toThrow(/not bound/);
  });

  it('release drops the token without leaking it into application code', async () => {
    const released: string[] = [];
    const service = new InMemoryExternalFileDropService({
      resolver: {
        readBytes: async () => new Uint8Array([1]),
        release: (token: string) => void released.push(token),
      },
    });
    const seen: ExternalDropEvent[] = [];
    service.listen((event) => seen.push(event));
    service.handleNativeEvent('drop', {
      x: 1,
      y: 1,
      files: [{ token: 'tok-release', name: 'a.md' }],
    });
    const drop = seen[0];
    if (drop.type !== 'drop') throw new Error('expected drop');
    await drop.files[0]!.release?.();
    expect(released).toEqual(['tok-release']);
  });

  it('exposes a stable native event channel name', () => {
    expect(FILE_DROP_NATIVE_EVENT_CHANNEL).toBe(
      '__FROGLIGHT_FILE_DROP_EVENT__',
    );
  });
});

describe('file-drop runtime binding', () => {
  it('provides one binding, withdraws on dispose, restores on reactivate', async () => {
    const runtime = new Runtime();
    const host = createFileDropHost({
      resolver: { readBytes: async () => new Uint8Array() },
    });
    const slot = await runtime.registerSlot({
      id: 'file-drop',
      plugin: host.definition,
    });
    expect(slot.id).toBe('file-drop');

    let observed = 0;
    const probe = await runtime.registerSlot({
      id: 'file-drop-probe',
      plugin: definePlugin({
        id: 'froglight.file-drop.probe',
        requirements: { requires: [externalFileDropToken] },
        activate: (ctx) => {
          ctx.require(externalFileDropToken);
          observed += 1;
          ctx.effect(() => () => {
            observed -= 1;
          });
        },
      }),
    });
    expect(observed).toBe(1);

    await runtime.removeSlot(probe.id);
    expect(observed).toBe(0);

    await runtime.removeSlot(slot.id);
    await runtime.registerSlot({
      id: 'file-drop',
      plugin: host.definition,
    });
    let observedAgain = 0;
    await runtime.registerSlot({
      id: 'file-drop-probe',
      plugin: definePlugin({
        id: 'froglight.file-drop.probe',
        requirements: { requires: [externalFileDropToken] },
        activate: (ctx) => {
          const service = ctx.require(externalFileDropToken);
          if (service === host.service) observedAgain += 1;
        },
      }),
    });
    expect(observedAgain).toBe(1);

    await runtime.dispose();
  });

  it('keeps the resolver across reactivations (host-owned state)', async () => {
    const runtime = new Runtime();
    const host = createFileDropHost({
      resolver: {
        readBytes: async () => new Uint8Array([42]),
      },
    });
    await runtime.registerSlot({
      id: 'file-drop',
      plugin: host.definition,
    });
    await runtime.removeSlot('file-drop');
    await runtime.registerSlot({
      id: 'file-drop',
      plugin: host.definition,
    });
    let bytes: Uint8Array | null = null;
    const seen: ExternalDropEvent[] = [];
    await runtime.registerSlot({
      id: 'file-drop-probe2',
      plugin: definePlugin({
        id: 'froglight.file-drop.probe2',
        requirements: { requires: [externalFileDropToken] },
        activate: (ctx) => {
          const service = ctx.require(externalFileDropToken);
          const sub = (service as InMemoryExternalFileDropService).listen(
            (event) => seen.push(event),
          );
          ctx.effect(() => () => sub.dispose());
          (service as InMemoryExternalFileDropService).handleNativeEvent(
            'drop',
            { x: 1, y: 1, files: [{ token: 't', name: 'a.md' }] },
          );
        },
      }),
    });
    const drop = seen[0];
    if (drop?.type !== 'drop') throw new Error('expected drop');
    bytes = await drop.files[0]!.readBytes();
    expect([...bytes]).toEqual([42]);
    await runtime.dispose();
  });
});
