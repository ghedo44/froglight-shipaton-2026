/**
 * Firebase provider configuration seam.
 *
 * Hosts supply the public Firebase web config; nothing here is secret
 * The client `apiKey` is a public identifier, API-restricted
 * in the Firebase console — secret keys never enter source or config).
 * Firebase is not mandatory for local development: a null/absent config
 * means the provider reports `NOT_CONFIGURED` while local Froglight keeps
 * working.
 */

/** Public Firebase web config, supplied by hosts (never hardcoded). */
export interface FirebaseProviderConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly storageBucket: string;
  readonly appId: string;
  /**
   * Local Firebase Auth emulator URL (for example
   * `http://127.0.0.1:9099`) used for manual verification. Never set in
   * production; CI never requires it.
   */
  readonly authEmulatorUrl?: string;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate an unknown value as a complete Firebase provider config.
 * Returns the normalized config, or null when absent/incomplete — null
 * selects the unconfigured fallback transport instead of failing boot.
 */
export function resolveFirebaseProviderConfig(
  value: unknown,
): FirebaseProviderConfig | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const apiKey = asNonEmptyString(record.apiKey);
  const authDomain = asNonEmptyString(record.authDomain);
  const projectId = asNonEmptyString(record.projectId);
  const storageBucket = asNonEmptyString(record.storageBucket);
  const appId = asNonEmptyString(record.appId);
  if (
    apiKey === null ||
    authDomain === null ||
    projectId === null ||
    storageBucket === null ||
    appId === null
  ) {
    return null;
  }
  const authEmulatorUrl = asNonEmptyString(record.authEmulatorUrl);
  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    appId,
    ...(authEmulatorUrl !== null ? { authEmulatorUrl } : {}),
  };
}
