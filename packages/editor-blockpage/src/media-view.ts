/**
 * Engine-owned media hydration.
 *
 * `renderHTML` in `extensions.ts` emits a static skeleton only
 * (`figure[data-flbp-*]` + placeholder + text figcaption). This module
 * hydrates live previews imperatively after each transaction — the same
 * pattern as `#syncCompositionMounts` (engine-owned derived content, never
 * a provider toolbar):
 *
 * - vault locators load OFFLINE via the bound `DocumentAssetStore`
 *   (`assets.read`), verify hash-before-render, sniff, then preview through
 *   a runtime-only blob: URL (never canonical — only element properties are
 *   set, never PM attrs, so `pmDocToModel` can never see a blob: URL).
 * - Remote locators never auto-fetch. They show a placeholder with the
 *   third-party disclosure + explicit Load button. The click runs the
 *   `fetchRemoteMedia` policy (re-validate, redirect caps, downgrade-closed,
 *   timeouts, byte caps, pin check). Failure/offline renders a placeholder
 *   with retry; canonical bytes are never rewritten on fetch failure.
 * - every caption/name/alt is set via `textContent` (text-only).
 * - SVG bytes render through `<img>` only, never inline/innerHTML
 *  video/audio use `<video controls preload="metadata">` /
 *   `<audio controls preload="metadata">` with no autoplay and no remote
 *   prefetch; files render an attachment row (name, size, open/save via the
 *   blob URL after a successful load).
 */

import type {
  BlockPageEditorInput,
  DocumentAssetStore,
} from '@froglight/foundation';
import { sha256Hex } from '@froglight/foundation';
import {
  MAX_MEDIA_BYTES,
  REMOTE_DISCLOSURE_TEXT,
  assertUploadableBytes,
  asVaultAssetPath,
  fetchRemoteMedia,
  isFetchableRemoteUrl,
  type FetchFn,
} from './media-security.js';

export type { FetchFn };

/**
 * Typed asset/fetch seam: provider input carrying the optional
 * vault store + remote fetch bindings. Both stay optional — an unbound
 * store renders the fail-safe offline placeholder with the `unbound-store`
 * diagnostic (never a throw, never a fetch), and remote loads without a
 * fetch binding render the unavailable placeholder. The foundation seam
 * (`BlockPageEditorInput`) is unchanged; this extension is provider-local
 * so handles read `input.assets` / `input.fetchFn` with no cast.
 */
export interface BlockPageMediaEditorInput extends BlockPageEditorInput {
  readonly assets?: DocumentAssetStore | null;
  readonly fetchFn?: FetchFn | null;
}

