/**
 * Tests for the in-memory command registry.
 *
 * Commands are named actions; registration returns a disposer so lifecycle
 * is owned by the registering effect scope. Execution captures failures
 * instead of throwing.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryCommandService } from './commands.js';
import { FroglightError, isFroglightError } from './errors.js';

/** Assert that `fn` throws a FroglightError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected the call to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('InMemoryCommandService', () => {
  it('registers, gets, and lists commands', () => {
    const service = new InMemoryCommandService();
    const command = { id: 'app.hello', title: 'Hello', execute: () => 42 };
    service.register(command);
    expect(service.get('app.hello')).toBe(command);
    expect(service.list()).toEqual(['app.hello']);
  });

  it('lists ids sorted', () => {
    const service = new InMemoryCommandService();
    service.register({ id: 'z.last', execute: () => undefined });
    service.register({ id: 'a.first', execute: () => undefined });
    expect(service.list()).toEqual(['a.first', 'z.last']);
  });

  it('throws DUPLICATE_COMMAND on id collision', () => {
    const service = new InMemoryCommandService();
    service.register({ id: 'app.x', execute: () => undefined });
    expectCode(() => service.register({ id: 'app.x', execute: () => undefined }), 'DUPLICATE_COMMAND');
  });

  it('get throws COMMAND_NOT_FOUND when absent', () => {
    const service = new InMemoryCommandService();
    expectCode(() => service.get('missing'), 'COMMAND_NOT_FOUND');
  });

  it('unregister removes a command; no-op when absent', () => {
    const service = new InMemoryCommandService();
    service.register({ id: 'app.x', execute: () => undefined });
    service.unregister('app.x');
    expect(service.list()).toEqual([]);
    expect(() => service.unregister('app.x')).not.toThrow();
  });

  it('registration disposer unregisters (lifecycle-owned)', () => {
    const service = new InMemoryCommandService();
    const dispose = service.register({ id: 'app.x', execute: () => undefined });
    dispose.dispose();
    expect(service.list()).toEqual([]);
    // Re-registration is possible after disposal.
    service.register({ id: 'app.x', execute: () => undefined });
    expect(service.list()).toEqual(['app.x']);
  });

  it('execute runs the command and reports ok', async () => {
    const service = new InMemoryCommandService();
    let ran = 0;
    service.register({
      id: 'app.x',
      execute: () => {
        ran += 1;
      },
    });
    const result = await service.execute('app.x');
    expect(result).toEqual({ ok: true });
    expect(ran).toBe(1);
  });

  it('execute awaits async commands', async () => {
    const service = new InMemoryCommandService();
    service.register({
      id: 'app.async',
      execute: async () => {
        await Promise.resolve();
      },
    });
    expect(await service.execute('app.async')).toEqual({ ok: true });
  });

  it('execute captures command failures in the result', async () => {
    const service = new InMemoryCommandService();
    const boom = new Error('boom');
    service.register({
      id: 'app.x',
      execute: () => {
        throw boom;
      },
    });
    const result = await service.execute('app.x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(boom);
    }
  });

  it('execute reports COMMAND_NOT_FOUND without throwing', async () => {
    const service = new InMemoryCommandService();
    const result = await service.execute('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isFroglightError(result.error)).toBe(true);
      expect((result.error as FroglightError).code).toBe('COMMAND_NOT_FOUND');
    }
  });
});