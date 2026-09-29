/**
 * Connector reverse index (Slice 5).
 *
 * Maps bound object ids → connector ids that reference them as source or
 * target. Updated on create/delete/binding change/decode; queries return
 * only affected connectors without scanning `model.order`.
 */

import {
  SURFACE_OBJECT_TYPES,
  type SurfaceModel,
  type SurfaceObjectId,
} from './model.js';

function readBindingObjectId(
  record: { source?: unknown; target?: unknown },
  key: 'source' | 'target',
): string | null {
  const raw = (record as Record<string, unknown>)[key];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const binding = raw as Record<string, unknown>;
  return typeof binding.objectId === 'string' && binding.objectId !== ''
    ? (binding.objectId as string)
    : null;
}

export interface ConnectorIndexStats {
  /** Indexed lookups served. */
  indexedLookups: number;
  /** Full model scans (must stay 0 after initial build). */
  fullScans: number;
  /** Tracked connector records. */
  connectors: number;
}

export class ConnectorReverseIndex {
  private readonly byObject = new Map<string, Set<string>>();
  private readonly connectorTargets = new Map<
    string,
    { source: string | null; target: string | null }
  >();
  private readonly stats: ConnectorIndexStats = {
    indexedLookups: 0,
    fullScans: 0,
    connectors: 0,
  };

  statsSnapshot(): ConnectorIndexStats {
    return { ...this.stats, connectors: this.connectorTargets.size };
  }

  clear(): void {
    this.byObject.clear();
    this.connectorTargets.clear();
  }

  /** Full rebuild from a decoded/opened model (once per open). */
  rebuild(model: Pick<SurfaceModel, 'objects' | 'order'>): void {
    this.clear();
    for (const id of model.order) {
      const record = model.objects[id];
      if (record === undefined || record.type !== SURFACE_OBJECT_TYPES.line) {
        continue;
      }
      this.syncConnector(id, record);
    }
  }

  /** Insert or refresh one connector record's bindings. */
  syncConnector(
    connectorId: string,
    record: { source?: unknown; target?: unknown; type?: unknown },
  ): void {
    this.removeConnector(connectorId);
    if ((record as { type?: unknown }).type !== SURFACE_OBJECT_TYPES.line) {
      return;
    }
    const source = readBindingObjectId(record, 'source');
    const target = readBindingObjectId(record, 'target');
    if (source === null && target === null) return;
    this.connectorTargets.set(connectorId, { source, target });
    if (source !== null) {
      let set = this.byObject.get(source);
      if (set === undefined) {
        set = new Set();
        this.byObject.set(source, set);
      }
      set.add(connectorId);
    }
    if (target !== null && target !== source) {
      let set = this.byObject.get(target);
      if (set === undefined) {
        set = new Set();
        this.byObject.set(target, set);
      }
      set.add(connectorId);
    }
  }

  removeConnector(connectorId: string): void {
    const prev = this.connectorTargets.get(connectorId);
    if (prev === undefined) return;
    this.connectorTargets.delete(connectorId);
    for (const objectId of [prev.source, prev.target]) {
      if (objectId === null) continue;
      const set = this.byObject.get(objectId);
      if (set !== undefined) {
        set.delete(connectorId);
        if (set.size === 0) this.byObject.delete(objectId);
      }
    }
  }

  removeObject(id: string): void {
    // Object deleted: drop its inbound set and any connector record itself.
    this.byObject.delete(id);
    this.removeConnector(id);
  }

  /** Connectors bound to any of `movedIds` (no model scan). */
  connectorsFor(movedIds: readonly SurfaceObjectId[]): readonly string[] {
    this.stats.indexedLookups += 1;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of movedIds) {
      const set = this.byObject.get(id);
      if (set === undefined) continue;
      for (const connectorId of set) {
        if (!seen.has(connectorId)) {
          seen.add(connectorId);
          out.push(connectorId);
        }
      }
    }
    return out;
  }

  noteFullScan(): void {
    this.stats.fullScans += 1;
  }
}