export interface MediaViewDeps {
  readonly assets?: DocumentAssetStore | null;
  readonly fetchFn?: FetchFn | null;
  /** Observe remote placeholders for lazy disclosure (optional, gesture still required). */
  readonly observer?: IntersectionObserver | null;
  /**
   * Host picker override: when the host binds a callback it
   * receives `{blockId, kind, capture}` synchronously on Add/Capture/Replace
   * (same task as the click, preserving the file-dialog gesture). Absent —
   * the production path through `TiptapBlockpageEditorHandle`, which cannot
   * pass new deps without a handle change — the engine dispatches a
   * bubbling `flbp:pick-media` CustomEvent the host-owned
   * `input[data-flbp-media-picker]` answers (see
   * `react/BlockpageHostSkeleton.tsx`). Either way the picked bytes re-enter
   * through the existing `uploadMedia(blockId|null, bytes)` primitive, so
   * outcome-before-mutation, hash-before-preview, vault-clears-remote, and
   * the null+in-grid refusal all hold without a second ingestion path.
   */
  readonly onPickMedia?: MediaPickerFn | null;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/** Host picker request: which block wants bytes + whether it asked to capture. */
export interface MediaPickerRequest {
  readonly blockId: string;
  readonly kind: MediaKind;
  /** True for the Capture button (camera/mic hint); false for Add/Replace. */
  readonly capture: boolean;
}

export type MediaPickerFn = (request: MediaPickerRequest) => void;

/** Bubbling request event the engine fires when no `onPickMedia` is bound. */
export const MEDIA_PICK_EVENT = 'flbp:pick-media';
/** Host answer event carrying the picked files for the app to upload. */
export const MEDIA_PICKED_EVENT = 'flbp:media-picked';

interface MediaFigure {
  readonly element: HTMLElement;
  readonly kind: MediaKind;
  readonly blockId: string;
  readonly src: string;
  readonly sha256: string;
  readonly remoteUrl: string | null;
  readonly name: string | null;
  readonly caption: string | null;
  readonly alt: string;
}

const BLOB_URLS = new WeakMap<Element, string>();

function revokeFor(element: Element): void {
  const current = BLOB_URLS.get(element);
  if (current !== undefined) {
    BLOB_URLS.delete(element);
    try {
      URL.revokeObjectURL(current);
    } catch {
      // Best-effort; jsdom may lack revoke.
    }
  }
}

/** Exported for specs/teardown: revoke every tracked blob URL under `host`. */
export function revokeMediaBlobUrls(host: ParentNode): void {
  for (const el of host.querySelectorAll('[data-flbp-media-hydrated]')) {
    revokeFor(el);
  }
}

function text(el: Document, tag: string, value: string, className?: string): HTMLElement {
  const node = el.createElement(tag);
  if (className !== undefined) node.className = className;
  node.textContent = value;
  return node;
}

function readFigures(host: ParentNode): MediaFigure[] {
  const out: MediaFigure[] = [];
  const kinds: Array<[string, MediaKind]> = [
    ['figure[data-flbp-image]', 'image'],
    ['figure[data-flbp-video]', 'video'],
    ['figure[data-flbp-audio]', 'audio'],
    ['figure[data-flbp-file]', 'file'],
  ];
  for (const [selector, kind] of kinds) {
    for (const el of host.querySelectorAll(selector)) {
      const host2 = el as HTMLElement;
      const get = (name: string): string | null => host2.getAttribute(name);
      const remoteRaw = get('data-remote-url');
      out.push({
        element: host2,
        kind,
        blockId: get('data-block-id') ?? '',
        src: get('data-src') ?? '',
        sha256: get('data-sha256') ?? '',
        remoteUrl: remoteRaw !== null && remoteRaw !== '' ? remoteRaw : null,
        name: get('data-name'),
        caption: get('data-caption'),
        alt: get('data-alt') ?? '',
      });
    }
  }
  return out;
}

function labelFor(figure: MediaFigure): string {
  if (figure.caption !== null && figure.caption !== '') return figure.caption;
  if (figure.name !== null && figure.name !== '') return figure.name;
  if (figure.alt !== '') return figure.alt;
  return '';
}

function ensureStatusArea(doc: Document, figure: HTMLElement): HTMLElement {
  let status = figure.querySelector<HTMLElement>(':scope > .flbp-media-status');
  if (status === null) {
    status = doc.createElement('div');
    status.className = 'flbp-media-status';
    figure.appendChild(status);
  }
  return status;
}

function renderPlaceholder(
  doc: Document,
  figure: MediaFigure,
  message: string,
  action?: { readonly label: string; readonly onClick: () => void },
  // Machine-readable placeholder reason (missing-binding
  // diagnostic): surfaces on `data-flbp-media-reason` so hosts/tests can
  // distinguish e.g. `unbound-store` from `vault-unavailable` without
  // parsing message text. Cleared on live render.
  reason?: string,
): void {
  const { element } = figure;
  revokeFor(element);
  element.dataset.flbpMediaHydrated = 'placeholder';
  if (reason !== undefined && reason !== '') element.dataset.flbpMediaReason = reason;
  else delete element.dataset.flbpMediaReason;
  // Keep the static placeholder div + figcaption skeleton; clear prior live
  // preview nodes (marked) so re-hydration never duplicates.
  for (const stale of [...element.querySelectorAll('[data-flbp-media-live]')]) {
    stale.remove();
  }
  const status = ensureStatusArea(doc, element);
  status.textContent = '';
  status.appendChild(text(doc, 'span', message, 'flbp-media-message'));
  if (action !== undefined) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'flbp-media-action';
    button.textContent = action.label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      action.onClick();
    });
    status.appendChild(button);
  }
  // Figcaption stays text-only.
  let caption = element.querySelector<HTMLElement>(':scope > figcaption');
  if (caption === null) {
    caption = doc.createElement('figcaption');
    element.appendChild(caption);
  }
  caption.textContent = labelFor(figure);
}

