import type { PermissionBroker } from './permissions.js';

/**
 * Typed RPC schema for Sandboxed Worker → broker → provider.
 * Validated at the broker entry; forgeries and extra fields are rejected.
 */

export type RpcRequest = {
  readonly id: string;
  readonly capability: string;
  readonly method: string;
  readonly params: readonly unknown[];
  // pluginId is injected by the host, not trusted from the worker.
};

export type RpcResponse =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string; readonly code: string };

const ALLOWED_CAPABILITIES = new Set([
  'vault',
  'commands',
  'settings',
  'documents',
  'search',
  'relationships',
  'workspace',
]);

const CAPABILITY_METHODS: Record<string, Set<string>> = {
  vault: new Set(['read', 'write', 'remove', 'stat', 'list']),
  commands: new Set(['register', 'execute', 'list']),
  settings: new Set(['get', 'set']),
  documents: new Set(['registerKind', 'read']),
  search: new Set(['query']),
  relationships: new Set(['read']),
  workspace: new Set(['createDocument', 'openDocument']),
};

export function validateRpcRequest(input: unknown): RpcRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('RPC request must be an object');
  }
  const obj = input as Record<string, unknown>;
  const allowedKeys = new Set(['id', 'capability', 'method', 'params']);
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) {
      throw new Error(`RPC request contains extra field "${k}"`);
    }
  }
  const { id, capability, method, params } = obj;
  if (typeof id !== 'string' || id.length === 0) throw new Error('RPC request id must be non-empty string');
  if (typeof capability !== 'string' || !ALLOWED_CAPABILITIES.has(capability)) {
    throw new Error(`RPC request capability "${String(capability)}" not allowed`);
  }
  if (typeof method !== 'string' || !(CAPABILITY_METHODS[capability] ?? new Set()).has(method)) {
    throw new Error(`RPC method "${String(method)}" not allowed for capability "${String(capability)}"`);
  }
  if (!Array.isArray(params)) throw new Error('RPC params must be array');
  return { id, capability, method, params };
}

const CAPABILITY_PERMISSION_MAP: Record<string, string> = {
  'vault.read': 'vault.read',
  'vault.write': 'vault.write',
  'vault.remove': 'vault.write',
  'vault.stat': 'vault.read',
  'vault.list': 'vault.read',
  'commands.register': 'workspace.commands.register',
  'commands.execute': 'workspace.commands.register',
  'commands.list': 'workspace.commands.register',
  'settings.get': 'workspace.settings.read',
  'settings.set': 'workspace.settings.write',
  'documents.registerKind': 'documents.registerKind',
  'documents.read': 'documents.read',
  'search.query': 'search.query',
  'relationships.read': 'relationships.read',
  'workspace.createDocument': 'documents.registerKind',
  'workspace.openDocument': 'documents.read',
};

export function rpcToPermission(capability: string, method: string): string {
  const key = `${capability}.${method}`;
  return CAPABILITY_PERMISSION_MAP[key] ?? `${capability}.${method}`;
}

/**
 * Validate and authorize an RPC request at the broker boundary.
 * Throws PermissionDenied or validation error; never reaches provider on failure.
 */
export function authorizeRpc(
  raw: unknown,
  broker: PermissionBroker,
): RpcRequest {
  const req = validateRpcRequest(raw);
  const perm = rpcToPermission(req.capability, req.method);
  broker.require(perm);
  return req;
}

// Helper for adversarial tests: simulate a forged postMessage with extra fields or identity.
export function createForgedRpc(overrides: Record<string, unknown>): unknown {
  return {
    id: '1',
    capability: 'vault',
    method: 'read',
    params: ['test.md'],
    forgedPluginId: 'evil',
    extraField: 'leak',
    ...overrides,
  };
}
