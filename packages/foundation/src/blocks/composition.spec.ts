import { describe, expect, it } from 'vitest';
import { documentId, documentKindId, resourceId } from '../identity.js';
import { decodeBlockPage, encodeBlockPage } from './codec.js';
import { extractBlockPageRelationships } from './relationships.js';
import { projectBlockPageForSearch } from './search.js';
import { exportBlockPageToMarkdown } from './conversion.js';
import { emptyBlockPage, linkedViewBlock, resourceEmbedBlock, resourceLinkBlock, transclusionBlock } from './model.js';

const source = { resourceId: resourceId('host-resource') };
const target = { documentId: 'target-doc', kindId: 'froglight.markdown', resourceId: 'target-resource' };
const ref = { documentId: documentId('host-doc'), kindId: documentKindId('froglight.blockpage'), location: source };

describe('Block Page composition records', () => {
  it('round-trips stable marks and every composition record with unknown provider fields', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p', 'l', 'e', 't', 'v'];
    model.blocks.p = { id: 'p', type: 'froglight.paragraph', runs: [{ text: 'Mention', marks: [{ type: 'resource', target }] }] };
    model.blocks.l = resourceLinkBlock('l', target, 'Target');
    model.blocks.e = resourceEmbedBlock('e', target, { label: 'Preview', presentation: { compact: true, extensions: { 'acme.preview': { future: 1 } } } });
    model.blocks.t = transclusionBlock('t', { ...target, address: 'heading:details' }, { label: 'Details' });
    model.blocks.v = { id: 'v', type: 'froglight.linked-view', target: { ...target, kindId: 'acme.database' }, viewId: 'view-stable', overrides: { future: { x: 1 } } };
    const bytes = encodeBlockPage(model, ref);
    const decoded = decodeBlockPage(bytes, ref);
    expect(decoded.warnings).toEqual([]);
    expect(encodeBlockPage(decoded.model, ref)).toEqual(bytes);
  });

  it('projects semantic backlinks from stable identity and preserves rename/move independence', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p', 'list', 'e', 't'];
    model.blocks.p = { id: 'p', type: 'froglight.paragraph', runs: [{ text: 'Target', marks: [{ type: 'resource', target }] }] };
    model.blocks.list = { id: 'list', type: 'froglight.list', ordered: false, items: [{ runs: [{ text: 'Nested target', marks: [{ type: 'resource', target }] }] }] };
    model.blocks.e = resourceEmbedBlock('e', target);
    model.blocks.t = transclusionBlock('t', { ...target, address: 'heading:details' });
    const edges = extractBlockPageRelationships({ source, model });
    expect(edges.map((edge) => edge.type)).toEqual(['blockpage.link', 'blockpage.link', 'blockpage.embed', 'blockpage.transclusion']);
    expect(edges.every((edge) => edge.target.documentId === 'target-doc' && edge.target.location.resourceId === 'target-resource')).toBe(true);
    expect(edges.map((edge) => edge.source.address)).toEqual(['p', 'list', 'e', 't']);
  });

  it('indexes host text and labels but never provider-rendered source content', () => {
    const model = emptyBlockPage({ title: 'Host' });
    model.rootOrder = ['p', 'e'];
    model.blocks.p = { id: 'p', type: 'froglight.paragraph', runs: [{ text: 'host authored' }] };
    model.blocks.e = resourceEmbedBlock('e', target, { label: 'useful label' });
    const projection = projectBlockPageForSearch(model, 'host-doc');
    expect(projection.body).toContain('host authored');
    expect(projection.body).toContain('useful label');
    expect(projection.body).not.toContain('source text');
  });

  it('keeps well-shaped unavailable targets canonical and degrades invalid core shapes to opaque warnings', () => {
    const valid = emptyBlockPage();
    valid.rootOrder = ['e'];
    valid.blocks.e = resourceEmbedBlock('e', target);
    expect(decodeBlockPage(encodeBlockPage(valid, ref), ref).warnings).toEqual([]);

    const invalid = new TextEncoder().encode(JSON.stringify({ formatVersion: 1, meta: {}, rootOrder: ['t'], blocks: { t: { id: 't', type: 'froglight.transclusion', target } } }));
    expect(decodeBlockPage(invalid, ref).warnings).toContainEqual({ code: 'INVALID_CORE_BLOCK_OPAQUE', blockId: 't' });
  });

  it('exports only explicitly portable references and never flattens linked-view results', () => {
    const model = emptyBlockPage();
    model.blocks.link = resourceLinkBlock('link', target, 'Destination');
    model.blocks.embed = resourceEmbedBlock('embed', target, { label: 'Preview' });
    model.blocks.live = linkedViewBlock('live', { ...target, kindId: 'acme.database' }, 'assigned');
    model.rootOrder = ['link', 'embed', 'live'];
    const exported = exportBlockPageToMarkdown(model, undefined, () => 'notes/destination.md');
    expect(exported.markdown).toContain('[Destination](notes/destination.md)');
    expect(exported.markdown).toContain('![[notes/destination.md]]');
    expect(exported.markdown).not.toContain('assigned');
    expect(exported.warnings).toContain('linked view "live" cannot be reconstructed from Markdown; omitted from export');
    expect(exported.status).toBe('lossy');
  });
});