function attachLive(element: HTMLElement, node: Element): void {
  node.setAttribute('data-flbp-media-live', 'true');
  // The static skeleton emits its caption before hydration. Keep live media
  // in figure order (media, caption, controls), rather than appending it below
  // the caption and making the empty skeleton look like a separate block.
  const caption = element.querySelector(':scope > figcaption');
  const status = element.querySelector(':scope > .flbp-media-status');
  if (caption !== null) element.insertBefore(node, caption);
  else if (status !== null) element.insertBefore(node, status);
  else element.appendChild(node);
}

/**
 * Empty-locator test: slash/insert placeholders unify on
 * `attachments/` + empty pin and legacy empties carry `src === ''`
 * — both mean "no bytes yet", never a vault address. Anything else (valid
 * `attachments/<hash>`, hostile traversal/absolute shapes) keeps the existing
 * vault/validation path so `assets.read` is still never reached for hostile
 * srcs. Remote locators never reach here (the gate runs first).
 */
function isEmptyMediaLocator(figure: MediaFigure): boolean {
  if (figure.remoteUrl !== null) return false;
  if (figure.src === '') return true;
  return figure.src === 'attachments/' && figure.sha256 === '';
}

/**
 * Host picker request: synchronous, gesture-preserving.
 * The engine never reads files and never touches the store here — it only
 * names the block + kind so the host-owned `input[type=file]` can open and
 * the picked bytes can re-enter through `uploadMedia(blockId, bytes)`.
 * Buttons live inside the figure status area (the Retry/Load precedent),
 * never provider toolbar DOM.
 */
function requestMediaPick(
  figure: MediaFigure,
  capture: boolean,
  deps: MediaViewDeps,
): void {
  const request: MediaPickerRequest = {
    blockId: figure.blockId,
    kind: figure.kind,
    capture,
  };
  if (deps.onPickMedia !== undefined && deps.onPickMedia !== null) {
    deps.onPickMedia(request);
    return;
  }
  try {
    figure.element.dispatchEvent(
      new CustomEvent(MEDIA_PICK_EVENT, {
        detail: request,
        bubbles: true,
        cancelable: true,
      }),
    );
  } catch {
    // Best-effort: a missing host listener is a no-op, never a throw.
  }
}

function pickButton(
  doc: Document,
  figure: MediaFigure,
  deps: MediaViewDeps,
  label: string,
  capture: boolean,
): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'flbp-media-action flbp-media-pick';
  button.textContent = label;
  button.setAttribute('data-flbp-media-pick', capture ? 'capture' : 'add');
  button.setAttribute('data-block-id', figure.blockId);
  button.setAttribute('data-kind', figure.kind);
  button.setAttribute('data-capture', capture ? 'true' : 'false');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    requestMediaPick(figure, capture, deps);
  });
  return button;
}

/**
 * Empty media card: obvious Add/Capture actions opening
 * the host picker. Text-only message + buttons; outcome stays in
 * `uploadMedia`, so clicking never mutates canonical bytes and cancelling
 * the host dialog is a no-op by construction.
 */
