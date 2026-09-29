/**
 * Media security + vault-ingestion helpers for the block-page provider
 *
 *
 * Engine-free: pure parsing/validation/fetch-policy over plain bytes. No
 * DOM, no editor types, no network unless the caller supplies a `fetch`
 * implementation — specs inject a mock, production passes `globalThis.fetch`.
 *
 * Enforcement split follows the codec comment precedent in
 * `foundation/src/blocks/model.ts` + `codec.ts`):
 *
 * - The codec validates locator *shape at rest* (https-only, no userinfo,
 *   length cap, pin format). It never fetches.
 * - THIS provider owns *fetch-time* enforcement: it MUST re-validate the
 *   URL immediately before every fetch and on every redirect hop, fail
 *   closed on http-downgrade, cap redirects/timeouts/bytes, send no
 *   credentials or referrer, and never rewrite canonical bytes with fetch
 *   outcomes. Sandboxed (untrusted-tier) plugins cannot register media
 *   types at all — registration stays trusted-provider-side in
 *   `extensions.ts` / `froglightExtensions()`; there is no registry or
 *   `definePlugin` path that lets community code add a media node.
 *
 * Brokered-grant vs gesture-gate (provider half): this provider
 * chooses GESTURE-GATE over brokered-grant. A brokered grant would mint a
 * capability token the host redeems silently; instead every remote contact
 * requires an explicit per-block user gesture — the opt-in
 * `media.remoteUrl` semantic action plus a per-render Load click. The
 * gesture is observable, revocable (clear-remote), and never implied by
 * indexing, prefetch, or visibility alone.
 */

import { sha256Hex, type WorkspacePath } from '@froglight/foundation';

/**
 * Provider-side mirror of the codec rest-time rule (`isValidRemoteMediaUrl`
 * in `foundation/src/blocks/model.ts`, NOT re-exported from the package
 * root so the provider cannot import it without a deep import that would
 * bypass the public API boundary). The codec stays the source of truth at
 * rest; THIS mirror is the fetch-time gate: re-validate
 * immediately before every fetch and every redirect hop). Pinned by the
 * same fixture list as `media-layout-contract.spec.ts` (downgrade / userinfo /
 * control bytes / single-slash / empty authority / over-long / padded).
 */
