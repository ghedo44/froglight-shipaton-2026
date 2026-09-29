import type { DocumentRef } from '../documents.js';
import type { ResourceId } from '../identity.js';
import type { SaveResult } from '../session.js';
import type {
  PropertyCatalog,
  PropertyValue,
  ResourcePropertyDefinition,
} from './catalog.js';

/** A derived workspace row. Canonical content remains in its document kind. */
export interface ResourcePropertyRow {
  readonly resourceId: ResourceId;
  readonly title: string;
  readonly kindId: string;
  readonly path: string;
  readonly values: Readonly<Record<string, PropertyValue>>;
  /** Recovery diagnostics from canonical property storage. */
  readonly diagnostics?: Readonly<Record<string, string>>;
  readonly createdMillis?: number;
  readonly updatedMillis?: number;
}
/** Stable lazy access to the current derived projection. */
export interface ResourcePropertyRowSource {
  readonly revision: number;
  scan(): Iterable<ResourcePropertyRow>;
  get(id: ResourceId): ResourcePropertyRow | undefined;
}
export interface ResourcePropertyService {
  readonly catalog: PropertyCatalog;
  read(ref: DocumentRef): Promise<Readonly<Record<string, PropertyValue>>>;
  write(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    value: PropertyValue,
  ): Promise<SaveResult>;
  /** Serialize a read/modify/write with other edits to this resource. */
  update(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    update: (
      current: PropertyValue,
      state: { readonly present: boolean },
    ) => PropertyValue,
  ): Promise<SaveResult>;
  /** Remove one stored value only when its current value still matches. */
  unset(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    expectedValue: PropertyValue,
  ): Promise<SaveResult>;
  /** Read the shared projection, never canonical files. */
  rows(): readonly ResourcePropertyRow[];
  /** Scan without first copying the complete workspace projection. */
  rowSource?(): ResourcePropertyRowSource;
  onDidChange(listener: () => void): { dispose(): void };
}