function renderEmptyPicker(
  doc: Document,
  figure: MediaFigure,
  deps: MediaViewDeps,
): void {
  const { element } = figure;
  revokeFor(element);
  element.dataset.flbpMediaHydrated = 'placeholder';
  element.dataset.flbpMediaReason = 'no-media';
  for (const stale of [...element.querySelectorAll('[data-flbp-media-live]')]) {
    stale.remove();
  }
  const status = ensureStatusArea(doc, element);
  status.textContent = '';
  status.appendChild(
    text(doc, 'span', 'No media yet. Choose a file to preview it offline.', 'flbp-media-message'),
  );
  const row = doc.createElement('div');
  row.className = 'flbp-media-pick-row';
  row.appendChild(pickButton(doc, figure, deps, 'Add file', false));
  row.appendChild(pickButton(doc, figure, deps, 'Capture', true));
  status.appendChild(row);
  let caption = element.querySelector<HTMLElement>(':scope > figcaption');
  if (caption === null) {
    caption = doc.createElement('figcaption');
    element.appendChild(caption);
  }
  caption.textContent = labelFor(figure);
}

function blobUrlFor(bytes: Uint8Array, mime: string): string {
  const blob =
    typeof Blob === 'function'
      ? new Blob([bytes as unknown as BlobPart], { type: mime })
      : null;
  if (blob === null) return '';
  return URL.createObjectURL(blob);
}

function trackBlob(element: Element, url: string): void {
  revokeFor(element);
  if (url !== '') BLOB_URLS.set(element, url);
}

async function hydrateVault(
  doc: Document,
  figure: MediaFigure,
  deps: MediaViewDeps,
): Promise<void> {
  const { element, src, sha256 } = figure;
  const assets = deps.assets ?? null;
  if (assets === null) {
    renderPlaceholder(doc, figure, 'Media is stored in the vault. Bind storage to preview it offline.', {
      label: 'Retry',
      onClick: () => void hydrateOne(doc, figure, deps),
    }, 'unbound-store');
    return;
  }
  // doc-sourced `src` is untrusted — validate (attachments/
  // prefix + traversal mirror) BEFORE any store read. Rejection renders a
  // placeholder and never calls `assets.read`, so traversal/absolute/
  // backslash shapes can never exfiltrate vault bytes through a file-block
  // Open link. The validated typed path replaces the old `as never` cast.
  const vaultPath = asVaultAssetPath(src);
  if (vaultPath === null) {
    renderPlaceholder(doc, figure, 'This vault reference failed validation and was not read.', {
      label: 'Retry',
      onClick: () => void hydrateOne(doc, figure, deps),
    }, 'invalid-src');
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = await assets.read(vaultPath);
  } catch {
    renderPlaceholder(doc, figure, 'Vault media is unavailable offline. It is preserved; retry when storage is reachable.', {
      label: 'Retry',
      onClick: () => void hydrateOne(doc, figure, deps),
    }, 'vault-unavailable');
    return;
  }
  // Hash-before-preview: verify integrity BEFORE any render.
  // Mismatch renders a placeholder and never touches canonical bytes.
  let actual = '';
  try {
    actual = await sha256Hex(bytes);
  } catch {
    renderPlaceholder(doc, figure, 'Media failed an integrity check and was not rendered.', {
      label: 'Retry',
      onClick: () => void hydrateOne(doc, figure, deps),
    }, 'integrity');
    return;
  }
  // an empty pin fails CLOSED (same integrity placeholder as a
  // mismatch) for images and media alike — `actual` is always a 64-hex
  // digest so `''` can never compare equal. Placeholders fail the read
  // first anyway, so no legitimate vault block regresses.
  if (actual !== sha256) {
    renderPlaceholder(doc, figure, 'Media failed an integrity check and was not rendered.', {
      label: 'Retry',
      onClick: () => void hydrateOne(doc, figure, deps),
    }, 'integrity');
    return;
  }
  let sniffed: ReturnType<typeof assertUploadableBytes>;
  try {
    sniffed = assertUploadableBytes(bytes, MAX_MEDIA_BYTES);
  } catch {
    renderPlaceholder(doc, figure, 'Media exceeds the preview size cap and was not rendered.', {
      label: 'Retry',
      onClick: () => void hydrateOne(doc, figure, deps),
    }, 'too-large');
    return;
  }
  void sniffed;
  const mime = mimeForKind(figure.kind, bytes);
  const url = blobUrlFor(bytes, mime);
  if (url === '') {
    renderPlaceholder(doc, figure, 'Preview is unavailable in this host.', {
      label: 'Retry',
      onClick: () => void hydrateOne(doc, figure, deps),
    }, 'no-preview');
    return;
  }
  trackBlob(element, url);
  renderLiveMedia(doc, figure, url, bytes.byteLength);
}