export function isFetchableRemoteUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4_096)
    return false;
  if (url !== url.trim()) return false;
  if (url.includes('\\')) return false;
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (!/^https:\/\//i.test(url)) return false;
  const afterSlashes = url.replace(/^https:\/\//i, '');
  if (
    afterSlashes === '' ||
    afterSlashes[0] === '/' ||
    afterSlashes[0] === '?' ||
    afterSlashes[0] === '#'
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname === '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  const authority =
    url
      .replace(/^https:/i, '')
      .replace(/^\/\//, '')
      .split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return false;
  return true;
}

/** Per-asset preview/ingest cap: bounds provider memory.*/
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** Remote fetch byte cap: same bound as local ingestion.*/
export const MAX_REMOTE_FETCH_BYTES = MAX_MEDIA_BYTES;

/** Remote fetch timeout per attempt.*/
export const REMOTE_FETCH_TIMEOUT_MS = 10_000;

/** Maximum redirects followed per remote load.*/
export const MAX_REMOTE_REDIRECTS = 5;

/**
 * Third-party-contact disclosure: rendered as text alongside
 * every remote placeholder/load control, never hidden behind hover.
 */
export const REMOTE_DISCLOSURE_TEXT =
  'Remote content loads from a third party on your request. Loading contacts the listed address; nothing loads automatically.';

/** Vault-relative ingestion directory (mirrors `application/asset-store`). */
export const MEDIA_ATTACHMENTS_DIR = 'attachments';

/**
 * Provider-side mirror of the codec rest-time rule (`isUnsafeAssetSrc` in
 * `foundation/src/blocks/model.ts`, NOT re-exported from the package root
 * so the provider cannot import it without a deep import that would bypass
 * the public API boundary). The codec stays the source of truth at rest;
 * THIS mirror is the hydrate-time gate: a doc-sourced `src` is
 * never handed to `assets.read` without validation). Pinned by the fixture
 * list in `media.spec.ts` (absolute / backslash / dot-dot) — any drift
 * from the foundation rule fails those specs.
 */
export function isUnsafeVaultSrc(src: unknown): boolean {
  if (typeof src !== 'string') return true;
  return (
    src.startsWith('/') || src.includes('\\') || src.split('/').includes('..')
  );
}

/**
 * Validated vault read path: a doc-sourced `src` becomes a
 * typed `WorkspacePath` ONLY when it lives under the attachments directory
 * (prefix + non-empty remainder) and passes the `isUnsafeVaultSrc` mirror.
 * Anything else yields null and the caller renders a placeholder WITHOUT
 * calling `assets.read` — traversal, absolute, and backslash shapes can
 * never reach the store. Replaces the old `as never` cast at the read
 * seam with a validated typed helper.
 */
export function asVaultAssetPath(src: unknown): WorkspacePath | null {
  if (typeof src !== 'string') return null;
  if (isUnsafeVaultSrc(src)) return null;
  const prefix = `${MEDIA_ATTACHMENTS_DIR}/`;
  if (!src.startsWith(prefix) || src.length <= prefix.length) return null;
  return src as WorkspacePath;
}

/**
 * Commit-time gate for store-returned locators (defense-in-depth): a
 * rogue/buggy custom `DocumentAssetStore.put` returning a traversal path
 * (e.g. `../../evil`) would otherwise persist a string that hard-bricks
 * the document on next open (codec FORMAT_LIMIT_EXCEEDED throw instead of
 * a graceful opaque). The path MUST re-pass `asVaultAssetPath` and the pin
 * MUST match `/^[0-9a-f]{64}$/` — anything else yields null and the caller
 * refuses the upload with no dispatch (outcome-before-mutation).
 */
export function asCommittedUploadLocator(stored: {
  readonly path: unknown;
  readonly sha256: unknown;
}): { readonly src: WorkspacePath; readonly sha256: string } | null {
  const src = asVaultAssetPath(stored.path);
  if (src === null) return null;
  if (
    typeof stored.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stored.sha256)
  )
    return null;
  return { src, sha256: stored.sha256 };
}

export type SniffedMediaKind =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'mp4'
  | 'webm'
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'pdf'
  | 'unknown';

export interface SniffedMedia {
  readonly kind: SniffedMediaKind;
  readonly mime: string;
  readonly isSvg: boolean;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Content sniffing: magic bytes decide the kind, never the
 * file extension or a claimed MIME type. SVG is detected structurally
 * (leading whitespace/BOM tolerated, then `<svg` or `<?xml` + `<svg`)
 * because it has no magic number.
 */
export function sniffMediaBytes(bytes: Uint8Array): SniffedMedia {
  if (
    bytes.length >= 8 &&
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return { kind: 'png', mime: 'image/png', isSvg: false };
  }
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'jpeg', mime: 'image/jpeg', isSvg: false };
  }
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6));
    if (head === 'GIF87a' || head === 'GIF89a') {
      return { kind: 'gif', mime: 'image/gif', isSvg: false };
    }
  }
  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { kind: 'webp', mime: 'image/webp', isSvg: false };
  }
  // ftyp box at offset 4: MP4/WebM-family containers.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (
      brand.startsWith('mp4') ||
      brand.startsWith('isom') ||
      brand.startsWith('M4V')
    ) {
      return { kind: 'mp4', mime: 'video/mp4', isSvg: false };
    }
    // M4A-family brands are audio (AAC in an MP4 container), not video:
    // surface the audio MIME so uploads land on audio blocks and previews
    // use <audio> instead of a blind <video> claim.
    if (brand.startsWith('M4A') || brand === 'M4B ' || brand === 'M4P ') {
      return { kind: 'unknown', mime: 'audio/mp4', isSvg: false };
    }
    // HEIC-family brands are still-image containers: keep the image MIME
    // (uploads land on image blocks, best-effort <img> preview).
    if (
      brand === 'heic' ||
      brand === 'heix' ||
      brand === 'hevc' ||
      brand === 'hevx' ||
      brand === 'heim' ||
      brand === 'heis'
    ) {
      return { kind: 'unknown', mime: 'image/heic', isSvg: false };
    }
    // Unknown container brand: file fallback, never a blind video claim
    // (a mislabeled preview element is itself a rendering hazard).
    return { kind: 'unknown', mime: 'application/octet-stream', isSvg: false };
  }
  if (bytes.length >= 4 && startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: 'webm', mime: 'video/webm', isSvg: false };
  }
  if (bytes.length >= 3 && startsWith(bytes, [0x49, 0x44, 0x33])) {
    return { kind: 'mp3', mime: 'audio/mpeg', isSvg: false };
  }
  if (bytes.length >= 2 && startsWith(bytes, [0xff, 0xfb])) {
    return { kind: 'mp3', mime: 'audio/mpeg', isSvg: false };
  }
  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return { kind: 'wav', mime: 'audio/wav', isSvg: false };
  }
  if (bytes.length >= 4 && startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return { kind: 'ogg', mime: 'audio/ogg', isSvg: false };
  }
  if (bytes.length >= 5 && startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { kind: 'pdf', mime: 'application/pdf', isSvg: false };
  }
  if (isSvgBytes(bytes)) {
    return { kind: 'svg', mime: 'image/svg+xml', isSvg: true };
  }
  return { kind: 'unknown', mime: 'application/octet-stream', isSvg: false };
}

