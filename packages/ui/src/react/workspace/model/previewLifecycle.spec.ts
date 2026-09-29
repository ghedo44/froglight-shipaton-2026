import { describe, expect, it } from 'vitest';
import { planPreviewReconciliation } from './previewLifecycle.js';

const PREFIX = 'preview:';

describe('planPreviewReconciliation', () => {
  it('ensures registrations for referenced previews with none', () => {
    const plan = planPreviewReconciliation({
      referencedViewIds: [`${PREFIX}notes/photo.png`],
      registered: new Map(),
      currentReader: 'reader-1',
      prefix: PREFIX,
    });
    expect(plan.disposeViewIds).toEqual([]);
    expect(plan.ensurePaths).toEqual(['notes/photo.png']);
  });

  it('disposes orphan registrations whose last tab is gone', () => {
    const plan = planPreviewReconciliation({
      referencedViewIds: [],
      registered: new Map([
        [`${PREFIX}notes/old.png`, { reader: 'reader-1' }],
      ]),
      currentReader: 'reader-1',
      prefix: PREFIX,
    });
    expect(plan.disposeViewIds).toEqual([`${PREFIX}notes/old.png`]);
    expect(plan.ensurePaths).toEqual([]);
  });

  it('re-registers restored tabs and stale-reader registrations', () => {
    const plan = planPreviewReconciliation({
      referencedViewIds: [`${PREFIX}a.png`, `${PREFIX}b.png`],
      registered: new Map([
        [`${PREFIX}a.png`, { reader: 'reader-1' }],
        [`${PREFIX}b.png`, { reader: 'reader-0' }],
      ]),
      currentReader: 'reader-1',
      prefix: PREFIX,
    });
    expect(plan.disposeViewIds).toEqual([`${PREFIX}b.png`]);
    expect(plan.ensurePaths).toEqual(['b.png']);
  });

  it('keeps one registration for multiple tabs on the same preview', () => {
    const plan = planPreviewReconciliation({
      referencedViewIds: [`${PREFIX}a.png`, `${PREFIX}a.png`],
      registered: new Map([[`${PREFIX}a.png`, { reader: 'reader-1' }]]),
      currentReader: 'reader-1',
      prefix: PREFIX,
    });
    expect(plan.disposeViewIds).toEqual([]);
    expect(plan.ensurePaths).toEqual([]);
  });

  it('ignores referenced view ids outside the preview prefix', () => {
    const plan = planPreviewReconciliation({
      referencedViewIds: ['graph'],
      registered: new Map(),
      currentReader: 'reader-1',
      prefix: PREFIX,
    });
    expect(plan.disposeViewIds).toEqual([]);
    expect(plan.ensurePaths).toEqual([]);
  });
});