function mimeForKind(kind: MediaKind, bytes: Uint8Array): string {
  // Sniffed MIME decides the blob type (never trust extensions).
  // SVG always goes through <img> with its XML MIME (never inline).
  try {
    const sniffed = assertUploadableBytes(bytes, MAX_MEDIA_BYTES);
    void kind;
    return sniffed.mime;
  } catch {
    return kind === 'image'
      ? 'image/png'
      : kind === 'video'
        ? 'video/mp4'
        : kind === 'audio'
          ? 'audio/mpeg'
          : 'application/octet-stream';
  }
}

function renderLiveMedia(
  doc: Document,
  figure: MediaFigure,
  url: string,
  size: number,
): void {
  const { element, kind, alt } = figure;
  element.dataset.flbpMediaHydrated = 'live';
  delete element.dataset.flbpMediaReason;
  for (const stale of [...element.querySelectorAll('[data-flbp-media-live]')]) {
    stale.remove();
  }
  // Filled media is edited from the shared contextual toolbar. Remove any
  // placeholder/retry status so it cannot reserve space or duplicate the
  // toolbar's Replace action; empty/error/remote-gate states recreate their
  // explicit local recovery status through `ensureStatusArea`.
  element.querySelector(':scope > .flbp-media-status')?.remove();
  if (kind === 'image') {
    // SVG rule: remote or vault SVG renders ONLY via <img>
    // (external subresources blocked by the element sandbox below); never
    // inline via innerHTML. Note: `<img>`-gated SVG cannot execute script
    // and cannot load external references (no foreignObject/script, and
    // subresource loads are confined to the image sandbox), so hostile
    // markup degrades to a broken image instead of code execution.
    const img = doc.createElement('img');
    img.className = 'flbp-media-img';
    img.decoding = 'async';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.alt = alt;
    img.src = url;
    attachLive(element, img);
  } else if (kind === 'video') {
    const video = doc.createElement('video');
    video.className = 'flbp-media-video';
    video.controls = true;
    video.preload = 'metadata';
    video.setAttribute('referrerpolicy', 'no-referrer');
    // No autoplay: setting `src` with preload=metadata fetches headers only.
    video.src = url;
    if (alt !== '') video.setAttribute('aria-label', alt);
    attachLive(element, video);
  } else if (kind === 'audio') {
    const audio = doc.createElement('audio');
    audio.className = 'flbp-media-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.setAttribute('referrerpolicy', 'no-referrer');
    audio.src = url;
    if (alt !== '') audio.setAttribute('aria-label', alt);
    attachLive(element, audio);
  } else {
    const row = doc.createElement('div');
    row.className = 'flbp-media-file';
    const name = figure.name ?? figure.caption ?? 'Attachment';
    row.appendChild(text(doc, 'span', name, 'flbp-media-file-name'));
    row.appendChild(text(doc, 'span', formatSize(size), 'flbp-media-file-size'));
    const open = doc.createElement('a');
    open.className = 'flbp-media-file-open';
    open.textContent = 'Open / save';
    open.href = url;
    open.rel = 'noopener';
    open.referrerPolicy = 'no-referrer';
    const suggested = basenameOf(figure.name) ?? 'attachment';
    open.setAttribute('download', suggested);
    row.appendChild(open);
    attachLive(element, row);
  }
  let caption = element.querySelector<HTMLElement>(':scope > figcaption');
  if (caption === null) {
    caption = doc.createElement('figcaption');
    element.appendChild(caption);
  }
  caption.textContent = labelFor(figure);
}

/**
 * Download filename sanitizer: basename only — a hostile
 * `name` carrying `/`/`\` segments, `..`, or surrounding whitespace can
 * never escape into a path via the `download` attribute.
 */
