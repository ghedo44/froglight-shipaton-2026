/**
 * Deterministic headless block-page editor handle — the no-DOM fallback of
 * the headless provider (mirrors MarkdownDocumentEditorProvider's headless mode).
 * Edits operate on canonical plain data with snapshot undo/redo; opaque
 * records are never touched.
 */

import {
  paragraphBlock,
  type BlockPageEditorHandle,
  type BlockPageEditorInput,
  type BlockPageModel,
  type DocumentAssetStore,
} from '@froglight/foundation';
import { cloneModel, newBlockId } from './model-edit.js';
import { MAX_MEDIA_BYTES, asCommittedUploadLocator, mediaSourceToBytes, prepareMediaBytes } from './media-security.js';

export interface HeadlessMediaInput {
  readonly assets?: DocumentAssetStore | null;
}

export class HeadlessBlockpageEditorHandle implements BlockPageEditorHandle {
  applyDocumentMetadata(meta: BlockPageModel['meta']): void {
    this.#model.meta = meta;
  }
  #model: BlockPageModel;
  readonly #onDirtyModel: (model: BlockPageModel) => void;
  readonly #assets: DocumentAssetStore | null;
  readonly #undo: string[] = [];
  readonly #redo: string[] = [];
  #focused = false;
  #destroyed = false;
  #readOnly = false;

  constructor(input: BlockPageEditorInput & HeadlessMediaInput) {
    this.#model = cloneModel(input.initialModel);
    this.#onDirtyModel = input.onDirtyModel;
    this.#assets = input.assets ?? null;
  }