/** Structural SVG probe: optional BOM/whitespace, then `<svg` or `<?xml` … `<svg`. */
export function isSvgBytes(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, 1024);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  } catch {
    return false;
  }
  // Strip BOM + leading whitespace/comments conservatively: only whitespace
  // before the root tag counts; anything else fails closed to non-SVG.
  const stripped = text.replace(/^\uFEFF/, '').trimStart();
  if (/^<svg[\s>/]/i.test(stripped)) return true;
  if (/^<\?xml[\s?]/i.test(stripped)) {
    return /<svg[\s>/]/i.test(stripped.slice(0, 1024));
  }
  return false;
}

/**
 * Hash-before-preview gate: byte cap + sniff run BEFORE any
 * hash or render. Throws on violation so callers refuse without mutation.
 */
export function assertUploadableBytes(
  bytes: Uint8Array,
  byteCap = MAX_MEDIA_BYTES,
): SniffedMedia {
  // Duck-typed (never `instanceof`): TextEncoder/jsdom realms hand back
  // views whose constructor differs from this realm's `Uint8Array`
  // (see `mediaSourceToBytes`).
  if (
    !ArrayBuffer.isView(bytes) ||
    Object.prototype.toString.call(bytes) === '[object DataView]'
  ) {
    throw new Error('media bytes must be a Uint8Array');
  }
  const view = bytes as unknown as Uint8Array;
  if (view.byteLength === 0) throw new Error('media bytes are empty');
  if (view.byteLength > byteCap) {
    throw new Error(`media exceeds the ${byteCap}-byte per-asset cap`);
  }
  return sniffMediaBytes(view);
}

/** Vault-relative ingestion path for a content hash (asset-store mirror). */
export function vaultSrcForHash(hash: string): string {
  return `${MEDIA_ATTACHMENTS_DIR}/${hash}`;
}

/**
 * Normalize an upload source to local bytes. Duck-typed (never
 * `instanceof`): jsdom specs run in a separate realm where a
 * `Uint8Array` from the test realm fails `instanceof` against the
 * provider realm's constructor. `TypedArray#set` reads indexed elements,
 * so it copies correctly across realms.
 *
 * Declared-size pre-check: when `byteCap` is supplied, exact
 * declared sizes (view/ArrayBuffer `byteLength`, Blob/File-like `size`)
 * refuse BEFORE copying or calling `arrayBuffer()` — the same outcome as
 * the post-conversion cap without allocating. A lying `size` only fails
 * early; oversized bytes are still refused after conversion.
 */
