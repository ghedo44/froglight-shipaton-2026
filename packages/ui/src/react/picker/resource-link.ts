/**
 * Stable resource-link codec for surface reference copy-link.
 *
 * `copy-link` copies a stable identity string that resolves back to the
 * exact `ResourceTarget` (documentId/kindId/resourceId/address?) — never a
 * browser URL, never a display path/title. The codec is plain JSON with
 * canonical key order so copies are deterministic and clipboard round-trips
 * are byte-stable. Unknown/malformed text parses to `null` (never throws)
 * so paste targets can show a recoverable error instead of crashing.
 */

import { isResourceTarget, type ResourceTarget } from '@froglight/foundation';

/**
 * Serialize a `ResourceTarget` to its stable clipboard form. Key order is
 * fixed (documentId, kindId, resourceId, address?) so identical targets
 * always produce identical strings. Empty addresses are omitted (never
 * serialized as `""`, which no parser accepts), mirroring the application
 * codec (`packages/application/src/link-resolution.ts:108-117`) byte for
 * byte so copies stay cross-codec compatible.
 */
export function formatResourceLink(target: ResourceTarget): string {
  const ordered: Record<string, string> = {
    documentId: target.documentId,
    kindId: target.kindId,
    resourceId: target.resourceId,
  };
  if (target.address !== undefined && target.address !== '')
    ordered.address = target.address;
  return JSON.stringify(ordered);
}

/**
 * Parse clipboard text back to a `ResourceTarget`. Returns the target when
 * the text is exactly `formatResourceLink` output (extra unknown members
 * are ignored only when the four identity members validate); otherwise
 * returns `null`. Never throws and never resolves browser URLs: non-string
 * input and strings starting with a URL scheme are rejected outright.
 */
export function parseResourceLink(text: unknown): ResourceTarget | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isResourceTarget(parsed)) return null;
  const target = parsed as ResourceTarget;
  const ordered: ResourceTarget = {
    documentId: target.documentId,
    kindId: target.kindId,
    resourceId: target.resourceId,
    ...(target.address !== undefined ? { address: target.address } : {}),
  };
  return ordered;
}

/**
 * Write a resource link to the clipboard. Prefers
 * `navigator.clipboard.writeText` and falls back to a hidden-textarea
 * `execCommand('copy')` for hosts without async clipboard. Resolves `true`
 * on success, `false` when no clipboard path is available. Never rejects.
 */
export async function copyResourceLink(target: ResourceTarget): Promise<boolean> {
  const text = formatResourceLink(target);
  try {
    const clipboard = (globalThis as unknown as {
      navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } };
    }).navigator?.clipboard;
    if (clipboard?.writeText !== undefined) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  try {
    if (typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok =
      typeof document.execCommand === 'function'
        ? document.execCommand('copy')
        : false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
