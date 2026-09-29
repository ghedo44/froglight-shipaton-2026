/**
 * Test fixtures: deliberately domain-neutral plugins and service tokens used
 * to prove runtime composition semantics. They must not introduce product
 * concepts (documents, search, UI, hosts).
 *
 * The fixtures form a dependency chain:
 *
 * ```text
 * Provider A  →  Service A
 * Consumer B requires A  →  provides Service B
 * Consumer C requires B  →  provides Service C
 * Consumer D requires C
 * ```
 */

import type { Context, PluginDefinition } from '../lib/types.js';
import { createServiceToken, type ServiceToken } from '../lib/services.js';

/** A promise with externally controlled resolution (no timer races). */
export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Create a deferred promise for deterministic async test control. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The contract of service A (the root provider's capability). */
export interface ServiceA {
  readonly label: string;
}

/** The contract of service B. */
export interface ServiceB {
  readonly label: string;
}

/** The contract of service C. */
export interface ServiceC {
  readonly label: string;
}

/** Stable typed identity for service A. */
export const tokenA = createServiceToken<ServiceA>('fixture.serviceA');
/** Stable typed identity for service B. */
export const tokenB = createServiceToken<ServiceB>('fixture.serviceB');
/** Stable typed identity for service C. */
export const tokenC = createServiceToken<ServiceC>('fixture.serviceC');

/**
 * Create a provider plugin that provides a service with the given label.
 * The label distinguishes providers with the same contract (A vs A2).
 *
 * When `log` is provided, activation pushes `activate:<id>` and the returned
 * disposer pushes `dispose:<id>`, enabling exact-order assertions.
 */
export function makeProvider(
  id: string,
  token: ServiceToken,
  label: string,
  options: { registerListeners?: boolean; log?: string[] } = {},
): PluginDefinition {
  return {
    id,
    activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      const implementation = { label };
      ctx.provide(token, implementation);
      if (options.registerListeners) {
        ctx.on('fixture.ping', () => undefined);
      }
      return () => {
        options.log?.push(`dispose:${id}`);
      };
    },
  };
}

/**
 * Create a consumer plugin that requires the given tokens and provides a
 * service whose label derives from the required implementations (proving the
 * consumer really resolved the capability contract, not a stale reference).
 *
 * When `log` is provided, activation pushes `activate:<id>` and the returned
 * disposer pushes `dispose:<id>`, enabling exact-order assertions.
 */
export function makeConsumer(
  id: string,
  requires: readonly ServiceToken<{ label: string }>[],
  provides: ServiceToken,
  options: { registerListeners?: boolean; log?: string[] } = {},
): PluginDefinition {
  return {
    id,
    requirements: { requires },
    activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      const resolved = requires.map((token) => ctx.require(token));
      ctx.provide(provides, {
        label: `${id}(${resolved.map((r) => r.label).join(',')})`,
      });
      if (options.registerListeners) {
        ctx.on('fixture.ping', () => undefined);
      }
      return () => {
        options.log?.push(`dispose:${id}`);
      };
    },
  };
}

/**
 * A plugin that requires tokens but provides nothing. When `log` is
 * provided, activation pushes `activate:<id>` and the returned disposer
 * pushes `dispose:<id>`.
 */
export function makeLeaf(
  id: string,
  requires: readonly ServiceToken<{ label: string }>[],
  options: { log?: string[] } = {},
): PluginDefinition {
  return {
    id,
    requirements: { requires },
    activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      ctx.require(requires[0]);
      return () => {
        options.log?.push(`dispose:${id}`);
      };
    },
  };
}

/** A plugin whose activation always throws. */
export function makeFailing(id: string): PluginDefinition {
  return {
    id,
    activate() {
      throw new Error(`activation of "${id}" fails on purpose`);
    },
  };
}

/** A plugin that registers a listener and an effect, then throws. */
export function makePartialFailing(id: string): PluginDefinition {
  return {
    id,
    activate(ctx: Context) {
      ctx.on('fixture.ping', () => undefined);
      ctx.effect({
        dispose: () => undefined,
      });
      throw new Error(`partial activation of "${id}" fails on purpose`);
    },
  };
}

/** A plugin whose cleanup throws. */
export function makeThrowingCleanup(id: string): PluginDefinition {
  return {
    id,
    activate() {
      return () => {
        throw new Error(`cleanup of "${id}" fails on purpose`);
      };
    },
  };
}

