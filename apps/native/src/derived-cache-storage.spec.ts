// @vitest-environment jsdom
/**
 * Native derived-cache transport (dense-document pass, item 3).
 *
 * The durable cache must never expand into a per-byte JavaScript number
 * array over Tauri IPC:
 *
 * - desktop/iOS: raw binary request body + document-id header, raw
 *   ArrayBuffer response;
 * - Android: base64 JSON string (Tauri cannot read raw request bodies on
 *   Android) — one linear encode/decode.
 *
 * Failures stay non-fatal (the caller treats them as cache misses).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
  DERIVED_CACHE_DOCUMENT_HEADER,
  TauriDerivedCacheStorage,
  base64ToBytes,
  base64ToBytesAsync,
  bytesToBase64,
  bytesToBase64Async,
} from './derived-cache-storage.js';

const mockInvoke = vi.mocked(invoke);

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36';

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value,
    configurable: true,
  });
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe('Tauri derived-cache binary transport', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    setUserAgent(DESKTOP_UA);
  });

  it('saves raw binary with a document header on desktop/iOS', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const storage = new TauriDerivedCacheStorage();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10]);
    await storage.save('vault/doc-1', bytes);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      'native_derived_cache_save',
      bytes,
      { headers: { [DERIVED_CACHE_DOCUMENT_HEADER]: 'vault/doc-1' } },
    );
    // Never a per-byte array on the payload path.
    const payload = mockInvoke.mock.calls[0]![1];
    expect(Array.isArray(payload)).toBe(false);
    expect(payload).toBeInstanceOf(Uint8Array);
  });

  it('saves base64 JSON on Android (never a number array)', async () => {
    setUserAgent(ANDROID_UA);
    mockInvoke.mockResolvedValue(undefined);
    const storage = new TauriDerivedCacheStorage();
    const bytes = new Uint8Array([0, 255, 127, 1, 2]);
    await storage.save('doc-android', bytes);
    expect(mockInvoke).toHaveBeenCalledWith('native_derived_cache_save', {
      documentId: 'doc-android',
      data: bytesToBase64(bytes),
    });
    const payload = mockInvoke.mock.calls[0]![1] as {
      data: string;
    };
    expect(typeof payload.data).toBe('string');
  });

  it('loads raw ArrayBuffer responses on desktop/iOS', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    mockInvoke.mockResolvedValue(exactBuffer(bytes));
    const storage = new TauriDerivedCacheStorage();
    const loaded = await storage.load('doc-1');
    expect(loaded).toEqual(bytes);
  });

  it('loads base64 responses on Android', async () => {
    setUserAgent(ANDROID_UA);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    mockInvoke.mockResolvedValue(bytesToBase64(bytes));
    const storage = new TauriDerivedCacheStorage();
    const loaded = await storage.load('doc-1');
    expect(loaded).toEqual(bytes);
  });

  it('treats missing/empty records as clean misses', async () => {
    const storage = new TauriDerivedCacheStorage();
    mockInvoke.mockResolvedValueOnce(null);
    expect(await storage.load('missing')).toBeNull();
    mockInvoke.mockResolvedValueOnce(new Uint8Array(0).buffer);
    expect(await storage.load('empty')).toBeNull();
    setUserAgent(ANDROID_UA);
    mockInvoke.mockResolvedValueOnce('');
    expect(await storage.load('empty-android')).toBeNull();
  });

  it('round-trips a large payload without per-byte arrays', () => {
    setUserAgent(ANDROID_UA);
    const bytes = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const encoded = bytesToBase64(bytes);
    expect(typeof encoded).toBe('string');
    const decoded = base64ToBytes(encoded);
    expect(decoded.length).toBe(bytes.length);
    let identical = true;
    for (let i = 0; i < bytes.length; i++) {
      if (decoded[i] !== bytes[i]) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(true);
    // Base64 expansion is ~4/3, never the ~3-4x JSON number-array blowup.
    expect(encoded.length).toBeLessThan(bytes.length * 1.34);
  }, 30_000);

  it('removes records through the host command', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const storage = new TauriDerivedCacheStorage();
    await storage.remove('doc-1');
    expect(mockInvoke).toHaveBeenCalledWith('native_derived_cache_remove', {
      documentId: 'doc-1',
    });
  });
});


it('cooperative base64 preserves padding and decoding across chunk boundaries', async () => {
  for (const length of [0, 1, 2, 192 * 1024, 192 * 1024 + 1, 192 * 1024 + 2]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
    const encoded = await bytesToBase64Async(bytes);
    expect(encoded).toBe(bytesToBase64(bytes));
    expect(await base64ToBytesAsync(encoded)).toEqual(bytes);
  }
  // Invalid characters are ignored just as on the synchronous bridge path,
  // including when they split base64 groups at a yield boundary.
  const spaced = ('AA A/\n').repeat(50_000);
  expect(await base64ToBytesAsync(spaced)).toEqual(base64ToBytes(spaced));
});
