import { setDocumentPresentation } from './support/document-presentation.js';
import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

async function sourceOf(
  page: import('@playwright/test').Page,
  name: string,
): Promise<string | null> {
  return page.evaluate(async (filename) => {
    const root = await navigator.storage.getDirectory();
    async function find(
      dir: FileSystemDirectoryHandle,
    ): Promise<string | null> {
      for await (const [entry, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          const result = await find(handle);
          if (result !== null) return result;
        } else if (entry === filename) return (await handle.getFile()).text();
      }
      return null;
    }
    return find(root);
  }, name);
}

test('Markdown and Block Page headings rename their files without changing the body', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Document names');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  for (const [kind, extension] of [
    ['Markdown', 'md'],
    ['Block page', 'blockpage'],
  ] as const) {
    await createFromSidebar(page, kind);
    const dialog = page.getByRole('dialog', { name: 'Create a new note' });
    await dialog
      .getByRole('textbox', { name: 'Note name' })
      .fill(`Before ${kind}`);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    const pane = page.locator('[data-pane="main"]');
    const body = pane
      .locator(kind === 'Markdown' ? '.cm-content' : '.ProseMirror')
      .first();
    await expect(
      page.getByRole('tab', { name: `Before ${kind}.${extension}` }),
    ).toHaveAttribute('aria-selected', 'true');
    if (kind === 'Markdown')
      await expect
        .poll(() => sourceOf(page, `Before ${kind}.${extension}`))
        .toBe('');
    await body.click();
    await body.press('Control+End');
    await page.keyboard.insertText(`\nBody of ${kind}`);
    await expect(body).toContainText(`Body of ${kind}`);
    if (kind === 'Markdown') {
      await page.keyboard.press('Control+s');
      await expect
        .poll(() => sourceOf(page, `Before ${kind}.${extension}`))
        .toContain(`Body of ${kind}`);
    }
    await expect(
      pane.getByRole('button', { name: `Rename Before ${kind}` }),
    ).toBeVisible();
    const titleButton = pane.getByRole('button', {
      name: `Rename Before ${kind}`,
    });
    await titleButton.focus();
    expect(
      await titleButton.evaluate(
        (element) => getComputedStyle(element).borderTopLeftRadius,
      ),
    ).toBe('6px');
    await expect(pane.getByTestId('document-properties')).toHaveCount(0);
    await pane.getByRole('button', { name: `Rename Before ${kind}` }).click();
    await pane
      .getByRole('textbox', { name: 'Document name' })
      .fill(`After ${kind}.${extension}`);
    await pane.getByRole('textbox', { name: 'Document name' }).press('Enter');
    await expect(
      page.getByRole('tab', { name: `After ${kind}.${extension}` }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      pane.getByRole('button', { name: `Rename After ${kind}` }),
    ).toBeVisible();
    await expect(
      page.getByTestId('file-explorer').getByText(`After ${kind}.${extension}`),
    ).toBeVisible();
    await expect(
      page
        .getByTestId('file-explorer')
        .getByText(`Before ${kind}.${extension}`),
    ).toHaveCount(0);
    await expect(body).toContainText(`Body of ${kind}`);
    await expect
      .poll(() => sourceOf(page, `After ${kind}.${extension}`))
      .toContain(`Body of ${kind}`);

    const editAlignment = await pane.evaluate((element, kind) => {
      const title = element.querySelector<HTMLElement>('h1');
      const content = element.querySelector<HTMLElement>(
        kind === 'Markdown' ? '.cm-line' : '.ProseMirror',
      );
      const contentLeft = content?.getBoundingClientRect().left ?? 0;

      const textInset =
        kind === 'Markdown' && content
          ? parseFloat(getComputedStyle(content).paddingLeft)
          : 0;
      return Math.abs(
        (title?.getBoundingClientRect().left ?? 0) - contentLeft - textInset,
      );
    }, kind);
    expect(editAlignment).toBeLessThan(2);

    await setDocumentPresentation(page, 'View');
    await expect(
      pane.getByRole('heading', { name: `After ${kind}` }),
    ).toBeVisible();
    await expect(
      pane.getByRole('button', { name: `Rename After ${kind}` }),
    ).toHaveCount(0);
    await expect(
      pane.getByRole('textbox', { name: 'Document name' }),
    ).toHaveCount(0);
    const viewAlignment = await pane.evaluate((element, kind) => {
      const title = element.querySelector<HTMLElement>('h1');
      const content = element.querySelector<HTMLElement>(
        kind === 'Markdown'
          ? '[data-fl-markdown-content] > :first-child'
          : '.ProseMirror',
      );
      return Math.abs(
        (title?.getBoundingClientRect().left ?? 0) -
          (content?.getBoundingClientRect().left ?? 0),
      );
    }, kind);
    expect(viewAlignment).toBeLessThan(2);
    if (kind === 'Markdown') {
      const titleGap = await pane.evaluate((element) => {
        const title = element.querySelector<HTMLElement>(
          '[data-fl-document-name] h1',
        );
        const text = element.querySelector<HTMLElement>(
          '[data-fl-markdown-content] > :first-child',
        );
        return (
          (text?.getBoundingClientRect().top ?? 0) -
          (title?.getBoundingClientRect().bottom ?? 0)
        );
      });
      expect(titleGap).toBeGreaterThanOrEqual(20);
    }
    await setDocumentPresentation(page, 'Edit');

    await pane.getByRole('button', { name: `Rename After ${kind}` }).click();
    await pane.getByRole('textbox', { name: 'Document name' }).fill('');
    await pane.getByRole('textbox', { name: 'Document name' }).press('Enter');
    await expect(pane.getByRole('alert')).toContainText('valid document name');
    await pane.getByRole('textbox', { name: 'Document name' }).press('Escape');
    await expect(
      page.getByRole('tab', { name: `After ${kind}.${extension}` }),
    ).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const narrowPane = page.locator('[data-pane="main"]');
  const heading = narrowPane.getByRole('button', {
    name: 'Rename After Block page',
  });
  await expect(heading).toBeVisible();
  const geometry = await narrowPane.evaluate((element) => {
    const title = element.querySelector<HTMLElement>(
      'button[aria-label="Rename After Block page"]',
    );
    const islands = [
      ...element.querySelectorAll<HTMLElement>('[data-anchor^="float.top"]'),
    ].filter((island) => island.getClientRects().length > 0);
    return {
      titleTop: title?.getBoundingClientRect().top ?? 0,
      titleRight: title?.getBoundingClientRect().right ?? 0,
      toolbarBottom: Math.max(
        ...islands.map((island) => island.getBoundingClientRect().bottom),
      ),
      paneRight: element.getBoundingClientRect().right,
    };
  });
  expect(geometry.titleTop).toBeGreaterThanOrEqual(geometry.toolbarBottom);
  expect(geometry.titleRight).toBeLessThanOrEqual(geometry.paneRight);
});

