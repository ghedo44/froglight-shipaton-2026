import { ManifestValidationError, ALL_PERMISSIONS, SDK_VERSION } from '@froglight/sdk';

/**
 * Plugin Manifest — versioned descriptor validated before any code loads.
 * Unknown fields are preserved per open-format rules; unknown
 * `manifestVersion` is a hard failure.
 */

export const KNOWN_MANIFEST_KEYS = new Set([
  'manifestVersion',
  'id',
  'version',
  'froglightSdk',
  'permissions',
  'capabilities',
  'platforms',
  'signature',
  'integrity',
]);

export interface PluginCapabilities {
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
}

export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly froglightSdk: string;
  readonly permissions: readonly string[];
  readonly capabilities?: PluginCapabilities;
  readonly platforms?: readonly string[];
  readonly signature?: string;
  readonly integrity?: string;
  /** Preserved unknown extension fields. */
  readonly unknownFields?: Record<string, unknown>;
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/.test(v);
}

function isSemverRange(range: string): boolean {
  return range === '*' || /^(\^|~|>=)?\d+\.\d+\.\d+$/.test(range);
}

function satisfiesSdkRange(
  range: string,
  sdkVersion: string = SDK_VERSION,
): boolean {
  // Before 1.0, a minor SDK revision can change the plugin contract.
  const trimmed = range.trim();
  if (trimmed === '*') return true;
  const match = /^(\^|~|>=)?(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  const sdk = /^(\d+)\.(\d+)\.(\d+)/.exec(sdkVersion);
  if (match === null || sdk === null) return false;
  const [, operator, major, minor, patch] = match;
  const requested = [Number(major), Number(minor), Number(patch)];
  const current = [Number(sdk[1]), Number(sdk[2]), Number(sdk[3])];
  const atLeast =
    current[0]! > requested[0]! ||
    (current[0] === requested[0] &&
      (current[1]! > requested[1]! ||
        (current[1] === requested[1] && current[2]! >= requested[2]!)));
  if (operator === '>=') return atLeast;
  if (operator === '^')
    return (
      atLeast &&
      current[0] === requested[0] &&
      (current[0] !== 0 ||
        (current[1] === requested[1] &&
          (current[1] !== 0 || current[2] === requested[2])))
    );
  if (operator === '~')
    return (
      atLeast && current[0] === requested[0] && current[1] === requested[1]
    );
  return current.every((part, index) => part === requested[index]);
}

function isValidPluginId(id: string): boolean {
  // reverse-DNS like froglight.example or com.example.plugin
  return /^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(id) && id.length >= 3 && id.length <= 128;
}

function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

function validatePermissionEntry(entry: unknown, issues: string[]): string | null {
  if (typeof entry !== 'string' || entry.length === 0) {
    issues.push(`permission must be non-empty string, got ${JSON.stringify(entry)}`);
    return null;
  }
  // Scoped syntax reserved: base:scope where base must be known.
  const colonIdx = entry.indexOf(':');
  if (colonIdx !== -1) {
    const base = entry.slice(0, colonIdx);
    if (!(ALL_PERMISSIONS as readonly string[]).includes(base)) {
      issues.push(`unknown permission base "${base}" in scoped permission "${entry}"`);
      return null;
    }
    // Validate scoped part not empty? Allow any non-empty after colon.
    const scope = entry.slice(colonIdx + 1);
    if (scope.length === 0) {
      issues.push(`scoped permission "${entry}" missing scope after ":"`);
      return null;
    }
    // Reserved — validated but not enforced.
    return entry;
  }
  if (!(ALL_PERMISSIONS as readonly string[]).includes(entry)) {
    issues.push(`unknown permission "${entry}"`);
    return null;
  }
  return entry;
}

export interface ValidateOptions {
  readonly sdkVersion?: string;
}

export function validateManifest(
  input: unknown,
  opts: ValidateOptions = {},
): PluginManifest {
  const issues: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ManifestValidationError('manifest must be an object', ['manifest must be an object']);
  }
  const obj = input as Record<string, unknown>;

  // manifestVersion — hard failure on unknown.
  const mv = obj['manifestVersion'];
  if (mv !== 1) {
    issues.push(`unsupported manifestVersion ${JSON.stringify(mv)}; expected 1`);
    throw new ManifestValidationError(`unsupported manifestVersion ${JSON.stringify(mv)}`, issues);
  }

  // id
  const id = obj['id'];
  if (typeof id !== 'string' || !isValidPluginId(id)) {
    issues.push(`invalid id ${JSON.stringify(id)}; expected reverse-DNS like "froglight.example"`);
  }

  // version semver
  const version = obj['version'];
  if (typeof version !== 'string' || !isSemver(version)) {
    issues.push(`invalid version ${JSON.stringify(version)}; expected semver like "1.0.0"`);
  }

  // froglightSdk range
  const froglightSdk = obj['froglightSdk'];
  if (typeof froglightSdk !== 'string' || !isSemverRange(froglightSdk)) {
    issues.push(`invalid froglightSdk ${JSON.stringify(froglightSdk)}; expected semver range`);
  } else if (!satisfiesSdkRange(froglightSdk, opts.sdkVersion ?? SDK_VERSION)) {
    issues.push(`incompatible froglightSdk range "${froglightSdk}" does not satisfy SDK ${opts.sdkVersion ?? SDK_VERSION}`);
  }

  // permissions
  const permsRaw = obj['permissions'];
  const permissions: string[] = [];
  if (!Array.isArray(permsRaw)) {
    issues.push(`permissions must be an array, got ${JSON.stringify(permsRaw)}`);
  } else {
    for (const p of permsRaw) {
      const ok = validatePermissionEntry(p, issues);
      if (ok !== null) permissions.push(ok);
    }
  }

  // capabilities optional
  let capabilities: PluginCapabilities | undefined;
  const capsRaw = obj['capabilities'];
  if (capsRaw !== undefined) {
    if (typeof capsRaw !== 'object' || capsRaw === null || Array.isArray(capsRaw)) {
      issues.push(`capabilities must be an object when present`);
    } else {
      const caps = capsRaw as Record<string, unknown>;
      const provides = caps['provides'];
      const requires = caps['requires'];
      const capIssues: string[] = [];
      if (provides !== undefined) {
        if (!Array.isArray(provides) || !provides.every((s) => typeof s === 'string')) {
          capIssues.push(`capabilities.provides must be string[]`);
        }
      }
      if (requires !== undefined) {
        if (!Array.isArray(requires) || !requires.every((s) => typeof s === 'string')) {
          capIssues.push(`capabilities.requires must be string[]`);
        }
      }
      // Unknown keys inside capabilities are allowed but preserved? For manifest top-level we preserve, for nested we ignore.
      if (capIssues.length > 0) issues.push(...capIssues);
      else {
        capabilities = {
          ...(provides ? { provides: provides as string[] } : {}),
          ...(requires ? { requires: requires as string[] } : {}),
        };
      }
    }
  }

  // platforms optional
  let platforms: string[] | undefined;
  const platformsRaw = obj['platforms'];
  if (platformsRaw !== undefined) {
    if (!Array.isArray(platformsRaw) || !platformsRaw.every((s) => typeof s === 'string')) {
      issues.push(`platforms must be string[] when present`);
    } else {
      platforms = platformsRaw as string[];
    }
  }

  // Signature metadata is optional and is not verified by this validator.
  const signature = obj['signature'];
  if (signature !== undefined && typeof signature !== 'string') {
    issues.push(`signature must be string when present`);
  }

  // integrity optional — when present for zip, must be hex64 or "sha256-..."
  const integrity = obj['integrity'];
  if (integrity !== undefined) {
    if (typeof integrity !== 'string' || integrity.length === 0) {
      issues.push(`integrity must be non-empty string when present`);
    } else {
      // Accept hex64 or sha256-hex
      const normalized = integrity.startsWith('sha256-') ? integrity.slice(7) : integrity;
      if (!isHex64(normalized)) {
        issues.push(`integrity must be sha256 hex (64 chars) or "sha256-<hex>", got ${JSON.stringify(integrity)}`);
      }
    }
  }

  // Collect unknown extension fields for preservation.
  const unknownFields: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) {
      unknownFields[key] = obj[key];
    }
  }

  if (issues.length > 0) {
    throw new ManifestValidationError(`manifest validation failed: ${issues.join('; ')}`, issues);
  }

  const manifest: PluginManifest = {
    manifestVersion: 1,
    id: id as string,
    version: version as string,
    froglightSdk: froglightSdk as string,
    permissions,
    ...(capabilities ? { capabilities } : {}),
    ...(platforms ? { platforms } : {}),
    ...(typeof signature === 'string' ? { signature } : {}),
    ...(typeof integrity === 'string' ? { integrity } : {}),
    ...(Object.keys(unknownFields).length > 0 ? { unknownFields } : {}),
  };
  return manifest;
}

export async function verifyIntegrity(
  bytes: Uint8Array,
  expectedIntegrity: string,
): Promise<boolean> {
  // Accept both hex and "sha256-<hex>".
  const hex = expectedIntegrity.startsWith('sha256-') ? expectedIntegrity.slice(7) : expectedIntegrity;
  const hashHex = await computeSha256Hex(bytes);
  return hashHex.toLowerCase() === hex.toLowerCase();
}

/**
 * SHA-256 via WebCrypto — available in browsers, Tauri webviews, and Node >= 18
 * through `globalThis.crypto`, so the platform bundle stays host-portable.
 */
export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await webCrypto().subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Typed accessor for the host WebCrypto implementation (browser/Node >= 18). */
function webCrypto(): { subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> } } {
  const source = globalThis as unknown as {
    crypto?: { subtle?: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> } };
  };
  const subtle = source.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto (globalThis.crypto.subtle) is unavailable in this environment');
  }
  return { subtle };
}
