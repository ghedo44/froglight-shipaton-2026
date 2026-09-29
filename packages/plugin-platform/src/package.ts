import { validateManifest, type PluginManifest } from './manifest.js';
import { verifyIntegrity, computeSha256Hex } from './manifest.js';
import { ManifestValidationError } from '@froglight/sdk';

export type PluginPackageSource = 'folder' | 'zip';

export interface PluginPackage {
  readonly manifest: PluginManifest;
  readonly source: PluginPackageSource;
  /** For zip packages, the raw bytes of the package (manifest + code). */
  readonly bytes?: Uint8Array;
  /** Code string for trusted plugins (folder) or extracted zip code. */
  readonly code?: string;
}

/**
 * Validate and load a Plugin Package.
 *
 * - Folder: { manifest.json, main.js } — no integrity required, trust marked explicitly.
 * - Zip: { manifest.json + integrity sha256 } — verify sha256 before execution.
 *
 * Unknown manifest fields are preserved; unknown manifestVersion is hard failure
 * without creating a Fiber.
 */

export interface LoadPackageOptions {
  readonly source: PluginPackageSource;
  /** Raw manifest JSON object (already parsed). */
  readonly manifestJson: unknown;
  /** Raw bytes for integrity check (zip path). */
  readonly bytes?: Uint8Array;
  /** Code string if available. */
  readonly code?: string;
  readonly sdkVersion?: string;
}

export async function loadPluginPackage(opts: LoadPackageOptions): Promise<PluginPackage> {
  const manifest = validateManifest(opts.manifestJson, { sdkVersion: opts.sdkVersion });

  if (opts.source === 'zip') {
    const integrity = manifest.integrity;
    if (!integrity) {
      // Zip packages require an integrity digest before code is loaded.
      throw new ManifestValidationError('zip package missing integrity', ['zip package missing integrity']);
    }
    if (!opts.bytes) {
      throw new ManifestValidationError('zip package missing bytes for integrity check', ['zip package missing bytes']);
    }
    const ok = await verifyIntegrity(opts.bytes, integrity);
    if (!ok) {
      throw new ManifestValidationError(`integrity mismatch for ${manifest.id}`, [`integrity mismatch: expected ${integrity}`]);
    }
  }

  // Folder packages with integrity are allowed but not required — we ignore if present.
  return {
    manifest,
    source: opts.source,
    bytes: opts.bytes,
    code: opts.code,
  };
}

// Helper to compute integrity for tests/tools.
export function computeIntegrity(bytes: Uint8Array): Promise<string> {
  return computeSha256Hex(bytes);
}
