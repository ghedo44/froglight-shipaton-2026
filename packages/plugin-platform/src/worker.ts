import { Worker } from 'node:worker_threads';

/**
 * Worker entry for sandboxed plugins.
 * Runs in a per-plugin Worker with no DOM, no Tauri IPC, only parentPort RPC.
 * For Node tests this is a `worker_threads` Worker; in browsers it would be a
 * `Worker` (PWA) — same RPC contract.
 */

export type WorkerMessage = unknown;

export function spawnIsolatedWorker(onHostMessage: (msg: WorkerMessage) => void): Worker {
  // Worker code: isolated realm, only communicates via parentPort.
  // Attempts to use `importScripts` or Tauri globals will fail because they are not defined.
  const workerCode = `
    const { parentPort } = require('node:worker_threads');
    // Signal readiness
    parentPort.postMessage({ __ready: true });
    parentPort.on('message', (msg) => {
      // Simulate plugin RPC: just echo back for host to validate.
      // Any attempt to access forbidden host globals like 'process.env' via message would still be validated by host.
      // For adversarial test, we also try to ensure importScripts is not defined.
      const hasImportScripts = typeof importScripts !== 'undefined';
      const hasTauri = typeof globalThis.__TAURI__ !== 'undefined';
      // Attach isolation check (for debugging)
      parentPort.postMessage({ __echo: msg, __hasImportScripts: hasImportScripts, __hasTauri: hasTauri });
    });
  `;
  const worker = new Worker(workerCode, { eval: true });
  // Forward worker messages to host handler
  worker.on('message', onHostMessage as any);
  return worker;
}