function basenameOf(name: string | null): string | null {
  if (name === null) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const trimmed = base.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return null;
  return trimmed;
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function renderRemoteGate(doc: Document, figure: MediaFigure, deps: MediaViewDeps): void {
  const { element, remoteUrl } = figure;
  revokeFor(element);
  element.dataset.flbpMediaHydrated = 'remote-gate';
  delete element.dataset.flbpMediaReason;
  for (const stale of [...element.querySelectorAll('[data-flbp-media-live]')]) {
    stale.remove();
  }
  const status = ensureStatusArea(doc, element);
  status.textContent = '';
  // Disclosure first: third-party contact is explicit.
  status.appendChild(text(doc, 'span', REMOTE_DISCLOSURE_TEXT, 'flbp-media-disclosure'));
  if (remoteUrl !== null) {
    status.appendChild(text(doc, 'span', ` Source: ${remoteUrl}`, 'flbp-media-source'));
  }
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'flbp-media-action';
  button.textContent = 'Load remote media';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    void loadRemote(doc, figure, deps);
  });
  status.appendChild(button);
  // index/preview-prefetch never fetches — this gate performs NO
  // fetch on render, on visibility, or on indexing. Only the click above
  // (an explicit per-block gesture) contacts the network.
  if (deps.observer !== undefined && deps.observer !== null) {
    try {
      deps.observer.observe(element);
    } catch {
      // Best-effort lazy marking; the gate never auto-loads regardless.
    }
  }
  let caption = element.querySelector<HTMLElement>(':scope > figcaption');
  if (caption === null) {
    caption = doc.createElement('figcaption');
    element.appendChild(caption);
  }
  caption.textContent = labelFor(figure);
}

async function loadRemote(
  doc: Document,
  figure: MediaFigure,
  deps: MediaViewDeps,
): Promise<void> {
  const { element, remoteUrl, sha256 } = figure;
  if (remoteUrl === null || !isFetchableRemoteUrl(remoteUrl)) {
    renderPlaceholder(doc, figure, 'This remote address failed validation and was not fetched.', {
      label: 'Retry',
      onClick: () => renderRemoteGate(doc, figure, deps),
    });
    return;
  }
  const fetchFn = deps.fetchFn ?? null;
  if (fetchFn === null && typeof fetch === 'function') {
    // Default to the host fetch only when the caller did not inject one.
    // Specs always inject a mock (never real network in tests).
    await runFetch(doc, figure, deps, fetch as unknown as FetchFn, remoteUrl, sha256, captureSig(element));
    return;
  }
  if (fetchFn === null) {
    renderPlaceholder(doc, figure, 'Remote fetch is unavailable in this host. The block is preserved.', {
      label: 'Retry',
      onClick: () => renderRemoteGate(doc, figure, deps),
    }, 'no-fetch');
    return;
  }
  await runFetch(doc, figure, deps, fetchFn, remoteUrl, sha256, captureSig(element));
  void element;
}

/**
 * Generation guard: the locator may change while a gated fetch
 * is in flight (re-sync re-renders the gate with a new signature) — the
 * in-flight bytes must never render over the newer state.
 */
function captureSig(element: HTMLElement): string | undefined {
  return element.dataset.flbpMediaSig;
}