/**
 * Additional tokens for non-linear topologies (diamond, siblings, cycles).
 * The contract is the same label-shaped service used by the chain fixtures.
 */
export const tokenX = createServiceToken<{ label: string }>('fixture.serviceX');
export const tokenY = createServiceToken<{ label: string }>('fixture.serviceY');
export const tokenZ = createServiceToken<{ label: string }>('fixture.serviceZ');

/**
 * A consumer that declares optional requirements and resolves them through
 * `ctx.try`. Optional (soft) dependencies never participate in mandatory
 * teardown: removing an optional provider must not dispose or reactivate
 * this consumer.
 */
export function makeOptionalConsumer(
  id: string,
  optionallyRequires: readonly ServiceToken<{ label: string }>[],
  provides: ServiceToken,
  options: { log?: string[] } = {},
): PluginDefinition {
  return {
    id,
    requirements: { optionallyRequires },
    activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      const resolved = optionallyRequires
        .map((token) => ctx.try(token))
        .filter((r): r is { label: string } => r !== undefined);
      ctx.provide(provides, {
        label: `${id}(${resolved.map((r) => r.label).join(',')})`,
      });
      return () => {
        options.log?.push(`dispose:${id}`);
      };
    },
  };
}

/**
 * A consumer with no declared requirements that observes services through
 * `ctx.try` only. A successful `ctx.try` records a soft edge and must never
 * turn the fiber into a hard teardown dependent.
 */
export function makeTryConsumer(
  id: string,
  observed: readonly ServiceToken<{ label: string }>[],
  provides: ServiceToken,
  options: { log?: string[] } = {},
): PluginDefinition {
  return {
    id,
    activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      const labels = observed
        .map((token) => ctx.try(token))
        .filter((r): r is { label: string } => r !== undefined)
        .map((r) => r.label);
      ctx.provide(provides, { label: `${id}(${labels.join(',')})` });
      return () => {
        options.log?.push(`dispose:${id}`);
      };
    },
  };
}

/**
 * A plugin whose activation is held open on a deferred gate. When `requires`
 * is declared, the fiber enters `loading` with hard dependency edges
 * registered immediately — even though activation has not completed. The
 * binding is staged before the gate so that, when the fiber is cancelled,
 * the activation completes and its disposer runs through the late-disposer
 * path (deterministic log), while the staged binding never commits.
 */
export function makeGatedActivation(
  id: string,
  gate: Deferred<void>,
  options: {
    requires?: readonly ServiceToken[];
    provides?: ServiceToken;
    log?: string[];
  } = {},
): PluginDefinition {
  const requirements =
    options.requires !== undefined ? { requires: options.requires } : undefined;
  return {
    id,
    requirements,
    async activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      if (options.provides !== undefined) {
        ctx.provide(options.provides, { label: id });
      }
      await gate.promise;
      return () => {
        options.log?.push(`dispose:${id}`);
      };
    },
  };
}

/**
 * A consumer whose disposer awaits a deferred gate: its cleanup stays in
 * flight until the test releases it. Used to hold a provider's retirement
 * window open deterministically.
 */
export function makeSlowCleanupConsumer(
  id: string,
  requires: readonly ServiceToken<{ label: string }>[],
  cleanupGate: Deferred<void>,
  options: { log?: string[] } = {},
): PluginDefinition {
  return {
    id,
    requirements: { requires },
    activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      ctx.require(requires[0]);
      return async () => {
        options.log?.push(`dispose:${id}:start`);
        await cleanupGate.promise;
        options.log?.push(`dispose:${id}:end`);
      };
    },
  };
}

/**
 * A consumer whose cleanup resolves its required service again. Proves
 * `ctx.require` stays available during unload (Option B): the
 * provider's binding is retiring, not withdrawn, while the consumer's
 * cleanup runs.
 */
export function makeResolvingCleanupConsumer(
  id: string,
  requires: readonly ServiceToken<{ label: string }>[],
  options: { log?: string[] } = {},
): PluginDefinition {
  return {
    id,
    requirements: { requires },
    activate(ctx: Context) {
      options.log?.push(`activate:${id}`);
      const token = requires[0];
      ctx.require(token);
      return () => {
        const value = ctx.require(token);
        options.log?.push(`dispose:${id}:${value.label}`);
      };
    },
  };
}
