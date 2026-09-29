/**
 * Host-readiness mailbox for workspace document opens.
 *
 * Opening is asynchronous and outlives renders: a routing decision may name
 * a pane whose editor host does not exist yet (fresh splits, startup
 * restore, tab switches, pane reparents). This module is the pure,
 * React-free pending-intent store behind `useSessionOpener`.
 *
 * Deliberately a mailbox, not an executor: per-pane FIFO intent lists with
 * no promise chaining, sequencing, or in-flight tracking. The drain fires
 * the queued controller calls in order without awaiting between them, so
 * execution order belongs solely to
 * `WorkbenchController.#paneOpenOperations` — rapid opens into one pane
 * all survive and the last one finishes active.
 */

export interface PendingDocumentOpen {
  readonly pane: string;
  readonly documentId: string;
  readonly address?: string;
  /**
   * Background intent: the controller open must never modify global focus.
   * Travels with the intent so `host.openDocument` receives the real intent.
   */
  readonly preserveFocus?: boolean;
}

export interface PendingOpenMailbox {
  readonly queues: Map<string, PendingDocumentOpen[]>;
}

export function createPendingMailbox(): PendingOpenMailbox {
  return { queues: new Map() };
}

/** Append an intent to its pane's FIFO list. */
export function appendPendingOpen(
  mailbox: PendingOpenMailbox,
  request: PendingDocumentOpen,
): void {
  const existing = mailbox.queues.get(request.pane);
  if (existing === undefined)
    mailbox.queues.set(request.pane, [{ ...request }]);
  else existing.push({ ...request });
}

/** Remove and return every pending intent for `pane`, in order. */
export function takePendingOpens(
  mailbox: PendingOpenMailbox,
  pane: string,
): PendingDocumentOpen[] {
  const requests = mailbox.queues.get(pane);
  if (requests === undefined) return [];
  mailbox.queues.delete(pane);
  return requests;
}

export function hasPendingOpen(
  mailbox: PendingOpenMailbox,
  pane: string,
): boolean {
  return (mailbox.queues.get(pane)?.length ?? 0) > 0;
}

/** Drop intents for panes that no longer exist, returning what was dropped. */
export function pruneClosedPanes(
  mailbox: PendingOpenMailbox,
  livePanes: readonly string[],
): PendingDocumentOpen[] {
  const live = new Set(livePanes);
  const dropped: PendingDocumentOpen[] = [];
  for (const [pane, requests] of [...mailbox.queues]) {
    if (!live.has(pane)) {
      mailbox.queues.delete(pane);
      dropped.push(...requests);
    }
  }
  return dropped;
}
