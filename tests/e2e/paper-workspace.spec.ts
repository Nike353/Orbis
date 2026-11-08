import { expect, test, type Locator } from '@playwright/test';

const pdfPage = (reader: Locator, number: number) =>
  reader.locator(`.pdf-page[data-page="${number}"]`);

test('reads, annotates and discusses an original while preserving the galaxy and drafts', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop reading workflow');
  await page.goto('/');
  const stage = page.getByTestId('graph-stage');
  await expect(stage).toBeVisible();
  await page.getByRole('button', { name: 'Time', exact: true }).click();
  await page.getByPlaceholder('Search papers, authors, concepts').fill('Diffusion Policy');
  await page.getByRole('button', { name: /Diffusion Policy \(Chi/ }).click();
  const canvas = page.locator('.graph-stage canvas');
  await expect(canvas).toBeVisible();
  await canvas.evaluate((element) => element.setAttribute('data-reader-retained', 'yes'));
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  const reader = page.getByRole('dialog', { name: /Diffusion Policy/ });
  await expect(reader).toBeVisible();
  await reader
    .getByLabel('Attach original file')
    .setInputFiles(`${process.env.ORBIS_E2E_ROOT}/reader-fixture.pdf`);
  await expect(pdfPage(reader, 1)).toHaveAttribute('aria-busy', 'false');
  await expect(pdfPage(reader, 1).locator('.textLayer')).toContainText('1 Introduction');
  await reader.getByLabel('Search PDF text').fill('82 percent');
  await reader.getByRole('button', { name: /Page 3 ·/ }).click();
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('3');
  await expect(pdfPage(reader, 3).locator('.textLayer')).toContainText(
    '82 percent accuracy',
  );
  await reader.getByLabel('PDF zoom').selectOption('1.25');
  await expect(pdfPage(reader, 3)).toHaveAttribute('aria-busy', 'false');
  await pdfPage(reader, 3)
    .locator('.textLayer')
    .evaluate((layer) => {
      const span = [...layer.querySelectorAll('span')].find((element) =>
        element.textContent?.includes('82 percent'),
      )!;
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await reader.getByRole('button', { name: 'Highlight and comment', exact: true }).click();
  await expect(reader.getByRole('tab', { name: 'My notes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(reader.getByRole('blockquote')).toContainText('82 percent');
  await expect(reader.getByLabel('Highlight comment')).toBeFocused();
  await reader
    .getByLabel('Highlight comment')
    .fill('Keep this **result** linked to the source.');
  const notes = reader.getByRole('region', { name: 'My notes', exact: true });
  await notes.getByRole('button', { name: 'Write', exact: true }).click();
  await notes
    .getByLabel('My notes', { exact: true })
    .fill('My personal reading notes: $x^2$ stays separate.');
  await reader.getByRole('button', { name: 'Save notes', exact: true }).click();
  await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
  await reader
    .getByRole('textbox', { name: 'Your question' })
    .fill('Reader test: What accuracy and baseline are reported?');
  await reader.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(reader.getByText('Original-source excerpts', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await reader.getByText('Sources and context (1)', { exact: true }).click();
  await reader.locator('.research-sources button').click();
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('3');
  await reader
    .getByRole('textbox', { name: 'Your question' })
    .fill('A discussion draft I have not sent yet.');
  await reader.getByRole('button', { name: 'Back to galaxy', exact: true }).click();
  await expect(reader).not.toBeVisible();
  await expect(canvas).toHaveAttribute('data-reader-retained', 'yes');
  await expect(stage).toHaveAttribute('data-lens', 'time');
  await expect(stage).toHaveAttribute(
    'data-selected-node',
    'paper:chi2023-diffusion-policy',
  );
  await expect(page.getByPlaceholder('Search papers, authors, concepts')).toHaveValue(
    'Diffusion Policy',
  );
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
  await expect(reader.getByRole('textbox', { name: 'Your question' })).toHaveValue(
    'A discussion draft I have not sent yet.',
  );
  await expect(reader.locator('.research-turn')).toHaveCount(1);
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await expect(reader.getByLabel('Highlight comment')).toHaveValue(
    'Keep this **result** linked to the source.',
  );
  await reader.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(reader.locator('.annotation-card .markdown-content')).toContainText(
    'Keep this result linked to the source.',
  );
  await expect(reader.locator('.notes-preview')).toContainText('My personal reading notes');
  await expect(reader.locator('.notes-preview .katex')).toHaveCount(1);
  await reader.getByRole('tab', { name: /^Connections/ }).click();
  await expect(reader.locator('.paper-connection-card')).not.toHaveCount(0);
  await expect(
    reader.locator('.paper-connection-card .markdown-content').first(),
  ).not.toBeEmpty();
  await page.screenshot({ path: 'test-results/reader-connections.png', fullPage: true });
  await reader.getByRole('tab', { name: 'Summary', exact: true }).click();
  await page.screenshot({ path: 'test-results/paper-reader.png', fullPage: true });
  await reader.getByRole('button', { name: 'Regenerate with review', exact: true }).click();
  const question = reader.getByRole('textbox', { name: 'Your question' });
  await expect(question).toHaveValue(/A discussion draft I have not sent yet/);
  await expect(question).toHaveValue(/Regenerate the summary/);
  await question.fill(
    'Reader test: TEST_SUMMARY. Regenerate the summary of this paper for review.',
  );
  await reader.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(reader.getByRole('heading', { name: /Replace paper summary/ })).toBeVisible({
    timeout: 15000,
  });
  await expect(reader.locator('.change-preview pre')).toHaveCount(0);
  await reader.getByRole('button', { name: 'Accept all 1 changes', exact: true }).click();
  await reader.getByRole('tab', { name: 'Summary', exact: true }).click();
  await expect(reader.locator('#paper-panel-Summary')).toContainText(
    'Motivation and problem',
  );
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await expect(reader.locator('.notes-preview')).toContainText('My personal reading notes');
  await reader.getByRole('button', { name: 'Back to galaxy', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-reader-retained', 'yes');
  await expect(stage).toHaveAttribute('data-lens', 'time');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByLabel('Show completed work').check();
  await expect(page.locator('.activity-card')).not.toHaveCount(0);
  await expect(page.locator('.activity-meta')).toContainText(['discussion']);
});

test('previews PDF references and reveals highlight comments without interfering with selection', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop reading workflow');
  await page.goto('/');
  await page.getByPlaceholder('Search papers, authors, concepts').fill('DayDreamer');
  await page.getByRole('button', { name: /^DayDreamer \(Wu/ }).click();
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  const reader = page.getByRole('dialog', { name: /DayDreamer: World Models/ });
  await reader
    .getByLabel('Attach original file')
    .setInputFiles(`${process.env.ORBIS_E2E_ROOT}/reader-citations.pdf`);
  await expect(pdfPage(reader, 1)).toHaveAttribute('aria-busy', 'false');
  const citation = reader.getByRole('link', { name: 'Reference example2026', exact: true });
  const second = reader.getByRole('link', { name: 'Reference reader2025', exact: true });
  await expect(reader.locator('.pdf-citation-link')).toHaveCount(2);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/annotations'))
      writes.push(request.url());
  });
  const box = (await citation.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const reference = reader.getByRole('tooltip', { name: 'PDF reference' });
  await expect(reference).toContainText(
    'A. Example, B. Author, and C. Researcher. Evidence-linked reading. Journal of Synthetic Research, 12(3): 10-24, 2026.',
  );
  await expect(reference).not.toContainText('B. Reader.');
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('1');
  expect(writes).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(reference).not.toBeVisible();
  await expect(reader).toBeVisible();
  await citation.focus();
  await expect(reference).toContainText('Evidence-linked reading.');
  await page.keyboard.press('Enter');
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('4');
  await expect(pdfPage(reader, 4)).toHaveAttribute('aria-busy', 'false');
  const viewport = reader.locator('.pdf-viewport');
  const source = pdfPage(reader, 4).locator('.textLayer span').filter({
    hasText: 'A. Example, B. Author, and C. Researcher.',
  });
  await expect
    .poll(async () => {
      const entry = (await source.boundingBox())!;
      const area = (await viewport.boundingBox())!;
      return entry.y - area.y;
    })
    .toBeLessThan(80);
  await reader.getByRole('button', { name: 'Back to citation', exact: true }).click();
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('1');
  await expect(pdfPage(reader, 1)).toHaveAttribute('aria-busy', 'false');
  await second.focus();
  await expect(reference).toContainText(
    'B. Reader. Reliable citation previews in a personal library. Proceedings of the Fixture Conference, pages 30-44, 2025.',
  );
  await expect(reference).not.toContainText('Appendix');
  await page.keyboard.press('Escape');
  await reader.getByLabel('PDF zoom').selectOption('1.25');
  await expect(pdfPage(reader, 1)).toHaveAttribute('aria-busy', 'false');
  const firstText = pdfPage(reader, 1).locator('.textLayer span').filter({
    hasText: 'Example et al. (2026) describe evidence-linked reading.',
  });
  const lastText = pdfPage(reader, 1).locator('.textLayer span').filter({
    hasText: 'Reader (2025) adds a second reference.',
  });
  const start = (await firstText.boundingBox())!;
  const end = (await lastText.boundingBox())!;
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(reader.locator('.selection-actions')).toContainText(
    'evidence-linked reading.',
  );
  await pdfPage(reader, 1)
    .locator('.textLayer')
    .evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
      ),
    );
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('1');
  await reader.getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect(reader.locator('.page-highlight')).toHaveCount(2);
  const marker = reader.getByRole('button', { name: /^View highlight:/ });
  await expect(marker).toHaveCount(1);
  const beforeHover = writes.length;
  await marker.scrollIntoViewIfNeeded();
  await page.mouse.move(10, 10);
  await marker.hover();
  const comment = reader.getByRole('dialog', { name: 'Highlight comment', exact: true });
  await expect(comment).toContainText('No comment yet.');
  expect(writes).toHaveLength(beforeHover);
  await page.keyboard.press('Escape');
  await expect(comment).not.toBeVisible();
  await marker.focus();
  await page.keyboard.press('Tab');
  await expect(
    comment.getByRole('button', { name: 'Close highlight preview', exact: true }),
  ).toBeFocused();
  await page.waitForTimeout(250);
  await expect(comment).toBeVisible();
  await comment
    .getByRole('button', { name: 'Close highlight preview', exact: true })
    .click();
  await expect(comment).not.toBeVisible();
  await expect(marker).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(reader.getByRole('tab', { name: 'My notes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(reader.locator('.annotation-card.active')).toBeFocused();
  await reader.getByRole('button', { name: 'Add comment', exact: true }).click();
  await reader
    .getByLabel('Highlight comment')
    .fill('# Reading note\n\nA comment on both selected lines.');
  await reader.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(reader.locator('.annotation-comment')).toContainText(
    'A comment on both selected lines.',
  );
  await marker.scrollIntoViewIfNeeded();
  await page.mouse.move(10, 10);
  await marker.hover();
  await expect(comment).toContainText('A comment on both selected lines.');
  await expect(comment.getByRole('heading', { name: 'Reading note' })).toBeVisible();
  await page.screenshot({
    path: 'test-results/reader-comment-preview.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await reader.getByRole('button', { name: 'Open page 1', exact: true }).click();
  await expect
    .poll(async () => {
      const passage = (await firstText.boundingBox())!;
      const area = (await viewport.boundingBox())!;
      return passage.y - area.y;
    })
    .toBeLessThan(80);
  const resize = reader.getByRole('separator', { name: 'Resize paper side panel' });
  await resize.focus();
  for (let step = 0; step < 8; step++) await page.keyboard.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', '280');
  await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
  expect(
    await reader
      .locator('.paper-discussion')
      .evaluate((element) => getComputedStyle(element).display),
  ).toBe('flex');
  const sessions = (await reader.locator('.conversation-list').boundingBox())!;
  const discussion = (await reader.locator('.research-content').boundingBox())!;
  expect(discussion.y).toBeGreaterThan(sessions.y + sessions.height - 1);
  await page.screenshot({
    path: 'test-results/reader-narrow-discussion.png',
    fullPage: true,
  });
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await page.screenshot({ path: 'test-results/reader-comments.png', fullPage: true });
  await reader.getByRole('button', { name: 'Back to galaxy', exact: true }).click();
  await expect(page.getByTestId('graph-stage')).toBeVisible();
});

test('scrolls continuously with accurate page anchors and bounded canvas rendering', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop reading workflow');
  await page.goto('/');
  await page.getByPlaceholder('Search papers, authors, concepts').fill('DayDreamer');
  await page.getByRole('button', { name: /^DayDreamer \(Wu/ }).click();
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  const reader = page.getByRole('dialog', { name: /DayDreamer: World Models/ });
  await reader
    .getByLabel('Attach original file')
    .setInputFiles(`${process.env.ORBIS_E2E_ROOT}/reader-citations.pdf`);
  await reader.getByLabel('PDF page', { exact: true }).fill('1');
  await expect(reader.locator('.pdf-page')).toHaveCount(4);
  await expect(pdfPage(reader, 1)).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() =>
      reader
        .locator('.pdf-page canvas')
        .evaluateAll(
          (canvases) =>
            canvases.filter((canvas) => (canvas as HTMLCanvasElement).width > 0).length,
        ),
    )
    .toBeLessThan(4);
  const viewport = reader.locator('.pdf-viewport');
  const secondPage = pdfPage(reader, 2);
  const area = (await viewport.boundingBox())!;
  const second = (await secondPage.boundingBox())!;
  await viewport.hover();
  await page.mouse.wheel(0, second.y - area.y + 150);
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await expect(secondPage).toHaveAttribute('aria-busy', 'false');
  const position = async () => {
    const bounds = (await secondPage.boundingBox())!;
    const view = (await viewport.boundingBox())!;
    return (view.y + 32 - bounds.y) / bounds.height;
  };
  const beforeZoom = await position();
  expect(beforeZoom).toBeGreaterThan(0.1);
  // Updating the remembered page must not snap to the top of that page.
  await expect.poll(position).toBeGreaterThan(0.1);
  await reader.getByLabel('PDF zoom').selectOption('1.25');
  await expect(secondPage).toHaveAttribute('aria-busy', 'false');
  await expect.poll(position).toBeCloseTo(beforeZoom, 2);
  const method = secondPage.locator('.textLayer span').filter({
    hasText: 'The method uses a local full-text index',
  });
  await method.evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await reader.getByRole('button', { name: 'Highlight and comment', exact: true }).click();
  await expect(reader.locator('.annotation-card.active .annotation-anchor')).toHaveText(
    'Open page 2',
  );
  await reader
    .getByLabel('Highlight comment')
    .fill('A comment on the scrolled second page.');
  await reader.getByRole('button', { name: 'Save comment', exact: true }).click();
  await reader.getByLabel('PDF page', { exact: true }).fill('4');
  await expect(pdfPage(reader, 4)).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() =>
      pdfPage(reader, 1)
        .locator('canvas')
        .evaluate((canvas) => canvas.width),
    )
    .toBe(0);
  const openHighlight = reader.locator('.annotation-card.active').getByRole('button', {
    name: 'Open page 2',
    exact: true,
  });
  await openHighlight.click();
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await expect(secondPage).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(async () => {
      const passage = (await method.boundingBox())!;
      const view = (await viewport.boundingBox())!;
      return passage.y - view.y;
    })
    .toBeLessThan(80);
  await reader.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('3');
  await expect(pdfPage(reader, 3)).toHaveAttribute('aria-busy', 'false');
  await reader.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await page.screenshot({
    path: 'test-results/reader-continuous-scroll.png',
    fullPage: true,
  });
  await reader.getByRole('button', { name: 'Back to galaxy', exact: true }).click();
  await expect(page.getByTestId('graph-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await expect(secondPage).toHaveAttribute('aria-busy', 'false');
});
