/**
 * Content hashing helper for integrity fields (image asset SHA-256 per the
 * surface/block formats). Uses the platform WebCrypto SubtleCrypto API,
 * available in every supported host (browsers, Node ≥ 18).
 */

const HEX = '0123456789abcdef';

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = '';
  for (const byte of view) {
    out += HEX[byte >> 4]! + HEX[byte & 0xf]!;
  }
  return out;
}

/** SHA-256 of `data` as a lowercase hex string. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = (
    globalThis as {
      crypto?: { subtle?: { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> } };
    }
  ).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('WebCrypto SubtleCrypto is unavailable in this environment');
  }
  // Copy into a plain ArrayBuffer so shared-buffer views hash stably.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return toHex(await subtle.digest('SHA-256', copy.buffer));
}
