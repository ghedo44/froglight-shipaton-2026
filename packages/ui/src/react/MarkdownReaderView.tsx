import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { DocumentSession } from '@froglight/foundation';
import { renderMarkdown } from '../markdown-render.js';
import { workspaceEvents } from '../ui-events.js';
import type { MarkdownEmbed } from '../reading/markdown-embeds.js';
import 'katex/dist/katex.min.css';
import styles from './MarkdownReaderView.module.css';

function documentIdOf(session: DocumentSession): string | null {
  const id = (session.document as { documentId?: unknown } | undefined)
    ?.documentId;
  return typeof id === 'string' ? id : null;
}

function rawOf(session: DocumentSession): string {
  const raw = (session.model as { raw?: unknown } | undefined)?.raw;
  return typeof raw === 'string' ? raw : '';
}

export interface MarkdownReaderViewHandle {
  update(): void;
  revealAddress(address: string): void;
}

export interface MarkdownReaderViewProps {
  readonly session: DocumentSession;
  readonly renderDebounceMillis?: number;
  readonly loadScroll?: (documentId: string) => number;
  readonly saveScroll?: (documentId: string, top: number) => void;
  readonly resolveEmbed?: (
    session: DocumentSession,
    destination: string,
  ) => Promise<MarkdownEmbed>;
  readonly onEmbedChange?: (listener: () => void) => { dispose(): void };
  readonly handleRef?: { current: MarkdownReaderViewHandle | null };
}

/**
 * Markdown reading-view — declarative React over the
 * `renderMarkdown` projection.
 *
 * Converted from the imperative `MarkdownReaderHandle` builder with an exact
 * behavior freeze: same host structure (`preview` plus the `fl-pane-preview`
 * and `fl-markdown-reader` hooks), same rendered markdown output, same
 * debounced update, same per-note scroll restore/persist, same bubbling
 * `openLink` dispatch from the clicked anchor, same `revealAddress`
 * escaping and smooth scroll, same destroy cleanup. Parsing logic stays
 * untouched in `../markdown-render.js`. String-emitted hooks
 * (`md-frontmatter-*`, `wiki-link`) stay global; the host surface is
 * module-owned.
 */
export function MarkdownReaderView(
  props: MarkdownReaderViewProps,
): React.ReactElement {
  const { session, handleRef } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const depsRef = useRef({
    renderDebounceMillis: props.renderDebounceMillis,
    loadScroll: props.loadScroll,
    saveScroll: props.saveScroll,
  });
  depsRef.current = {
    renderDebounceMillis: props.renderDebounceMillis,
    loadScroll: props.loadScroll,
    saveScroll: props.saveScroll,
  };
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [html, setHtml] = useState(() => renderMarkdown(rawOf(session)));
  const [embedVersion, setEmbedVersion] = useState(0);

  useLayoutEffect(() => {
    const subscription = props.onEmbedChange?.(() =>
      setEmbedVersion((version) => version + 1),
    );
    return () => subscription?.dispose();
  }, [props.onEmbedChange]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const resolve = props.resolveEmbed;
    if (host === null || resolve === undefined) return;
    let cancelled = false;
    const hydrate = async (
      container: Element,
      ancestry: readonly string[],
      depth: number,
    ): Promise<void> => {
      const placeholders = [
        ...container.querySelectorAll<HTMLElement>(
          '.md-embed[data-embed-destination]',
        ),
      ];
      await Promise.all(
        placeholders.map(async (placeholder) => {
          const destination = placeholder.dataset.embedDestination;
          if (destination === undefined) return;
          if (depth >= 8) {
            placeholder.textContent = 'Embed depth limit reached';
            return;
          }
          try {
            const embed = await resolve(sessionRef.current, destination);
            if (cancelled || !placeholder.isConnected) return;
            if (embed.kind === 'unavailable') {
              placeholder.textContent = embed.message;
              return;
            }
            if (ancestry.includes(embed.key)) {
              placeholder.textContent = 'Circular embed';
              return;
            }
            if (embed.kind === 'markdown') {
              placeholder.innerHTML = renderMarkdown(embed.raw);
              await hydrate(placeholder, [...ancestry, embed.key], depth + 1);
            } else {
              const image = document.createElement('img');
              image.src = embed.src;
              image.alt = embed.alt;
              const dimensions = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(
                placeholder.dataset.embedSize ?? '',
              );
              if (dimensions) {
                image.width = Math.min(4096, Number(dimensions[1]));
                if (dimensions[2])
                  image.height = Math.min(4096, Number(dimensions[2]));
              }
              placeholder.replaceChildren(image);
            }
          } catch {
            if (!cancelled && placeholder.isConnected)
              placeholder.textContent = 'Embedded file unavailable';
          }
        }),
      );
    };
    void hydrate(host, [documentIdOf(sessionRef.current) ?? ''], 0);
    return () => {
      cancelled = true;
    };
  }, [html, embedVersion, props.resolveEmbed]);

  const renderNow = useCallback((): void => {
    setHtml(renderMarkdown(rawOf(sessionRef.current)));
  }, []);

  const update = useCallback((): void => {
    if (renderTimerRef.current !== null) {
      clearTimeout(renderTimerRef.current);
      renderTimerRef.current = null;
    }
    const delay = depsRef.current.renderDebounceMillis ?? 0;
    if (delay <= 0) {
      renderNow();
      return;
    }
    renderTimerRef.current = setTimeout(() => {
      renderTimerRef.current = null;
      renderNow();
    }, delay);
  }, [renderNow]);

  const revealAddress = useCallback((address: string): void => {
    const host = hostRef.current;
    if (host === null) return;
    const heading = host.querySelector<HTMLElement>(
      `[data-document-address="${address.replace(/"/g, '\\"')}"]`,
    );
    heading?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, []);

  const handleClick = useCallback((event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a.wiki-link');
    if (!(anchor instanceof HTMLElement)) return;
    event.preventDefault();
    const destination = anchor.dataset.destination ?? anchor.textContent ?? '';
    anchor.dispatchEvent(
      new CustomEvent(workspaceEvents.openLink, {
        detail: { destination },
        bubbles: true,
      }),
    );
  }, []);

  const handleScroll = useCallback((): void => {
    const save = depsRef.current.saveScroll;
    const documentId = documentIdOf(sessionRef.current);
    if (save === undefined || documentId === null) return;
    if (scrollTimerRef.current !== null) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      const host = hostRef.current;
      if (host === null) return;
      save(documentId, host.scrollTop);
    }, 300);
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const load = depsRef.current.loadScroll;
    const documentId = documentIdOf(sessionRef.current);
    if (load === undefined || documentId === null) return;
    const saved = load(documentId);
    if (saved >= 0) host.scrollTop = saved;
  }, [html]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host !== null) {
      host.addEventListener('click', handleClick);
      host.addEventListener('scroll', handleScroll, { passive: true });
    }
    if (handleRef !== undefined) {
      handleRef.current = { update, revealAddress };
    }
    return () => {
      if (host !== null) {
        host.removeEventListener('click', handleClick);
        host.removeEventListener('scroll', handleScroll);
      }
      if (renderTimerRef.current !== null) {
        clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
      if (scrollTimerRef.current !== null) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      if (handleRef !== undefined) {
        handleRef.current = null;
      }
    };
  }, [handleClick, handleScroll, update, revealAddress, handleRef]);

  return (
    <div
      ref={hostRef}
      className={`${styles.preview} fl-pane-preview fl-markdown-reader`}
    >
      <div data-fl-document-title-slot="reader" />
      <div
        className={styles.content}
        data-fl-markdown-content
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
