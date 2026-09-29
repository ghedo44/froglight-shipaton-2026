import type { DocumentPropertyCapability } from '../documents.js';
import type { PropertyValue } from './catalog.js';

type PropertiesModel = { meta: Record<string, unknown> };

/** Shared stable-ID property bag for structured first-party documents. */
export const structuredDocumentProperties: DocumentPropertyCapability<PropertiesModel> = {
  key: (propertyId) => propertyId,
  read(model, key) {
    const bag = model.meta.properties;
    if (bag === undefined) return { present: false };
    if (typeof bag !== 'object' || bag === null || Array.isArray(bag))
      throw new Error('Document properties metadata is unsupported');
    return Object.prototype.hasOwnProperty.call(bag, key)
      ? { present: true, value: (bag as Record<string, PropertyValue>)[key]! }
      : { present: false };
  },
  write(model, key, value) {
    const current = model.meta.properties;
    if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current)))
      throw new Error('Document properties metadata is unsupported');
    model.meta.properties = { ...(current as Record<string, unknown> | undefined), [key]: value };
  },
  unset(model, key) {
    const current = model.meta.properties;
    if (current === undefined) return;
    if (typeof current !== 'object' || current === null || Array.isArray(current))
      throw new Error('Document properties metadata is unsupported');
    const next = { ...current };
    delete (next as Record<string, unknown>)[key];
    model.meta.properties = next;
  },
};
