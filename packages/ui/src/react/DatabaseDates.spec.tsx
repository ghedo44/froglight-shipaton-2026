// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  resourceId,
  type EvaluatedDatabaseRow,
  type PropertyValue,
} from '@froglight/foundation';
import { DatabaseDates } from './DatabaseDates.js';
import styles from './DatabaseView.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const property = { id: 'when', name: 'When', type: 'date' } as const;

function row(id: string, value: PropertyValue): EvaluatedDatabaseRow {
  return {
    resourceId: resourceId(id),
    title: id,
    path: `${id}.md`,
    kindId: 'froglight.markdown',
    values: { when: value },
    diagnostics: {},
  };
}

function card(item: EvaluatedDatabaseRow): ReactNode {
  return <span data-card={item.resourceId}>{item.title}</span>;
}

async function changeDate(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Expected test element to exist');
  return value;
}

it('keeps UTC instants distinct from all-day dates and reveals every date bucket', async () => {
  const rows = [
    row('instant', '2026-09-02T12:30:00Z'),
    row('all-day', '2026-09-04'),
    row('ongoing', { start: '2026-08-29', end: '2026-09-03' }),
    row('earlier', '2026-08-01'),
    row('later', '2026-10-01'),
    row('undated', null),
    row('invalid', 'opaque'),
  ];
  const move = vi.fn(async () => undefined);
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseDates
          rows={rows}
          property={property}
          timeline={false}
          disabled={false}
          card={card}
          move={move}
        />,
      ),
    );
    expect(parent.textContent).toContain('UTC time preserved: 12:30');
    expect(parent.textContent).toContain('All-day date');
    expect(parent.textContent).toContain('Continues from 2026-08-29');
    expect(parent.textContent).toContain('Before this month (1)');
    expect(parent.textContent).toContain('After this month (1)');
    expect(parent.textContent).toContain('Unscheduled (1)');
    expect(parent.textContent).toContain('Invalid dates (1)');
    expect(parent.textContent).toContain('Invalid date retained');
    const instant = required(
      parent.querySelector<HTMLInputElement>('[aria-label="Schedule instant"]'),
    );
    await changeDate(instant, '2026-09-10');
    expect(move).toHaveBeenCalledWith(
      resourceId('instant'),
      '2026-09-10T12:30:00.000Z',
      '2026-09-02T12:30:00Z',
    );
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('retains a rejected schedule draft and offers retry or discard', async () => {
  const move = vi
    .fn()
    .mockRejectedValueOnce(new Error('injected scheduling failure'))
    .mockResolvedValue(undefined);
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseDates
          rows={[row('meeting', '2026-09-02')]}
          property={property}
          timeline
          disabled={false}
          card={card}
          move={move}
        />,
      ),
    );
    await changeDate(
      required(
        parent.querySelector<HTMLInputElement>(
          '[aria-label="Schedule meeting"]',
        ),
      ),
      '2026-09-12',
    );
    expect(parent.querySelector('[role="alert"]')?.textContent).toContain(
      'injected scheduling failure',
    );
    expect(
      parent.querySelector<HTMLInputElement>('[aria-label="Schedule meeting"]')
        ?.value,
    ).toBe('2026-09-12');
    await act(async () => {
      [...parent.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry')
        ?.click();
    });
    expect(move).toHaveBeenLastCalledWith(
      resourceId('meeting'),
      '2026-09-12',
      '2026-09-02',
    );
    expect(parent.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('bounds a dense month and reveals more through an ordinary button', async () => {
  const rows = Array.from({ length: 120 }, (_, index) =>
    row(`item-${index}`, '2026-09-02'),
  );
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseDates
          rows={rows}
          property={property}
          timeline={false}
          disabled={false}
          card={card}
          move={() => undefined}
        />,
      ),
    );
    expect(parent.querySelectorAll(`.${styles.scheduleItem}`)).toHaveLength(50);
    const more = required(
      [...parent.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Show 50 more'),
      ) ?? null,
    );
    await act(async () => more.click());
    expect(parent.querySelectorAll(`.${styles.scheduleItem}`)).toHaveLength(
      100,
    );
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});