export async function mediaSourceToBytes(
  source: unknown,
  options?: { readonly byteCap?: number },
): Promise<Uint8Array> {
  const byteCap = options?.byteCap;
  if (byteCap !== undefined && typeof source === 'object' && source !== null) {
    const size = (source as { size?: unknown }).size;
    const byteLength = (source as { byteLength?: unknown }).byteLength;
    const declared =
      typeof size === 'number'
        ? size
        : typeof byteLength === 'number'
          ? byteLength
          : null;
    if (declared !== null && declared > byteCap) {
      throw new Error(`media exceeds the ${byteCap}-byte per-asset cap`);
    }
  }
  if (ArrayBuffer.isView(source)) {
    if (Object.prototype.toString.call(source) === '[object DataView]') {
      throw new Error('unsupported media source');
    }
    const view = source as unknown as {
      readonly byteLength: number;
    } & ArrayLike<number>;
    const out = new Uint8Array(view.byteLength);
    out.set(view as ArrayLike<number>);
    return out;
  }
  const tag = Object.prototype.toString.call(source);
  if (tag === '[object ArrayBuffer]') {
    const view = new Uint8Array(source as ArrayBuffer);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out;
  }
  if (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  ) {
    const buf = await (
      source as { arrayBuffer(): Promise<ArrayBuffer> }
    ).arrayBuffer();
    return mediaSourceToBytes(
      buf,
      byteCap === undefined ? undefined : { byteCap },
    );
  }
  throw new Error('unsupported media source');
}

export interface PreparedMediaUpload {
  /** Vault-relative canonical `src` (`attachments/<sha256>`). */
  readonly src: string;
  readonly sha256: string;
  readonly mime: string;
  readonly kind: SniffedMediaKind;
}

/**
 * Provider-side ingestion over already-converted bytes: cap, sniff, and
 * hash before writing a vault-relative path.
 * `{src, sha256}`. Upload entry points convert the source ONCE via
 * `mediaSourceToBytes` and share the bytes between this hash and the
 * store `put` (single-read reuse: File/Blob-likes pay one
 * `arrayBuffer()`, never two).
 *
 * Hash runs BEFORE any preview element is created; the returned
 * `src` is vault-relative (never a blob:/data: URL — those are runtime
 * preview handles only, see `media-view.ts`).
 */
export async function prepareMediaBytes(
  bytes: Uint8Array,
  options?: { readonly byteCap?: number; readonly suggestedName?: string },
): Promise<PreparedMediaUpload> {
  void options?.suggestedName;
  const sniffed = assertUploadableBytes(
    bytes,
    options?.byteCap ?? MAX_MEDIA_BYTES,
  );
  const sha256 = await sha256Hex(bytes);
  return {
    src: vaultSrcForHash(sha256),
    sha256,
    mime: sniffed.mime,
    kind: sniffed.kind,
  };
}

/**
 * Provider-side ingestion primitive (vault-write mechanism):
 *
 * bytes (Uint8Array | ArrayBuffer | Blob/File-like) → cap + sniff +
 * sha256 → vault-relative `{src, sha256}`. The caller writes `bytes` via
 * the bound `DocumentAssetStore.put` (content-addressed, idempotent —
 * same mechanism as `application/src/asset-store.ts`) and then commits
 * `{src, sha256}` to canonical in one closeHistory transaction. When no
 * store is bound (headless/tests), the caller still commits the same
 * `{src, sha256}` shape; vault reads then miss and the provider renders
 * the offline placeholder with retry — canonical bytes stay identical.
 *
 * Hash runs BEFORE any preview element is created; the returned
 * `src` is vault-relative (never a blob:/data: URL — those are runtime
 * preview handles only, see `media-view.ts`). Callers that already hold
 * converted bytes (upload paths sharing one read with the store `put`)
 * use `prepareMediaBytes` directly.
 */
export async function prepareMediaUpload(
  source:
    | Uint8Array
    | ArrayBuffer
    | { arrayBuffer(): Promise<ArrayBuffer>; size?: number },
  options?: { readonly byteCap?: number; readonly suggestedName?: string },
): Promise<PreparedMediaUpload> {
  void options?.suggestedName;
  const byteCap = options?.byteCap ?? MAX_MEDIA_BYTES;
  const bytes = await mediaSourceToBytes(source, { byteCap });
  return prepareMediaBytes(bytes, {
    byteCap,
    ...(options?.suggestedName !== undefined
      ? { suggestedName: options.suggestedName }
      : {}),
  });
}

