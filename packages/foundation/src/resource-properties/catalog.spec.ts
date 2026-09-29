import { describe, expect, it } from 'vitest';
import { PropertyCatalog, type PropertyValue } from './catalog.js';

describe('generic property catalog', () => {
  const catalog = new PropertyCatalog();
  it('offers generic primitives without a status type', () => {
    expect(catalog.list().map((type) => type.id)).toEqual([
      'text',
      'number',
      'boolean',
      'date',
      'select',
      'multi-select',
      'url',
      'email',
      'phone',
      'relation',
      'rollup',
      'formula',
      'created',
      'updated',
    ]);
    expect(catalog.get('status')).toBeUndefined();
  });
  it.each<[string, PropertyValue, boolean]>([
    ['email', 'person@example.com', true],
    ['email', 'bad address', false],
    ['phone', '+39 012 345 6789', true],
    ['phone', 'call me', false],
    ['date', { start: '2026-09-07', end: '2026-09-10' }, true],
    ['date', { start: '2026-09-10', end: '2026-09-07' }, false],
    ['date', '2026-02-30', false],
    ['date', '2026-09-07T12:00:00Z', true],
    ['number', '42', false],
    ['number', Infinity, false],
    ['relation', ['a', 'a'], false],
    ['relation', ['a', 'b'], true],
  ])('validates %s value %j without coercion', (type, value, valid) => {
    expect(
      catalog.diagnostic({ id: 'field', name: 'Field', type }, value) === null,
    ).toBe(valid);
  });
  it('keeps select labels, colors and order independent from stored IDs', () => {
    const property = {
      id: 'sector',
      name: 'Sector',
      type: 'select',
      options: [
        { id: 'b', name: 'Education', color: 'blue' },
        { id: 'a', name: 'Healthcare', color: 'green' },
      ],
    };
    expect(catalog.diagnostic(property, 'a')).toBeNull();
    expect(catalog.diagnostic(property, 'Healthcare')).toBe('Unknown option');
    expect(property.options.map((option) => option.id)).toEqual(['b', 'a']);
    expect(
      catalog.diagnostic(
        {
          ...property,
          options: property.options.map((option) => ({
            ...option,
            name: 'Renamed',
          })),
        },
        'a',
      ),
    ).toBeNull();
  });
  it('rejects all computed and unavailable writes consistently and owns extensions reversibly', () => {
    for (const type of ['created', 'updated', 'formula', 'rollup'])
      expect(catalog.writeReason({ id: 'x', name: 'X', type })).toContain(
        'read-only',
      );
    const extension = {
      id: 'example.rating',
      label: 'Rating',
      storage: 'stored' as const,
      editor: 'number' as const,
      validate: (value: PropertyValue) =>
        typeof value === 'number' && value >= 0 && value <= 5
          ? null
          : 'Expected 0–5',
    };
    const first = catalog.register(extension);
    expect(
      catalog.diagnostic({ id: 'x', name: 'X', type: extension.id }, 4),
    ).toBeNull();
    first.dispose();
    expect(
      catalog.writeReason({ id: 'x', name: 'X', type: extension.id }),
    ).toContain('unavailable');
    const next = catalog.register({ ...extension });
    first.dispose();
    expect(catalog.get(extension.id)).toBeDefined();
    next.dispose();
  });
  it('notifies current listeners when an extension appears or disappears', () => {
    const changes: string[] = [];
    const subscription = catalog.onDidChange(() => changes.push('change'));
    const extension = catalog.register({
      id: 'example.live',
      label: 'Live',
      storage: 'stored',
      editor: 'text',
      validate: () => null,
    });
    extension.dispose();
    extension.dispose();
    subscription.dispose();
    catalog.register({
      id: 'example.after',
      label: 'After',
      storage: 'stored',
      editor: 'text',
      validate: () => null,
    }).dispose();
    expect(changes).toEqual(['change', 'change']);
  });
});
