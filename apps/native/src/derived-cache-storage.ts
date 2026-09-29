/**
 * Tauri implementation of the host-owned derived-cache storage port
 * (final scalability pass, item 4; binary-transport repair).
 *
 * Records live under the application cache directory (non-user-content),
 * one compact binary file per document. The Rust side writes them as raw
 * bytes with an atomic temp-file rename.
 *
 * Transport (no per-byte JSON number arrays):
 *
 * ```text
 * desktop / iOS: raw binary request body + document id header;
 *                raw ArrayBuffer response
 * Android      : base64 JSON string (Tauri cannot read raw request
 *                bodies on Android) — one linear encode/decode, never
 *                `Array.from(Uint8Array)`
 * ```
 *
 * This is disposable cache data: any failure degrades to a cache miss,
 * never to an open/edit failure, and it is never part of vault sync.
 */

import { invoke } from '@tauri-apps/api/core';
import type { DerivedCacheStoragePort } from '@froglight/foundation';

/** Header carrying the document id on the raw-binary save path. */
export const DERIVED_CACHE_DOCUMENT_HEADER = 'x-froglight-derived-document';

/**
 * Android's postMessage IPC cannot read raw request bodies, so the
 * Tauri-documented base64 string path is used there. Detection mirrors
 * the runtime's own `osName !== 'android'` check.
 */
function isAndroidHost(): boolean {
  try {
    return /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CODES = new Uint8Array(64);
for (let i = 0; i < 64; i++) {
  BASE64_CODES[i] = BASE64_ALPHABET.charCodeAt(i);
}
const BASE64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(i)] = i;
}

/**
 * Linear base64 encode (table-driven typed-array fill + one ASCII decode;
 * never per-byte arrays, never giant spread calls).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const length = bytes.length;
  const outLength = Math.ceil(length / 3) * 4;
  const out = new Uint8Array(outLength);
  let o = 0;
  let i = 0;
  for (; i + 2 < length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out[o++] = BASE64_CODES[b0 >> 2]!;
    out[o++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out[o++] = BASE64_CODES[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    out[o++] = BASE64_CODES[b2 & 0x3f]!;
  }
  const remaining = length - i;
  if (remaining === 1) {
    const b0 = bytes[i]!;
    out[o++] = BASE64_CODES[b0 >> 2]!;
    out[o++] = BASE64_CODES[(b0 & 0x03) << 4]!;
    out[o++] = 0x3d; // '='
    out[o++] = 0x3d;
  } else if (remaining === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out[o++] = BASE64_CODES[b0 >> 2]!;
    out[o++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out[o++] = BASE64_CODES[(b1 & 0x0f) << 2]!;
    out[o++] = 0x3d;
  }
  if (typeof TextDecoder === 'function') {
    return new TextDecoder('ascii').decode(out);
  }
  // Fallback: chunked fromCharCode over the (ASCII) encoded bytes.
  let text = '';
  const CHUNK = 0x2000;
  for (let offset = 0; offset < out.length; offset += CHUNK) {
    text += String.fromCharCode(...out.subarray(offset, offset + CHUNK));
  }
  return text;
}

/** Linear base64 decode (single pass, no `atob`/number-array expansion). */
export function base64ToBytes(encoded: string): Uint8Array {
  const length = encoded.length;
  // Upper bound; trailing '=' quantizes down naturally.
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < length; i++) {
    const code = encoded.charCodeAt(i);
    const value = code < 128 ? BASE64_LOOKUP[code]! : -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.slice(0, o);
}

/** Let input and painting run between large bridge conversion chunks. */
function yieldToInput(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  return scheduler?.yield !== undefined
    ? scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));
}

export async function bytesToBase64Async(bytes: Uint8Array): Promise<string> {
  // A multiple of three keeps padding exclusively in the final chunk.
  const chunkBytes = 192 * 1024;
  if (bytes.length <= chunkBytes) return bytesToBase64(bytes);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    parts.push(bytesToBase64(bytes.subarray(offset, offset + chunkBytes)));
    if (offset + chunkBytes < bytes.length) await yieldToInput();
  }
  return parts.join('');
}

export async function base64ToBytesAsync(encoded: string): Promise<Uint8Array> {
  const chunkChars = 256 * 1024;
  if (encoded.length <= chunkChars) return base64ToBytes(encoded);
  const out = new Uint8Array(Math.floor((encoded.length * 3) / 4));
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (let offset = 0; offset < encoded.length; offset += chunkChars) {
    const end = Math.min(offset + chunkChars, encoded.length);
    for (let i = offset; i < end; i++) {
      const code = encoded.charCodeAt(i);
      const value = code < 128 ? BASE64_LOOKUP[code]! : -1;
      if (value < 0) continue;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[written++] = (buffer >> bits) & 0xff;
      }
    }
    if (end < encoded.length) await yieldToInput();
  }
  return out.slice(0, written);
}

export class TauriDerivedCacheStorage implements DerivedCacheStoragePort {
  async load(documentId: string): Promise<Uint8Array | null> {
    const result = await invoke<ArrayBuffer | string | null>(
      'native_derived_cache_load',
      { documentId },
    );
    if (result === null || result === undefined) return null;
    // Android: base64 JSON string. Desktop/iOS: raw ArrayBuffer.
    const bytes =
      typeof result === 'string'
        ? result.length === 0
          ? new Uint8Array(0)
          : await base64ToBytesAsync(result)
        : result instanceof Uint8Array
          ? result
          : new Uint8Array(result);
    return bytes.byteLength === 0 ? null : bytes;
  }

  async save(documentId: string, bytes: Uint8Array): Promise<void> {
    if (isAndroidHost()) {
      await invoke('native_derived_cache_save', {
        documentId,
        data: await bytesToBase64Async(bytes),
      });
      return;
    }
    // Raw binary request body: no JSON serialization, no number array.
    await invoke('native_derived_cache_save', bytes, {
      headers: { [DERIVED_CACHE_DOCUMENT_HEADER]: documentId },
    });
  }

  async remove(documentId: string): Promise<void> {
    await invoke('native_derived_cache_remove', { documentId });
  }
}
