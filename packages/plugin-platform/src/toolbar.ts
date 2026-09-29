import { createServiceToken } from '@froglight/runtime';

/**
 * Sandbox-safe community toolbar manifest.
 *
 * Plain data only: stable string identifiers, a human label, an approved
 * icon identifier, ordering hints, and a command id. No callbacks, no DOM,
 * no CSS, no React, no provider/editor handles, no registry objects.
 * The trusted host validates every field and owns execution routing.
 */
export interface CommunityToolbarManifest {
  readonly id: string;
  readonly targetCategoryId: string;
  readonly label: string;
  readonly icon?: string;
  readonly commandId: string;
  readonly order?: number;
  readonly showInSqueeze?: boolean;
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Validate a community toolbar manifest; returns human-readable errors. */
export function validateCommunityToolbarManifest(
  value: unknown,
): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['contribution must be an object'];
  }
  const input = value as Record<string, unknown>;
  const id = input['id'];
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    errors.push('id must be a stable namespaced identifier');
  }
  const target = input['targetCategoryId'];
  if (typeof target !== 'string' || !SAFE_ID.test(target)) {
    errors.push('targetCategoryId is invalid');
  }
  const commandId = input['commandId'];
  if (typeof commandId !== 'string' || !SAFE_ID.test(commandId)) {
    errors.push('commandId is invalid');
  }
  const label = input['label'];
  if (
    typeof label !== 'string' ||
    label.trim().length === 0 ||
    label.length > 80
  ) {
    errors.push('label must contain 1–80 characters');
  }
  const icon = input['icon'];
  if (icon !== undefined && (typeof icon !== 'string' || !SAFE_ID.test(icon))) {
    errors.push('icon must be an approved icon identifier');
  }
  const order = input['order'];
  if (
    order !== undefined &&
    (typeof order !== 'number' || !Number.isFinite(order))
  ) {
    errors.push('order must be finite');
  }
  const squeeze = input['showInSqueeze'];
  if (
    squeeze !== undefined &&
    typeof squeeze !== 'boolean'
  ) {
    errors.push('showInSqueeze must be a boolean');
  }
  // Reject function-valued fields: manifests cross the trust boundary as
  // JSON-compatible data only. A function here would be dead data at best
  // and a confused-deputy vector at worst.
  for (const key of Object.keys(input)) {
    if (typeof input[key] === 'function') {
      errors.push(`field '${key}' must be data, not a function`);
    }
  }
  return errors;
}

/**
 * Trusted-side host for community toolbar contributions.
 *
 * Implemented by the UI layer (which owns the composition + control
 * registries and the command broker). The platform facade delegates here
 * after permission + validation checks; the host re-validates and owns
 * both structure and execution registrations as one reversible effect.
 * There is exactly one registry pair (composition + document-toolbar);
 * this interface is a bridge to it, never a second registry.
 */
export interface CommunityToolbarHost {
  registerToolbar(
    pluginId: string,
    manifest: CommunityToolbarManifest,
  ): { dispose(): void };
}

/** Capability token for the trusted toolbar host. */
export const communityToolbarToken =
  createServiceToken<CommunityToolbarHost>('froglight.community-toolbar');
