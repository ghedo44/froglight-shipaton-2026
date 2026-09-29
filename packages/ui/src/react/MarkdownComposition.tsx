import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import type {
  CompositionAction,
  CompositionPresenter,
  CompositionSnapshot,
} from '@froglight/foundation';
import { renderMarkdown } from '../markdown-render.js';
import { workspaceEvents } from '../ui-events.js';
import { mountIsolatedReactRoot } from './isolated-react-root.js';
import styles from './MarkdownReaderView.module.css';
import 'katex/dist/katex.min.css';

function markdownOf(snapshot: CompositionSnapshot): string | null {
  if (
    snapshot.state !== 'ready' ||
    snapshot.presentation?.type !== 'froglight.markdown'
  )
    return null;
  const raw = snapshot.presentation.data.raw;
  return typeof raw === 'string' ? raw : null;
}

function MarkdownCompositionView(props: {
  readonly raw: string;
  readonly actions: readonly CompositionAction[];
  readonly invoke: (actionId: string) => void;
}): ReactElement {
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a.wiki-link');
    if (!(anchor instanceof HTMLElement)) return;
    event.preventDefault();
    const destination =
      anchor.dataset.destination ?? anchor.textContent ?? '';
    anchor.dispatchEvent(
      new CustomEvent(workspaceEvents.openLink, {
        detail: { destination },
        bubbles: true,
      }),
    );
  };
  return (
    <div>
      <div className={`${styles.preview} ${styles.compositionPreview}`}>
        <div
          className={`${styles.content} ${styles.compositionContent}`}
          data-fl-markdown-content
          onClick={handleClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(props.raw) }}
        />
      </div>
      {props.actions.length > 0 && (
        <div className={styles.compositionActions}>
          {props.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.enabled === false}
              onClick={() => props.invoke(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Read-only Markdown projection for Markdown resource embeds in Block Page. */
export function createMarkdownCompositionPresenter(): CompositionPresenter {
  return {
    mount(input) {
      if (markdownOf(input.snapshot) === null) return null;
      if (!(input.parent instanceof HTMLElement)) return null;
      const parent = input.parent;
      parent.classList.add('flbp-composition-markdown');
      const render = (snapshot: CompositionSnapshot): ReactElement => (
        <MarkdownCompositionView
          raw={markdownOf(snapshot) ?? ''}
          actions={snapshot.state === 'ready' ? (snapshot.actions ?? []) : []}
          invoke={(actionId) => void input.invoke(actionId)}
        />
      );
      const root = mountIsolatedReactRoot(parent, render(input.snapshot));
      return {
        update(snapshot) {
          root.render(render(snapshot));
        },
        dispose() {
          root.dispose();
          parent.classList.remove('flbp-composition-markdown');
        },
      };
    },
  };
}