test('Markdown and Block Page titles scroll away with long documents', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Scrolling titles');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  for (const kind of ['Markdown', 'Block page'] as const) {
    await createFromSidebar(page, kind);
    const dialog = page.getByRole('dialog', { name: 'Create a new note' });
    await dialog
      .getByRole('textbox', { name: 'Note name' })
      .fill(`Scroll ${kind} ${'long title '.repeat(8).trim()}`);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(
      page.getByRole('tab', {
        name: `Scroll ${kind} ${'long title '.repeat(8).trim()}${kind === 'Markdown' ? '.md' : '.blockpage'}`,
      }),
    ).toHaveAttribute('aria-selected', 'true');
    await page.setViewportSize({ width: 800, height: 650 });

    const pane = page.locator('[data-pane="main"]');
    const editor = pane
      .locator(kind === 'Markdown' ? '.cm-content' : '.ProseMirror')
      .first();
    const scroller = pane
      .locator(kind === 'Markdown' ? '.cm-scroller' : '.flbp-host')
      .first();
    await editor.click();
    await editor.press('Control+End');
    await page.keyboard.insertText(
      Array.from({ length: 100 }, (_, index) => `Line ${index}`).join('\n'),
    );
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      )
      .toBeGreaterThan(200);
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const title = pane.locator('[data-fl-document-name]');
    await expect
      .poll(() =>
        title.evaluate((element) => (element as HTMLElement).style.transform),
      )
      .toMatch(/^(?:|translateY\(0px\))$/);
    const geometry = await pane.evaluate((element) => {
      const heading = element.querySelector<HTMLElement>(
        '[data-fl-document-name] h1',
      );
      const content = element.querySelector<HTMLElement>(
        '.cm-line, .ProseMirror',
      );
      const column = element.querySelector<HTMLElement>(
        '.cm-content, .ProseMirror',
      );
      if (!heading || !content) throw new Error('Missing title or content');
      if (!column) throw new Error('Missing writing column');
      const paneBounds = element.getBoundingClientRect();
      const columnBounds = column.getBoundingClientRect();
      return {
        headingHeight: heading.getBoundingClientRect().height,
        headingFontSize: parseFloat(getComputedStyle(heading).fontSize),
        centerOffset: Math.abs(
          (columnBounds.left +
            columnBounds.right -
            paneBounds.left -
            paneBounds.right) /
            2,
        ),
        gap:
          content.getBoundingClientRect().top -
          heading.getBoundingClientRect().bottom,
        alignment: Math.abs(
          heading.getBoundingClientRect().left -
            content.getBoundingClientRect().left -
            (content.matches('.cm-line')
              ? parseFloat(getComputedStyle(content).paddingLeft)
              : 0),
        ),
      };
    });
    expect(geometry.headingHeight).toBeGreaterThan(
      geometry.headingFontSize * 1.5,
    );
    expect(geometry.gap).toBeGreaterThanOrEqual(0);
    expect(geometry.alignment).toBeLessThan(2);
    expect(geometry.centerOffset).toBeLessThan(2);
    const titleButton = title.getByRole('button', { name: /^Rename Scroll/ });
    const rendered = await titleButton.boundingBox();
    const contentTop = await editor.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    await titleButton.click();
    const titleEditor = title.getByRole('textbox', { name: 'Document name' });
    const editing = await titleEditor.boundingBox();
    expect(rendered).not.toBeNull();
    expect(editing).not.toBeNull();
    expect(Math.abs(editing!.x - rendered!.x)).toBeLessThan(2);
    expect(Math.abs(editing!.y - rendered!.y)).toBeLessThan(2);
    expect(Math.abs(editing!.height - rendered!.height)).toBeLessThan(2);
    expect(
      Math.abs(
        (await editor.evaluate(
          (element) => element.getBoundingClientRect().top,
        )) - contentTop,
      ),
    ).toBeLessThan(2);
    const nextTitle = `${await titleEditor.inputValue()} ${'more title '.repeat(8).trim()}`;
    await titleEditor.fill(nextTitle);
    await expect
      .poll(() =>
        titleEditor.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      )
      .toBeGreaterThan(editing!.height);
    const expanded = await titleEditor.boundingBox();
    const expandedContentTop = await editor.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(expanded).not.toBeNull();
    expect(expandedContentTop).toBeGreaterThanOrEqual(
      expanded!.y + expanded!.height,
    );
    await titleEditor.press('Enter');
    const renamedTitle = title.getByRole('button', {
      name: `Rename ${nextTitle}`,
    });
    await expect(renamedTitle).toBeVisible();
    const confirmed = await renamedTitle.boundingBox();
    expect(confirmed).not.toBeNull();
    expect(Math.abs(confirmed!.height - expanded!.height)).toBeLessThan(2);
    expect(Math.abs(confirmed!.x - expanded!.x)).toBeLessThan(2);
    expect(
      Math.abs(
        (await editor.evaluate(
          (element) => element.getBoundingClientRect().top,
        )) - expandedContentTop,
      ),
    ).toBeLessThan(2);
    const initialTop = await title.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    await scroller.evaluate((element) => {
      element.scrollTop = 240;
    });
    await expect
      .poll(() =>
        title.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeLessThan(initialTop - 200);
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test('Markdown titles wrap and scroll independently in split view', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Split titles');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Markdown');
  const name = `Long ${'x'.repeat(100)}`;
  await page.getByRole('textbox', { name: 'Note name' }).fill(name);
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: `${name}.md` })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const pane = page.locator('[data-pane="main"]');
  const source = pane.locator('.cm-content');
  await source.click();
  await source.press('Control+End');
  await page.keyboard.insertText(
    Array.from({ length: 90 }, (_, index) => `Line ${index}`).join('\n'),
  );
  await expect(source).toContainText('Line 89');
  await page.keyboard.press('Control+s');
  await expect.poll(() => sourceOf(page, `${name}.md`)).toContain('Line 89');
  await setDocumentPresentation(page, 'Split');

  const editorScroller = pane.locator('.cm-scroller');
  const readerScroller = pane.locator('.fl-markdown-reader');
  await expect(readerScroller).toContainText('Line 89');
  await expect
    .poll(() =>
      readerScroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    )
    .toBeGreaterThan(400);
  await editorScroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const editorTitle = editorScroller.locator('[data-fl-document-name]');
  const readerTitle = readerScroller.locator('[data-fl-document-name]');
  await expect(editorTitle).toBeVisible();
  await expect(readerTitle).toBeVisible();
  const bounds = await pane.evaluate((element) => {
    const names = [
      ...element.querySelectorAll<HTMLElement>('[data-fl-document-name]'),
    ];
    const source = element.querySelector<HTMLElement>('.cm-scroller');
    const reader = element.querySelector<HTMLElement>('.fl-markdown-reader');
    if (names.length !== 2 || !source || !reader)
      throw new Error('Missing split titles');
    return names.map((title, index) => ({
      overflow: title.scrollWidth - title.clientWidth,
      titleRight: title.getBoundingClientRect().right,
      sideRight: (index === 0 ? source : reader).getBoundingClientRect().right,
      height: title.getBoundingClientRect().height,
    }));
  });
  for (const bound of bounds) {
    expect(bound.overflow).toBeLessThanOrEqual(1);
    expect(bound.titleRight).toBeLessThanOrEqual(bound.sideRight + 1);
    expect(bound.height).toBeGreaterThan(120);
  }
  await page.screenshot({
    path: test.info().outputPath('markdown-title-split.png'),
  });

  const editorTop = await editorTitle.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const readerTop = await readerTitle.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  await readerScroller.evaluate((element) => {
    element.scrollTop = 220;
  });
  await expect
    .poll(() =>
      readerTitle.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeLessThan(readerTop - 180);
  expect(
    await editorTitle.evaluate(
      (element) => element.getBoundingClientRect().top,
    ),
  ).toBeCloseTo(editorTop, 0);
  await setDocumentPresentation(page, 'View');
  await expect(readerScroller.locator('[data-fl-document-name]')).toHaveCount(
    1,
  );
  await expect(editorTitle).toBeHidden();
  const readerPosition = await readerScroller.evaluate((element) => {
    const title = element.querySelector<HTMLElement>('[data-fl-document-name]');
    const content = element.querySelector<HTMLElement>(
      '[data-fl-markdown-content]',
    );
    if (!title || !content) throw new Error('Missing reading flow');
    return {
      titleTop: title.getBoundingClientRect().top,
      contentTop: content.getBoundingClientRect().top,
      viewportTop: element.getBoundingClientRect().top,
      scrollTop: element.scrollTop,
    };
  });
  expect(readerPosition.contentTop).toBeGreaterThan(readerPosition.titleTop);
  if (readerPosition.scrollTop > 100)
    expect(readerPosition.titleTop).toBeLessThan(readerPosition.viewportTop);
  await setDocumentPresentation(page, 'Split');
  await editorTitle.getByRole('button', { name: `Rename ${name}` }).click();
  await editorTitle
    .getByRole('textbox', { name: 'Document name' })
    .fill('Renamed in Split');
  await editorTitle
    .getByRole('textbox', { name: 'Document name' })
    .press('Enter');
  await expect(readerTitle).toContainText('Renamed in Split');
});

