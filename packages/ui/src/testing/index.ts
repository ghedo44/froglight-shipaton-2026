/**
 * Testing utilities for the workbench ports — focused per-port fakes and
 * the shared behavioral contract suite. Import from
 * `@froglight/ui/testing`, never from production entry points, so test
 * doubles stay out of shipped bundles.
 */

export * from '../workbench-contracts.js';
export * from '../workbench-fakes.js';
export * from '../workbench-adapters.js';