  appendParagraph(text: string): void {
    this.requireAlive();
    if (this.#readOnly) return;
    const next = cloneModel(this.#model);
    const id = newBlockId('p');
    next.blocks[id] = paragraphBlock(id, [{ text }]);
    next.rootOrder.push(id);
    this.commit(next);
  }

  deleteLastBlock(): void {
    this.requireAlive();
    if (this.#readOnly) return;
    const next = cloneModel(this.#model);
    const id = next.rootOrder.pop();
    if (id !== undefined) delete next.blocks[id];
    this.commit(next);
  }

  getModelForTest(): BlockPageModel {
    return this.#model;
  }

  /**
   * Headless vault ingestion twin (replaceability): same
   * bytes → cap + sniff + sha256 → vault-relative src shape as the Tiptap
   * `uploadMedia`, over canonical plain data. Writes through the bound
   * asset store when present; without one the same canonical `{src,
   * sha256}` commits (reads then miss and render the offline placeholder).
   * Outcome-before-mutation: validation failures return false with no model
   * change and no dirty signal.
   */
  async uploadMedia(
    blockId: string | null,
    source: Uint8Array | ArrayBuffer | { arrayBuffer(): Promise<ArrayBuffer> },
    options?: { readonly fileName?: string; readonly kind?: 'image' | 'video' | 'audio' | 'file' },
  ): Promise<boolean> {
    this.requireAlive();
    if (this.#readOnly) return false;
    // Single-read reuse: convert once, then hash and store
    // from the same bytes — mirrors the Tiptap path exactly.
    let bytes: Uint8Array;
    try {
      bytes = await mediaSourceToBytes(source, { byteCap: MAX_MEDIA_BYTES });
    } catch {
      return false;
    }
    let prepared: Awaited<ReturnType<typeof prepareMediaBytes>>;
    try {
      prepared = await prepareMediaBytes(bytes, {
        byteCap: MAX_MEDIA_BYTES,
        ...(options?.fileName !== undefined ? { suggestedName: options.fileName } : {}),
      });
    } catch {
      return false;
    }
    // Store owns naming: commit the returned vault path + pin
    // (see the Tiptap twin for the rationale); byte-identity with the
    // Tiptap path is pinned by the convergence spec. The returned locator
    // is re-validated (vault path + hex pin) BEFORE commit — a rogue/buggy
    // store returning `../../evil` refuses with no model change.
    let src = prepared.src;
    let sha256 = prepared.sha256;
    if (this.#assets !== null) {
      try {
        const stored = await this.#assets.put(bytes, {
          ...(options?.fileName !== undefined ? { suggestedName: options.fileName } : {}),
        });
        const committed = asCommittedUploadLocator(stored);
        if (committed === null) return false;
        src = committed.src;
        sha256 = committed.sha256;
      } catch {
        return false;
      }
    }
    const next = cloneModel(this.#model);
    // Null-create kind inference (R1): an explicit options.kind wins;
    // otherwise derive from the sniffed MIME with the same mapping as the
    // Tiptap null path (image/*→image, video/*→video, audio/*→audio, else
    // file) — never the unconditional 'image' default. prepared.mime is
    // the sniff result already computed above.
    const kind: 'image' | 'video' | 'audio' | 'file' =
      options?.kind ??
      (prepared.mime.startsWith('image/')
        ? 'image'
        : prepared.mime.startsWith('video/')
          ? 'video'
          : prepared.mime.startsWith('audio/')
            ? 'audio'
            : 'file');
    if (blockId !== null) {
      const record = next.blocks[blockId];
      if (record === undefined) return false;
      if (
        record.type !== 'froglight.image' &&
        record.type !== 'froglight.video' &&
        record.type !== 'froglight.audio' &&
        record.type !== 'froglight.file'
      ) {
        return false;
      }
      const { remote: _drop, ...rest } = record as Record<string, unknown>;
      void _drop;
      next.blocks[blockId] = {
        ...(rest as Record<string, unknown>),
        id: blockId,
        src,
        sha256,
      } as never;
    } else {
      const id = newBlockId('m');
      const type =
        kind === 'video'
          ? 'froglight.video'
          : kind === 'audio'
            ? 'froglight.audio'
            : kind === 'file'
              ? 'froglight.file'
              : 'froglight.image';
      next.blocks[id] = {
        id,
        type,
        src,
        sha256,
        // Presentation defaults mirror the Tiptap null-create canonical:
        // its PM null name/caption decode away, leaving only alt:'' — so
        // headless commits alt:'' (not nulls) for byte-identity.
        alt: '',
      } as never;
      next.rootOrder.push(id);
    }
    this.commit(next);
    return true;
  }

  focus(): void {
    this.requireAlive();
    this.#focused = true;
  }

  hasFocus(): boolean {
    return !this.#destroyed && this.#focused;
  }

  setReadOnly(readOnly: boolean): void {
    this.requireAlive();
    this.#readOnly = readOnly;
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#undo.length > 0 : this.#redo.length > 0;
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    this.requireAlive();
    if (this.#readOnly) return false;
    if (id === 'undo' && this.#undo.length > 0) {
      const previous = JSON.parse(this.#undo.pop()!) as BlockPageModel;
      this.#redo.push(JSON.stringify(this.#model));
      this.#model = previous;
      this.#onDirtyModel(previous);
      return true;
    }
    if (id === 'redo' && this.#redo.length > 0) {
      const next = JSON.parse(this.#redo.pop()!) as BlockPageModel;
      this.#undo.push(JSON.stringify(this.#model));
      this.#model = next;
      this.#onDirtyModel(next);
      return true;
    }
    return false;
  }

  /**
   * Resolve-only reveal seam: the opaque address is a
   * block id passed verbatim. Returns true iff the id names a block in the
   * canonical model. Never focuses, never marks dirty, never throws on
   * unknown addresses (false) — only a destroyed handle reports false.
   */
  revealAddress(address: string): boolean {
    if (this.#destroyed) return false;
    if (typeof address !== 'string' || address === '') return false;
    return this.#model.blocks[address] !== undefined;
  }

  destroy(): void {
    this.#destroyed = true;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  private commit(next: BlockPageModel): void {
    this.#undo.push(JSON.stringify(this.#model));
    this.#redo.length = 0;
    this.#model = next;
    this.#onDirtyModel(next);
  }

  private requireAlive(): void {
    if (this.#destroyed)
      throw new Error('HeadlessBlockpageEditorHandle is destroyed');
  }
}
