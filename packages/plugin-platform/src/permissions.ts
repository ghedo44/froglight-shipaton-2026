import { TRUSTED_ONLY_PERMISSIONS, PermissionDeniedError, type TrustTier } from '@froglight/sdk';
import type { PluginManifest } from './manifest.js';

/** Coarse permission check — availability != authority. */
export class PermissionBroker {
  readonly manifest: PluginManifest;
  readonly tier: TrustTier;
  readonly granted: ReadonlySet<string>;

  constructor(manifest: PluginManifest, tier: TrustTier) {
    this.manifest = manifest;
    this.tier = tier;
    this.granted = new Set(manifest.permissions);
  }

  /** Throw PermissionDenied if not granted, or if trusted-only requested by sandboxed. */
  require(permission: string): void {
    const base = permission.includes(':') ? permission.split(':')[0]! : permission;
    // Trusted-only check first — sandboxed never gets these even if somehow granted.
    if ((TRUSTED_ONLY_PERMISSIONS as readonly string[]).includes(base) && this.tier === 'sandboxed') {
      throw new PermissionDeniedError(permission, this.tier);
    }
    // Scoped grants use exact matching; they do not imply unscoped access.
    // A scoped grant like `vault.read:/notes/**` does not imply `vault.read`, and vice versa.
    const isGranted = this.granted.has(permission);
    if (!isGranted) {
      throw new PermissionDeniedError(permission, this.tier);
    }
  }

  /** Return true if permission is granted for this tier. */
  has(permission: string): boolean {
    try {
      this.require(permission);
      return true;
    } catch {
      return false;
    }
  }

  /** All permissions filter for inspection. */
  inspectGrants(): { tier: TrustTier; granted: string[]; deniedTrustedOnly: string[] } {
    return {
      tier: this.tier,
      granted: [...this.granted],
      deniedTrustedOnly: this.tier === 'sandboxed' ? [...TRUSTED_ONLY_PERMISSIONS] : [],
    };
  }
}

// Validate that a manifest's permission list is tier-appropriate at load time.
// Sandboxed manifests must not declare trusted-only permissions — we surface as validation error,
// but broker also enforces at call time for defense in depth.
export function validateTierPermissions(manifest: PluginManifest, tier: TrustTier): string[] {
  const issues: string[] = [];
  if (tier === 'sandboxed') {
    for (const p of manifest.permissions) {
      const base = p.includes(':') ? p.split(':')[0]! : p;
      if ((TRUSTED_ONLY_PERMISSIONS as readonly string[]).includes(base)) {
        issues.push(`permission "${p}" is trusted-only and not allowed for sandboxed tier`);
      }
    }
  }
  // Also ensure every permission is in closed list (already done by manifest validation) — redundant.
  return issues;
}