async function runFetch(
  doc: Document,
  figure: MediaFigure,
  deps: MediaViewDeps,
  fetchFn: FetchFn,
  remoteUrl: string,
  pin: string,
  expectedSig: string | undefined,
): Promise<void> {
  const status = ensureStatusArea(doc, figure.element);
  status.textContent = '';
  status.appendChild(text(doc, 'span', 'Loading remote media…', 'flbp-media-message'));
  // Pin applies only when it is a well-formed integrity pin; otherwise the
  // locator is availability-only by design and bytes render
  // after the policy checks without a pin comparison.
  const pinOrUndefined = /^[0-9a-f]{64}$/.test(pin) ? pin : undefined;
  const result = await fetchRemoteMedia(remoteUrl, fetchFn, {
    ...(pinOrUndefined !== undefined ? { pin: pinOrUndefined } : {}),
  });
  if (!result.ok) {
    const message =
      result.reason === 'downgrade'
        ? 'Remote load refused an insecure redirect and was not fetched.'
        : result.reason === 'pin-mismatch'
          ? 'Remote media failed an integrity check and was not rendered.'
          : result.reason === 'too-large'
            ? 'Remote media exceeds the preview size cap and was not rendered.'
            : result.reason === 'timeout'
              ? 'Remote load timed out. The block is preserved.'
              : 'Remote media is unreachable offline. The block is preserved.';
    // Canonical bytes are NEVER rewritten on fetch failure:
    // only the placeholder changes, with a user-driven retry.
    renderPlaceholder(doc, figure, message, {
      label: 'Retry',
      onClick: () => renderRemoteGate(doc, figure, deps),
    });
    return;
  }
  // Validate + sniff before any render (hash-before-preview for
  // remote bytes too; pin already checked inside the fetch policy).
  try {
    assertUploadableBytes(result.bytes, MAX_MEDIA_BYTES);
  } catch {
    renderPlaceholder(doc, figure, 'Remote media exceeds the preview size cap and was not rendered.', {
      label: 'Retry',
      onClick: () => renderRemoteGate(doc, figure, deps),
    }, 'too-large');
    return;
  }
  if (figure.element.dataset.flbpMediaSig !== expectedSig) return;
  const url = blobUrlFor(result.bytes, mimeForKind(figure.kind, result.bytes));
  if (url === '') {
    renderPlaceholder(doc, figure, 'Preview is unavailable in this host.', {
      label: 'Retry',
      onClick: () => renderRemoteGate(doc, figure, deps),
    }, 'no-preview');
    return;
  }
  trackBlob(figure.element, url);
  // Sandboxed render: locked-down elements with no script —
  // <img> (even for SVG), controlled <video>/<audio>, file row. The REMOTE
  // bytes never execute; no raw HTML reaches the DOM (textContent only).
  renderLiveMedia(doc, figure, url, result.bytes.byteLength);
}

async function hydrateOne(
  doc: Document,
  figure: MediaFigure,
  deps: MediaViewDeps,
): Promise<void> {
  // Remote is opt-in and NEVER auto-fetches: the gate renders
  // disclosure + Load. Vault renders offline immediately (no network).
  // Empty placeholders render the host picker directly WITHOUT any store
  // read: `attachments/` + empty pin is "no bytes yet", not a vault
  // address, so it must never reach `assets.read`.
  if (figure.remoteUrl !== null) {
    renderRemoteGate(doc, figure, deps);
    return;
  }
  if (isEmptyMediaLocator(figure)) {
    renderEmptyPicker(doc, figure, deps);
    return;
  }
  if (figure.src !== '') {
    await hydrateVault(doc, figure, deps);
    return;
  }
  renderEmptyPicker(doc, figure, deps);
}

/**
 * Hydrate every media figure under `host`. Vault figures load eagerly
 * (offline vault reads, no network); remote figures render the
 * disclosure gate and never fetch until the per-block Load gesture.
 */
export async function syncMediaViews(
  host: ParentNode,
  deps: MediaViewDeps,
): Promise<void> {
  const doc =
    (host as unknown as { ownerDocument?: Document }).ownerDocument ??
    (typeof document !== 'undefined' ? document : null);
  if (doc === null) return;
  for (const figure of readFigures(host)) {
    // Re-hydration guard: live vault previews persist across syncs unless
    // their locator changed (compare the hydrated signature). Remote gates
    // never auto-advance past the gate on re-sync (a loaded remote stays
    // loaded; a gate stays a gate until the gesture).
    const sig = `${figure.kind}|${figure.src}|${figure.sha256}|${figure.remoteUrl ?? ''}|${figure.caption ?? ''}|${figure.name ?? ''}|${figure.alt}`;
    if (figure.element.dataset.flbpMediaSig === sig) continue;
    figure.element.dataset.flbpMediaSig = sig;
    await hydrateOne(doc, figure, deps);
  }
}
