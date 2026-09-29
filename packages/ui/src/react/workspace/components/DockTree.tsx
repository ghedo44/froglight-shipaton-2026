/**
 * Dock tree renderer: tab strips aligned in the top bar, pane splits with
 * draggable dividers, and inline strips for deeper vertical bands.
 *
 * The workbench controller owns all dock state; this tree
 * subscribes and renders. `TopbarStrips` mirrors the first dock band into
 * the window's top row so each strip starts where its pane starts, while
 * `DockPanes` renders the pane bodies with draggable dividers. Divider
 * dragging lives here with the geometry it drives (`dock-interactions`),
 * while per-pane presentation comes from the `paneFor` seam as
 * view-model/actions pairs.
 */

import { useEffect, useState } from 'react';
import { dockHasLeaf, type DockNodeView } from '../../../dock-tree.js';
import { splitRatioFromPointer } from '../../../dock-interactions.js';
import type {
  WorkbenchDockPort,
  WorkbenchEditorToolsPort,
} from '../../../workbench-ports.js';
import { MAIN_PANE, useWorkspace } from '../WorkspaceContext.js';
import {
  Pane,
  paneTabStripProps,
  type PaneActions,
  type PaneHosts,
  type PaneViewModel,
} from './Pane.jsx';
import { TabStrip } from './TabStrip.jsx';
import styles from '../../WorkspaceView.module.css';

export interface DockTreePane {
  readonly model: PaneViewModel;
  readonly actions: PaneActions;
}

export interface DockTreeSeam {
  readonly hosts: PaneHosts;
  readonly paneFor: (paneId: string) => DockTreePane;
  readonly dock: WorkbenchDockPort;
  readonly tools: WorkbenchEditorToolsPort;
}

/** First visible strip in a dock subtree. */
function firstPaneOf(node: DockNodeView): string {
  return node.kind === 'leaf' ? node.pane : firstPaneOf(node.first);
}

function renderTabstripFor(
  paneId: string,
  paneFor: (paneId: string) => DockTreePane,
): React.ReactElement {
  const { model, actions } = paneFor(paneId);
  return <TabStrip paneId={paneId} {...paneTabStripProps(model, actions)} />;
}

/**
 * Mirror the first band of a dock subtree, including every horizontal
 * divider. Vertical splits contribute their first subtree here; their
 * second subtree owns an inline strip immediately above its pane band.
 */
function renderStripTree(
  node: DockNodeView,
  paneFor: (paneId: string) => DockTreePane,
  edge: { start: boolean; end: boolean } = { start: true, end: true },
): React.ReactElement {
  if (node.kind === 'leaf') {
    return (
      <div
        className={`${styles['fl-topbar-strip']}${edge.start ? ` ${styles['fl-strip-edge-start']}` : ''}${edge.end ? ` ${styles['fl-strip-edge-end']}` : ''}`}
        data-strip-pane={node.pane}
      >
        {renderTabstripFor(node.pane, paneFor)}
      </div>
    );
  }
  if (node.direction === 'vertical') {
    return renderStripTree(node.first, paneFor, edge);
  }
  return (
    <div className={styles['fl-strip-split']}>
      <div
        className={styles['fl-strip-part']}
        style={{ flexGrow: node.ratio, flexBasis: 0 }}
      >
        {renderStripTree(node.first, paneFor, { start: edge.start, end: false })}
      </div>
      <div className={styles['fl-strip-divider']} aria-hidden="true" />
      <div
        className={styles['fl-strip-part']}
        style={{ flexGrow: 1 - node.ratio, flexBasis: 0 }}
      >
        {renderStripTree(node.second, paneFor, { start: false, end: edge.end })}
      </div>
    </div>
  );
}

function renderInlineStrip(
  node: DockNodeView,
  paneFor: (paneId: string) => DockTreePane,
): React.ReactElement {
  return (
    <div className={styles['fl-band-strips']} data-band-strip={firstPaneOf(node)}>
      {renderStripTree(node, paneFor)}
    </div>
  );
}

/** Top-bar strips for the first dock band (one strip per top-row pane). */
export function TopbarStrips(
  props: DockTreeSeam & { readonly root: DockNodeView },
): React.ReactElement {
  return renderStripTree(props.root, props.paneFor);
}

