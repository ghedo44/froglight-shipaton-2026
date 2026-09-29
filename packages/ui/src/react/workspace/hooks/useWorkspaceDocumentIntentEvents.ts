/**
 * DOM event → document-router intent adapter.
 *
 * A thin translation layer over the `workspaceEvents` bus: each handler
 * validates its event detail and calls `router.dispatch(...)` with the
 * matching intent. Handlers contain no pane-selection, split, preview-remap,
 * or prune policy — all routing decisions live in the React-free
 * `routing/documentRouter`.
 */

import { useEffect } from 'react';
import type { NavigationService } from '@froglight/foundation';
import {
  workspaceEvents as events,
  workspaceEventDetail,
} from '../../../ui-events.js';
import { PREVIEW_VIEW_ID_PREFIX } from '../../../view-registry.js';
import type { WorkspaceDocumentRouter } from '../routing/documentRouter.js';

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function useWorkspaceDocumentIntentEvents(input: {
  readonly router: WorkspaceDocumentRouter;
  readonly navigation?: NavigationService;
  readonly resolveResource?: (resourceId: string) => string | undefined;
  readonly onMissingResource?: () => void;
  readonly eventTarget: HTMLElement | undefined;
  readonly getRoot: () => HTMLElement | null;
}): void {
  const {
    router,
    eventTarget,
    getRoot,
    navigation,
    resolveResource,
    onMissingResource,
  } = input;

  useEffect(() => {
    if (navigation === undefined) return;
    // Provider resource links enter the same pane-aware route as explorer
    // and knowledge links. Do not replay the current entry on remount.
    const subscription = navigation.onChange(() => {
      const target = navigation.current;
      if (target === null) return;
      const documentId = resolveResource?.(target.resourceId);
      if (documentId === undefined) {
        onMissingResource?.();
        return;
      }
      void router.dispatch({
        type: 'open-document',
        documentId,
        ...(target.address !== undefined ? { address: target.address } : {}),
        disposition: 'foreground',
      });
    });
    return () => subscription.dispose();
  }, [navigation, router, resolveResource, onMissingResource]);

  useEffect(() => {
    const root = eventTarget ?? getRoot();
    if (root === null) return;

    const openHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{
        documentId?: unknown;
        address?: unknown;
      }>(event);
      const documentId = nonEmptyString(detail?.documentId);
      if (documentId === undefined) return;
      const address = nonEmptyString(detail?.address);
      void router.dispatch({
        type: 'open-document',
        documentId,
        ...(address !== undefined ? { address } : {}),
        disposition: 'foreground',
      });
    };

    const openBackgroundHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{
        documentId?: unknown;
        viewId?: unknown;
        address?: unknown;
      }>(event);
      const viewId = nonEmptyString(detail?.viewId);
      if (viewId !== undefined) {
        if (viewId.startsWith(PREVIEW_VIEW_ID_PREFIX)) {
          const path = viewId.slice(PREVIEW_VIEW_ID_PREFIX.length);
          if (path === '') return;
          void router.dispatch({
            type: 'open-preview',
            path,
            disposition: 'background',
          });
        } else {
          void router.dispatch({
            type: 'open-view',
            viewId,
            disposition: 'background',
          });
        }
        return;
      }
      const documentId = nonEmptyString(detail?.documentId);
      if (documentId === undefined) return;
      const address = nonEmptyString(detail?.address);
      void router.dispatch({
        type: 'open-document',
        documentId,
        ...(address !== undefined ? { address } : {}),
        disposition: 'background',
      });
    };

    const openViewHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{ viewId?: unknown }>(event);
      const viewId = nonEmptyString(detail?.viewId);
      if (viewId === undefined) return;
      void router.dispatch({
        type: 'open-view',
        viewId,
        disposition: 'foreground',
      });
    };

    const openLinkHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{ destination?: unknown }>(event);
      const destination = nonEmptyString(detail?.destination);
      if (destination === undefined) return;
      void router.dispatch({ type: 'open-link', destination });
    };

    const openPreviewHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{ path?: unknown }>(event);
      const path = nonEmptyString(detail?.path);
      if (path === undefined) return;
      void router.dispatch({
        type: 'open-preview',
        path,
        disposition: 'foreground',
      });
    };

    const previewMovedHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{ from?: unknown; to?: unknown }>(
        event,
      );
      const from = nonEmptyString(detail?.from);
      const to = nonEmptyString(detail?.to);
      if (from === undefined || to === undefined) return;
      void router.dispatch({
        type: 'preview-moved',
        from,
        to,
      });
    };

    const previewDeletedHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{ path?: unknown }>(event);
      const path = nonEmptyString(detail?.path);
      if (path === undefined) return;
      void router.dispatch({ type: 'preview-deleted', path });
    };

    const documentsDeletedHandler = (event: Event): void => {
      const detail = workspaceEventDetail<{
        documentIds?: unknown;
        folder?: unknown;
      }>(event);
      const documentIds =
        Array.isArray(detail?.documentIds) &&
        detail.documentIds.every((id) => typeof id === 'string')
          ? (detail.documentIds as readonly string[])
          : undefined;
      const folder =
        typeof detail?.folder === 'string' ? detail.folder : undefined;
      void router.dispatch({
        type: 'documents-deleted',
        ...(documentIds !== undefined ? { documentIds } : {}),
        ...(folder !== undefined ? { folder } : {}),
      });
    };

    root.addEventListener(events.open, openHandler);
    root.addEventListener(events.openView, openViewHandler);
    root.addEventListener(events.openBackground, openBackgroundHandler);
    root.addEventListener(events.openLink, openLinkHandler);
    root.addEventListener(events.openPreview, openPreviewHandler);
    root.addEventListener(events.previewMoved, previewMovedHandler);
    root.addEventListener(events.previewDeleted, previewDeletedHandler);
    root.addEventListener(events.documentsDeleted, documentsDeletedHandler);
    return () => {
      root.removeEventListener(events.open, openHandler);
      root.removeEventListener(events.openView, openViewHandler);
      root.removeEventListener(events.openBackground, openBackgroundHandler);
      root.removeEventListener(events.openLink, openLinkHandler);
      root.removeEventListener(events.openPreview, openPreviewHandler);
      root.removeEventListener(events.previewMoved, previewMovedHandler);
      root.removeEventListener(events.previewDeleted, previewDeletedHandler);
      root.removeEventListener(
        events.documentsDeleted,
        documentsDeletedHandler,
      );
    };
  }, [router, eventTarget, getRoot]);
}