test('Markdown reading column centers title and task checkboxes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Reader layout');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Markdown');
  await page
    .getByRole('textbox', { name: 'Note name' })
    .fill('Reader alignment');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Reader alignment.md' }),
  ).toHaveAttribute('aria-selected', 'true');
  const pane = page.locator('[data-pane="main"]');
  const source = pane.locator('.cm-content');
  await source.click();
  await source.press('Control+End');
  await page.keyboard.insertText('- [ ] todo\n- [x] done\n- ordinary');
  await expect(source).toContainText('ordinary');
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => sourceOf(page, 'Reader alignment.md'))
    .toContain('- [ ] todo');
  await setDocumentPresentation(page, 'View');
  const reader = pane.locator('.fl-markdown-reader');
  await expect(reader).toContainText('ordinary');
  await page.waitForTimeout(350);
  await page.screenshot({
    path: test.info().outputPath('markdown-reading-tasks.png'),
  });
  const layout = await reader.evaluate((element) => {
    const title = element.querySelector<HTMLElement>(
      '[data-fl-document-name] h1',
    );
    const content = element.querySelector<HTMLElement>(
      '[data-fl-markdown-content]',
    );
    const task = element.querySelector<HTMLElement>('li.md-task');
    const checkbox = task?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const taskText = task?.querySelector<HTMLElement>('.md-task-text');
    const ordinary = [...element.querySelectorAll<HTMLElement>('li')].find(
      (item) => item.textContent === 'ordinary',
    );
    if (!title || !content || !task || !checkbox || !taskText || !ordinary)
      throw new Error('Missing reader elements');
    const frame = element.getBoundingClientRect();
    const column = content.getBoundingClientRect();
    return {
      centerOffset: Math.abs(
        (column.left + column.right - frame.left - frame.right) / 2,
      ),
      titleOffset: Math.abs(
        title.getBoundingClientRect().left -
          column.left -
          parseFloat(getComputedStyle(content).paddingLeft),
      ),
      marker: getComputedStyle(task).listStyleType,
      checkboxRight: checkbox.getBoundingClientRect().right,
      textLeft: ordinary.getBoundingClientRect().left,
      taskCenterOffset: Math.abs(
        (checkbox.getBoundingClientRect().top +
          checkbox.getBoundingClientRect().bottom -
          taskText.getBoundingClientRect().top -
          taskText.getBoundingClientRect().bottom) /
          2,
      ),
    };
  });
  expect(layout.centerOffset).toBeLessThan(2);
  expect(layout.titleOffset).toBeLessThan(2);
  expect(layout.marker).toBe('none');
  expect(layout.checkboxRight).toBeLessThanOrEqual(layout.textLeft + 2);
  expect(layout.taskCenterOffset).toBeLessThan(2);
});

