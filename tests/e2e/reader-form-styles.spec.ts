import { expect, test, type Locator } from '@playwright/test';

async function expectReadable(control: Locator, placeholder = false) {
  await expect(control).toBeVisible();
  const contrast = await control.evaluate((element, checkPlaceholder) => {
    const style = getComputedStyle(element);
    let background = style.backgroundColor;
    let parent = element.parentElement;
    while (background === 'rgba(0, 0, 0, 0)' && parent) {
      background = getComputedStyle(parent).backgroundColor;
      parent = parent.parentElement;
    }
    const luminance = (color: string) => {
      const [r, g, b] = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const ratio = (color: string) => {
      const foreground = luminance(color);
      const surface = luminance(background);
      return (
        (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05)
      );
    };
    const hint = checkPlaceholder ? getComputedStyle(element, '::placeholder') : null;
    return {
      text: ratio(style.color),
      caret: ratio(style.caretColor),
      placeholder: hint ? ratio(hint.color) : 0,
      placeholderOpacity: hint?.opacity,
    };
  }, placeholder);
  expect(contrast.text).toBeGreaterThanOrEqual(4.5);
  expect(contrast.caret).toBeGreaterThanOrEqual(4.5);
  if (placeholder) {
    expect(contrast.placeholder).toBeGreaterThanOrEqual(4.5);
    expect(contrast.placeholderOpacity).toBe('1');
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`keeps reader forms readable and Inspector actions compact in a ${colorScheme} OS theme`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop reader controls');
    await page.emulateMedia({ colorScheme });
    await page.goto('/');
    await page.getByPlaceholder('Search papers, authors, concepts').fill('DayDreamer');
    await page.getByRole('button', { name: /^DayDreamer \(Wu/ }).click();
    const actions = page.getByRole('group', { name: 'Research actions' });
    const read = actions.getByRole('button', { name: 'Read paper', exact: true });
    await expect(read).toHaveText('Read');
    await expect(
      actions.getByRole('button', { name: 'Discuss this paper', exact: true }),
    ).toHaveText('Discuss');
    await expect(
      actions.getByRole('button', { name: 'Compare with papers', exact: true }),
    ).toHaveText('Compare');
    const boxes = await actions.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const { top, height } = button.getBoundingClientRect();
        return { top, height };
      }),
    );
    expect(Math.max(...boxes.map((box) => box.top)) - boxes[0].top).toBeLessThan(1);
    expect(Math.max(...boxes.map((box) => box.height))).toBeLessThanOrEqual(34);
    const row = (await actions.boundingBox())!;
    const title = (await page.locator('.inspector .paper-details h3').boundingBox())!;
    expect(Math.abs(row.x - title.x)).toBeLessThan(1);
    await actions.screenshot({ path: `test-results/inspector-actions-${colorScheme}.png` });
    await read.click();
    const reader = page.getByRole('dialog', { name: /DayDreamer: World Models/ });
    await reader
      .getByLabel('Attach original file')
      .setInputFiles(`${process.env.ORBIS_E2E_ROOT}/reader-fixture.pdf`);
    await expect(reader.locator('.paper-file-bar option:checked')).toContainText(
      'reader-fixture.pdf',
    );
    const firstPage = reader.locator('.pdf-page[data-page="1"]');
    await expect(firstPage).toHaveAttribute('aria-busy', 'false');
    await expect(firstPage.locator('.textLayer')).toContainText('1 Introduction');
    // Load the actual PDF reader so its imported viewer styles participate in the cascade.
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
    await expectReadable(reader.getByLabel('PDF page', { exact: true }));
    await expectReadable(reader.getByLabel('Paper original', { exact: true }));
    await expectReadable(reader.getByLabel('Search PDF text', { exact: true }), true);
    await firstPage.locator('.textLayer').evaluate((layer) => {
      const span = [...layer.querySelectorAll('span')].find(
        (element) => (element.textContent?.trim().length ?? 0) > 30,
      )!;
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await reader
      .getByRole('button', { name: 'Highlight and comment', exact: true })
      .click();
    const annotation = reader.locator('.annotation-card.active');
    const comment = annotation.getByLabel('Highlight comment');
    await comment.fill(`A readable comment in the ${colorScheme} system theme.`);
    await expectReadable(comment, true);
    await expectReadable(annotation.getByLabel('Highlight color'));
    await page.screenshot({
      path: `test-results/reader-form-${colorScheme}.png`,
      fullPage: true,
    });
    await annotation.getByRole('button', { name: 'Save comment', exact: true }).click();
    const notes = reader.getByRole('region', { name: 'My notes', exact: true });
    await notes.getByRole('button', { name: 'Write', exact: true }).click();
    const note = notes.getByLabel('My notes', { exact: true });
    await note.fill('Readable Markdown notes.');
    await expectReadable(note, true);
    await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
    const question = reader.getByRole('textbox', { name: 'Your question' });
    await question.fill('A readable question.');
    await expectReadable(question, true);
    for (const settings of await reader.locator('.agent-model-settings select').all()) {
      await expectReadable(settings);
    }
    await reader.getByRole('button', { name: 'Back to galaxy', exact: true }).click();
    await expectReadable(page.getByRole('textbox', { name: 'Label', exact: true }));
    await expectReadable(page.getByRole('textbox', { name: 'Description', exact: true }));
    await expectReadable(page.getByRole('combobox', { name: 'Cluster', exact: true }));
  });
}