/** Pane bodies for the dock tree, with draggable split dividers. */
export function DockPanes(
  props: DockTreeSeam & {
    readonly root: DockNodeView;
    readonly mobile: boolean;
    readonly maximizedPane: string | null;
    readonly focusedPane: string | null;
  },
): React.ReactElement {
  const { root, mobile, maximizedPane, focusedPane, hosts, paneFor, dock, tools } = props;
  const { ui } = useWorkspace();
  const [dividerDrag, setDividerDrag] = useState<{
    path: readonly ('first' | 'second')[];
    direction: 'horizontal' | 'vertical';
    element: HTMLElement;
  } | null>(null);

  // Divider drag lifecycle: ratio follows the pointer inside the split.
  useEffect(() => {
    if (dividerDrag === null) return;
    const onMove = (event: PointerEvent): void => {
      const container = dividerDrag.element.parentElement;
      if (container === null) return;
      const dividerRect = dividerDrag.element.getBoundingClientRect();
      const ratio = splitRatioFromPointer({
        direction: dividerDrag.direction,
        clientX: event.clientX,
        clientY: event.clientY,
        container: container.getBoundingClientRect(),
        dividerSize:
          dividerDrag.direction === 'horizontal'
            ? dividerRect.width
            : dividerRect.height,
      });
      if (ratio === null) return;
      dock.setSplitRatioAt(dividerDrag.path, ratio);
    };
    const onEnd = (): void => setDividerDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [dividerDrag, dock]);

  function renderPane(paneId: string): React.ReactElement {
    const { model, actions } = paneFor(paneId);
    return (
      <Pane model={model} actions={actions} hosts={hosts} views={ui.views} tools={tools} />
    );
  }

  function renderNode(
    node: DockNodeView,
    path: readonly ('first' | 'second')[] = [],
  ): React.ReactElement {
    if (node.kind === 'leaf') return renderPane(node.pane);
    if (mobile) {
      const focused = focusedPane ?? MAIN_PANE;
      if (dockHasLeaf(node.first, focused)) {
        return renderNode(node.first, [...path, 'first']);
      }
      if (dockHasLeaf(node.second, focused)) {
        return renderNode(node.second, [...path, 'second']);
      }
    }
    const maximized = maximizedPane;
    const firstHas = maximized !== null && dockHasLeaf(node.first, maximized);
    const secondHas = maximized !== null && dockHasLeaf(node.second, maximized);
    if (maximized !== null && firstHas && !secondHas) {
      return renderNode(node.first, [...path, 'first']);
    }
    if (maximized !== null && secondHas && !firstHas) {
      return renderNode(node.second, [...path, 'second']);
    }
    const horizontal = node.direction === 'horizontal';
    const pathKey = path.join('/');
    const isDividerDragging = dividerDrag?.path.join('/') === pathKey;
    return (
      <div className={styles['fl-split']} data-direction={node.direction}>
        <div
          className={styles['fl-split-first']}
          style={{ flexGrow: node.ratio, flexBasis: 0 }}
        >
          {renderNode(node.first, [...path, 'first'])}
        </div>
        <div
          className={`${styles['fl-pane-divider']}${isDividerDragging ? ` ${styles.dragging}` : ''}`}
          role="separator"
          aria-orientation={horizontal ? 'vertical' : 'horizontal'}
          aria-label="Resize pane divider"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(node.ratio * 100)}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            event.currentTarget.focus();
            setDividerDrag({
              path,
              direction: node.direction,
              element: event.currentTarget,
            });
          }}
          onKeyDown={(event) => {
            const positive = horizontal
              ? event.key === 'ArrowRight'
              : event.key === 'ArrowDown';
            const negative = horizontal
              ? event.key === 'ArrowLeft'
              : event.key === 'ArrowUp';
            if (event.key === 'Home') {
              event.preventDefault();
              dock.setSplitRatioAt(path, 0.2);
            } else if (event.key === 'End') {
              event.preventDefault();
              dock.setSplitRatioAt(path, 0.8);
            } else if (positive || negative) {
              event.preventDefault();
              dock.setSplitRatioAt(
                path,
                node.ratio + (positive ? 0.05 : -0.05),
              );
            }
          }}
          onDoubleClick={() => dock.setSplitRatioAt(path, 0.5)}
        />
        <div
          className={styles['fl-split-second']}
          style={{ flexGrow: 1 - node.ratio, flexBasis: 0 }}
        >
          {node.direction === 'vertical'
            ? renderInlineStrip(node.second, paneFor)
            : null}
          {renderNode(node.second, [...path, 'second'])}
        </div>
      </div>
    );
  }

  if (mobile) return renderPane(focusedPane ?? MAIN_PANE);
  return renderNode(root);
}
