/**
 * @froglight/plugin-platform — plugin platform implementation.
 *
 * Exports manifest validation, package loading, permission broker,
 * capability facades, RPC, sandboxed host, crash loop, inspection, and
 * vault-backed community plugin loading. The surface is host-portable:
 * Node-only worker spawning lives in `./worker.js` and is injected by
 * environments that need it (tests).
 */

export * from './manifest.js';
export * from './permissions.js';
export * from './facades.js';
export * from './rpc.js';
export * from './sandbox.js';
export * from './crash-loop.js';
export * from './package.js';
export * from './inspection.js';
export * from './devtools-panel.js';
export * from './dogfooding.js';
export * from './toolbar.js';
export * from './vault-store.js';
export * from './community.js';
