/**
 * Contextual tools, presentation, and document actions under a pane tab strip.
 *
 * Document identity stays in the tab and on the page, so it is never repeated
 * here. This bar disappears for views with no document controls, history, or
 * plugin content.
 *
 * Trusted plugins contribute extra header content through the view
 * registry's `header` area (same shadow-and-restore, effect-owned semantics
 * as every view).
 */

import { useEffect, useState } from 'react';
import type { PaneModeView, PaneView } from '../../../workbench.js';
import type { InstalledUi } from '../../../workbench.js';
import { isEditableTarget } from '../../../menu.js';
import { IconButton } from '../../Button.jsx';
import { ViewSlot } from '../../ViewSlot.jsx';
import {
  PresentationControl,
  projectedPresentationModes,
} from './PresentationControl.jsx';
import styles from '../../WorkspaceView.module.css';

export interface PaneHeaderModel {
  readonly mode: PaneModeView;
  readonly availableModes: readonly PaneModeView[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isDocument: boolean;
  readonly hasActiveTab: boolean;
}

/** Presentation-only header data; derives once per pane per revision. */
export function toPaneHeaderModel(
  paneState: PaneView,
  availableModes: readonly PaneModeView[] = ['edit', 'reading'],
): PaneHeaderModel {
  return {
    mode: paneState.mode,
    availableModes,
    canGoBack: paneState.canGoBack,
    canGoForward: paneState.canGoForward,
    isDocument: paneState.documentId !== null,
    hasActiveTab: paneState.activeTab !== null,
  };
}

export interface PaneHeaderActions {
  readonly onGoBack: () => void;
  readonly onGoForward: () => void;
  readonly onPaneContextMenu: (event: React.MouseEvent) => void;
  readonly onSetMode: (mode: PaneModeView) => void;
  readonly onOpenNoteMenu: (anchor: HTMLElement) => void;
}

export function PaneHeader(props: {
  readonly model: PaneHeaderModel;
  readonly actions: PaneHeaderActions;
  readonly views: InstalledUi['views'];
  /** Primary document tools for the center; title renders when absent. */
  readonly center?: React.ReactNode;
  readonly allowVisibleSplit: boolean;
}): React.ReactElement {
  const { model, actions, views, center } = props;
  const [contributions, setContributions] = useState(() =>
    views.list('header'),
  );
  useEffect(
    () =>
      views.onDidChange(() => setContributions(views.list('header'))).dispose,
    [views],
  );
  const showTools =
    model.isDocument &&
    model.hasActiveTab &&
    model.mode !== 'reading' &&
    center !== undefined;
  const showHistory = model.canGoBack || model.canGoForward;
  const hasContributions = contributions.length > 0;
  const showDocumentActions = model.isDocument && model.hasActiveTab;
  if (!showTools && !showHistory && !hasContributions && !showDocumentActions)
    return <></>;
  return (
    <div
      className={styles['fl-pane-header']}
      data-fl-component="document-toolbar"
      onContextMenu={(event) => {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        actions.onPaneContextMenu(event);
      }}
    >
      {showHistory ? (
        <div className={styles['fl-pane-header-nav']}>
          <IconButton
            icon="arrow-back"
            size={15}
            label="Back"
            title="Back"
            disabled={!model.canGoBack}
            onClick={actions.onGoBack}
          />
          <IconButton
            icon="arrow-forward"
            size={15}
            label="Forward"
            title="Forward"
            disabled={!model.canGoForward}
            onClick={actions.onGoForward}
          />
        </div>
      ) : null}
      {showTools ? <>{center}</> : null}
      <div className={styles['fl-pane-header-actions']}>
        {contributions.map((def) => (
          <ViewSlot key={def.id} view={def} />
        ))}
        {showDocumentActions ? (
          <>
            <PresentationControl
              mode={model.mode}
              availableModes={projectedPresentationModes(
                model.availableModes,
                model.mode,
                props.allowVisibleSplit,
              )}
              onSetMode={actions.onSetMode}
            />
            <IconButton
              icon="more"
              size={16}
              label="Note actions"
              title="Note actions"
              aria-haspopup="menu"
              onClick={(event) => actions.onOpenNoteMenu(event.currentTarget)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
