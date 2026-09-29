import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../encoding.js';
import { mergePropertySidecarBytes } from './property-sidecar-merge.js';

function bytes(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

function record(values: Record<string, unknown>, extra = {}) {
  return {
    format: 'froglight.properties',
    version: 1,
    owner: 'member-1',
    values,
    relations: [],
    ...extra,
  };
}

describe('property sidecar semantic merge', () => {
  it('combines independent fields and preserves independently changed unknown data', () => {
    const merged = mergePropertySidecarBytes({
      path: '.froglight/properties/member-1.json',
      base: bytes(
        record({ status: 'todo', priority: 1, related: [] }, { pluginA: 1 }),
      ),
      local: bytes(
        record({ status: 'doing', priority: 1, related: [] }, { pluginA: 1 }),
      ),
      remote: bytes(
        record(
          { status: 'todo', priority: 2, related: ['target'] },
          { pluginA: 1, pluginB: true, relations: ['related'] },
        ),
      ),
    });
    expect(merged).not.toBeNull();
    if (merged === null) throw new Error('expected semantic merge');
    expect(JSON.parse(utf8Decode(merged))).toEqual({
      format: 'froglight.properties',
      owner: 'member-1',
      pluginA: 1,
      pluginB: true,
      relations: ['related'],
      values: { priority: 2, related: ['target'], status: 'doing' },
      version: 1,
    });
  });

  it('treats null as a stored value rather than a merge failure', () => {
    const merged = mergePropertySidecarBytes({
      path: '.froglight/properties/member-1.json',
      base: bytes(record({ status: 'todo', assignee: 'member-2' })),
      local: bytes(record({ status: null, assignee: 'member-2' })),
      remote: bytes(record({ status: 'todo', assignee: null })),
    });
    expect(merged).not.toBeNull();
    if (merged === null) throw new Error('expected semantic merge');
    expect(JSON.parse(utf8Decode(merged)).values).toEqual({
      assignee: null,
      status: null,
    });
  });

  it('declines same-field conflicts so byte-level recovery preserves both versions', () => {
    expect(
      mergePropertySidecarBytes({
        path: '.froglight/properties/member-1.json',
        base: bytes(record({ status: 'todo' })),
        local: bytes(record({ status: 'doing' })),
        remote: bytes(record({ status: 'done' })),
      }),
    ).toBeNull();
  });

  it('declines corrupt, unsupported, and owner-mismatched records', () => {
    const valid = bytes(record({ status: 'todo' }));
    expect(
      mergePropertySidecarBytes({
        path: '.froglight/properties/member-1.json',
        base: valid,
        local: utf8Encode('{broken'),
        remote: valid,
      }),
    ).toBeNull();
    expect(
      mergePropertySidecarBytes({
        path: '.froglight/properties/member-1.json',
        base: valid,
        local: valid,
        remote: bytes({ ...record({}), version: 2 }),
      }),
    ).toBeNull();
    expect(
      mergePropertySidecarBytes({
        path: '.froglight/properties/member-1.json',
        base: valid,
        local: valid,
        remote: bytes({ ...record({}), owner: 'member-2' }),
      }),
    ).toBeNull();
  });
});