test('renaming Markdown with unsaved edits in Split keeps the OPFS file available', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page
    .getByTestId('create-vault-name-input')
    .fill('Rename while editing');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Markdown');
  await page.getByRole('textbox', { name: 'Note name' }).fill('First title');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'First title.md' }),
  ).toHaveAttribute('aria-selected', 'true');
  const pane = page.locator('[data-pane="main"]');
  const source = pane.locator('.cm-content');
  await source.click();
  await source.press('Control+End');
  await page.keyboard.insertText('Edited but not explicitly saved');
  await expect(source).toContainText('Edited but not explicitly saved');
  await setDocumentPresentation(page, 'Split');
  for (const [oldName, nextName] of [
    ['First title', 'Second title'],
    ['Second title', 'Third title'],
  ]) {
    const title = pane.locator('.cm-scroller [data-fl-document-name]');
    await title.getByRole('button', { name: `Rename ${oldName}` }).click();
    await title.getByRole('textbox', { name: 'Document name' }).fill(nextName);
    await title.getByRole('textbox', { name: 'Document name' }).press('Enter');
    await expect(
      title.getByRole('button', { name: `Rename ${nextName}` }),
    ).toBeVisible();
    await expect(pane.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(() => sourceOf(page, `${nextName}.md`))
      .toContain('Edited but not explicitly saved');
  }
});

test('renaming a nested Markdown file keeps its OPFS resource available', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Nested title');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  const pane = page.locator('[data-pane="main"]');
  const source = pane.locator('.cm-content');
  await expect(source).toBeVisible();
  await source.click();
  await source.press('Control+End');
  await page.keyboard.insertText('Nested edit');
  await expect(source).toContainText('Nested edit');
  await setDocumentPresentation(page, 'Split');
  const title = pane.locator('.cm-scroller [data-fl-document-name]');
  await title.getByRole('button', { name: 'Rename welcome' }).click();
  await title
    .getByRole('textbox', { name: 'Document name' })
    .fill('Renamed welcome');
  await title.getByRole('textbox', { name: 'Document name' }).press('Enter');
  await expect(
    title.getByRole('button', { name: 'Rename Renamed welcome' }),
  ).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(() => sourceOf(page, 'Renamed welcome.md'))
    .toContain('Nested edit');
});