export type FetchFn = (
  url: string,
  init?: {
    readonly method?: string;
    readonly credentials?: RequestCredentials;
    readonly redirect?: RequestRedirect;
    readonly referrerPolicy?: ReferrerPolicy;
    readonly signal?: AbortSignal | null;
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface RemoteFetchSuccess {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly finalUrl: string;
  readonly mime: string;
  readonly hops: number;
}

export interface RemoteFetchFailure {
  readonly ok: false;
  /** Stable machine-readable reason (UI renders a placeholder, never raw error text). */
  readonly reason:
    | 'invalid-url'
    | 'downgrade'
    | 'too-many-redirects'
    | 'http-error'
    | 'timeout'
    | 'too-large'
    | 'pin-mismatch'
    | 'network-error';
}

export type RemoteFetchResult = RemoteFetchSuccess | RemoteFetchFailure;

/**
 * Sandboxed remote fetch policy:
 *
 * - re-validate the URL immediately before the first fetch — not just at rest
 * - follow redirects MANUALLY (`redirect: 'manual'`), re-validating EVERY
 *   hop; any non-https hop (downgrade) fails closed without fetching it
 * - cap hops at ~5, fail closed past the cap
 * - `credentials: 'omit'` (no cookies/auth), `referrerPolicy: 'no-referrer'`
 * - per-attempt timeout (AbortController) covering headers AND the body
 *   read, pre-check `content-length` against the byte cap AND enforce the
 *   cap on actual bytes
 * - optional SHA-256 pin check: mismatch fails closed, never renders
 * - canonical bytes are NEVER rewritten here; the caller renders a
 *   placeholder with retry on any failure
 */
export async function fetchRemoteMedia(
  url: string,
  fetchFn: FetchFn,
  options?: {
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly maxRedirects?: number;
    /** Lowercase-hex SHA-256 pin; when present bytes MUST match. */
    readonly pin?: string;
  },
): Promise<RemoteFetchResult> {
  const timeoutMs = options?.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? MAX_REMOTE_FETCH_BYTES;
  const maxRedirects = options?.maxRedirects ?? MAX_REMOTE_REDIRECTS;
  if (!isFetchableRemoteUrl(url)) return { ok: false, reason: 'invalid-url' };

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!isFetchableRemoteUrl(current)) {
      return { ok: false, reason: hop === 0 ? 'invalid-url' : 'downgrade' };
    }
    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const timer =
      controller !== null
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    // The abort window covers headers AND the body read: a body
    // that only arrives after the deadline fails closed as a timeout
    // instead of rendering late bytes. Every early return below clears the
    // timer so a settled attempt never aborts a later one.
    const clearTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
    };
    const timedOut = (): boolean =>
      controller !== null && controller.signal.aborted;
    let response: Awaited<ReturnType<FetchFn>>;
    try {
      response = await fetchFn(current, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        ...(controller !== null ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      clearTimer();
      if (timedOut()) {
        return { ok: false, reason: 'timeout' };
      }
      void error;
      return { ok: false, reason: 'network-error' };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (hop >= maxRedirects) {
        clearTimer();
        return { ok: false, reason: 'too-many-redirects' };
      }
      if (location === null || location === '') {
        clearTimer();
        return { ok: false, reason: 'network-error' };
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        clearTimer();
        return { ok: false, reason: 'downgrade' };
      }
      // Fail closed on downgrade BEFORE fetching the target: any hop that
      // does not re-validate as https-only is refused, never followed.
      if (!isFetchableRemoteUrl(next)) {
        clearTimer();
        return { ok: false, reason: 'downgrade' };
      }
      current = next;
      clearTimer();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      clearTimer();
      return { ok: false, reason: 'http-error' };
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && declared !== '') {
      const n = Number(declared);
      if (Number.isFinite(n) && n > maxBytes) {
        clearTimer();
        return { ok: false, reason: 'too-large' };
      }
    }
    let raw: ArrayBuffer;
    try {
      raw = await response.arrayBuffer();
    } catch {
      clearTimer();
      if (timedOut()) return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'network-error' };
    }
    clearTimer();
    if (timedOut()) return { ok: false, reason: 'timeout' };
    const bytes = new Uint8Array(raw);
    if (bytes.byteLength > maxBytes) return { ok: false, reason: 'too-large' };
    if (options?.pin !== undefined) {
      let actual: string;
      try {
        actual = await sha256Hex(bytes);
      } catch {
        return { ok: false, reason: 'network-error' };
      }
      if (actual !== options.pin) return { ok: false, reason: 'pin-mismatch' };
    }
    const mime =
      response.headers.get('content-type') ?? 'application/octet-stream';
    return { ok: true, bytes, finalUrl: current, mime, hops: hop };
  }
  return { ok: false, reason: 'too-many-redirects' };
}
