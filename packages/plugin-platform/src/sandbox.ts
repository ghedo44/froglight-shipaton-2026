import type { TrustTier } from '@froglight/sdk';
import type { PluginManifest } from './manifest.js';
import { PermissionBroker } from './permissions.js';
import { authorizeRpc, type RpcRequest, type RpcResponse } from './rpc.js';

/**
 * Worker-per-plugin isolation.
 *
 * The host is transport-agnostic: a Node test injects a `worker_threads`
 * spawner, a browser/Tauri build can inject a Web Worker spawner. Worker
 * lifecycle is owned by the Fiber's EffectScope — termination is synchronous
 * before reconciliation rescan. The platform core itself never imports a
 * host-specific Worker implementation, so it bundles for every target.
 */

/** Minimal worker surface used by the host; satisfied by both worker kinds. */
export interface IsolatedWorkerLike {
  terminate(): void;
}

export type WorkerSpawner = (onHostMessage: (msg: unknown) => void) => IsolatedWorkerLike;

export interface SandboxedHostOptions {
  readonly manifest: PluginManifest;
  readonly tier: TrustTier;
  readonly broker: PermissionBroker;
  /** Optional handler that actually invokes the provider (for tests). */
  readonly invoke?: (req: RpcRequest) => Promise<unknown>;
  readonly worker?: IsolatedWorkerLike | null;
}

export class SandboxedHost {
  readonly manifest: PluginManifest;
  readonly tier: TrustTier;
  readonly broker: PermissionBroker;
  readonly invoke: (req: RpcRequest) => Promise<unknown>;
  readonly worker: IsolatedWorkerLike | null;
  #terminated = false;

  constructor(opts: SandboxedHostOptions) {
    this.manifest = opts.manifest;
    this.tier = opts.tier;
    this.broker = opts.broker;
    this.invoke = opts.invoke ?? (async () => {
      throw new Error('no provider invoke handler configured');
    });
    this.worker = opts.worker ?? null;
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  terminate(): void {
    this.#terminated = true;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch { /* termination is best-effort */ }
    }
  }

  /**
   * Handle a raw RPC message from the worker. Validates schema, checks
   * permissions via broker, then invokes the provider. Returns RpcResponse.
   * Never leaks host handles to the worker.
   */
  async handleMessage(raw: unknown): Promise<RpcResponse> {
    if (this.#terminated) {
      return { id: (raw as any)?.id ?? 'unknown', ok: false, error: 'host terminated', code: 'HOST_TERMINATED' };
    }
    try {
      const req = authorizeRpc(raw, this.broker);
      const result = await this.invoke(req);
      return { id: req.id, ok: true, result };
    } catch (e: unknown) {
      const err = e as Error;
      const isPermission = err?.name === 'PermissionDeniedError';
      return {
        id: (raw as any)?.id ?? 'unknown',
        ok: false,
        error: err?.message ?? String(e),
        code: isPermission ? 'PERMISSION_DENIED' : 'RPC_VALIDATION_FAILED',
      };
    }
  }
}

// In-process host (no Worker) — for unit tests that don't need thread isolation.
export function createSandboxedHost(opts: SandboxedHostOptions): SandboxedHost {
  return new SandboxedHost(opts);
}

// Worker-backed host for honest isolation. The spawner is injected by the
// environment (Node `worker_threads` in tests, Web Worker in browser builds),
// keeping this module free of host-specific imports.
export function createSandboxedWorkerHost(
  opts: SandboxedHostOptions & { readonly spawnWorker: WorkerSpawner },
): SandboxedHost {
  const pending = new Map<string, (res: RpcResponse) => void>();
  let hostRef: SandboxedHost | null = null;

  const worker = opts.spawnWorker(async (msg: unknown) => {
    // Worker echoes back messages as { __echo, __hasImportScripts, __hasTauri }
    // For real plugin code, the worker would send RpcRequest objects directly.
    const raw = (msg as any)?.__echo ?? msg;
    if ((msg as any)?.__ready) return;
    if (hostRef) {
      const response = await hostRef.handleMessage(raw);
      // If the original message was an RPC with id, we could route response back.
      // For the echo worker, we just post back via worker (already handling).
      // Resolve any pending for tests
      const id = (raw as any)?.id;
      if (id && pending.has(id)) {
        pending.get(id)!(response);
        pending.delete(id);
      }
    }
  });

  const host = new SandboxedHost({ ...opts, worker });
  hostRef = host;

  // Patch terminate to ensure worker is terminated synchronously
  const originalTerminate = host.terminate.bind(host);
  host.terminate = () => {
    try {
      worker.terminate();
    } catch { /* termination is best-effort */ }
    originalTerminate();
  };

  return host;
}
