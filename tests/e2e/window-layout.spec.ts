import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop window layout');
  // Include the native sync control, which is absent in an ordinary browser.
  await page.addInitScript(() => {
    window.orbis = {
      status: async () => ({
        configured: true,
        connected: true,
        paired: true,
        email: '',
        library: '',
        signingIn: false,
        phase: 'error',
        vaults: [],
        conflicts: [],
      }),
      getPreferences: async () => ({}),
      setPreference: async () => {},
      onBeforeClose: () => () => {},
      onLibraryChanged: () => () => {},
      onDocumentsChanged: () => () => {},
    } as NonNullable<Window['orbis']>;
  });
});

async function expectHeaderFits(page: Page) {
  const layout = await page.locator('.app-header').evaluate((header) => {
    const box = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    return {
      width: innerWidth,
      header: box(header),
      columns: ['.brand', '.global-search', '.header-actions'].map((selector) =>
        box(header.querySelector(selector)!),
      ),
      buttons: [...header.querySelectorAll('.header-actions button')].map(box),
      icons: [...header.querySelectorAll('button > svg')].map(box),
    };
  });
  for (const button of layout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(layout.width);
    expect(button.top).toBeGreaterThanOrEqual(layout.header.top);
    expect(button.bottom).toBeLessThanOrEqual(layout.header.bottom);
    expect(button.height).toBeGreaterThanOrEqual(28);
  }
  for (const icon of layout.icons) {
    expect(icon.width).toBeGreaterThanOrEqual(14);
    expect(Math.abs(icon.width - icon.height)).toBeLessThan(1);
  }
  for (let first = 0; first < layout.columns.length; first++) {
    for (let second = first + 1; second < layout.columns.length; second++) {
      const a = layout.columns[first];
      const b = layout.columns[second];
      const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (verticalOverlap > 0)
        expect(Math.min(a.right, b.right) - Math.max(a.left, b.left)).toBeLessThanOrEqual(
          0,
        );
    }
  }
  await expect(page.getByPlaceholder('Search papers, authors, concepts')).toBeVisible();
}

test('keeps header controls usable and gives the galaxy room in compact windows', async ({
  page,
}) => {
  await page.goto('/');
  const stage = page.getByTestId('graph-stage');
  await expect(stage).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Google Drive sync settings' }),
  ).toHaveAttribute('title', 'Sync needs attention');
  for (const [width, height] of [
    [1440, 960],
    [1280, 800],
    [1201, 800],
    [1200, 800],
    [1121, 760],
    [1120, 760],
    [1000, 700],
    [800, 600],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expectHeaderFits(page);
  }
  await page.setViewportSize({ width: 800, height: 600 });
  const search = page.getByPlaceholder('Search papers, authors, concepts');
  await search.fill('DayDreamer');
  await page.getByRole('button', { name: /^DayDreamer \(Wu/ }).click();
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.locator('.side-panel')).toBeHidden();
  const canvas = stage.locator('canvas');
  await canvas.evaluate((element) => element.setAttribute('data-resize-retained', 'yes'));
  await expect
    .poll(() => stage.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(320);
  await expect
    .poll(async () => {
      const scene = (await stage.boundingBox())!;
      const drawing = (await canvas.boundingBox())!;
      return Math.abs(drawing.width - scene.width);
    })
    .toBeLessThan(2);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(page.locator('.side-panel')).toBeVisible();
  await expect(search).toHaveValue('DayDreamer');
  await page.getByRole('button', { name: /^DayDreamer \(Wu/ }).click();
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await expect(page.locator('.side-panel')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-resize-retained', 'yes');
  await page.getByRole('button', { name: 'Google Drive sync settings' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your library, everywhere' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close sync settings' }).click();
  await page.getByRole('button', { name: 'Add paper', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Add a paper or web source' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close add paper dialog' }).click();
  await page.screenshot({ path: 'test-results/compact-window.png' });
});

test('fits PDFs and reader controls after shrinking and enlarging the window', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByPlaceholder('Search papers, authors, concepts').fill('DayDreamer');
  await page.getByRole('button', { name: /^DayDreamer \(Wu/ }).click();
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  const reader = page.getByRole('dialog', { name: /DayDreamer: World Models/ });
  await reader
    .getByLabel('Attach original file')
    .setInputFiles(`${process.env.ORBIS_E2E_ROOT}/reader-citations.pdf`);
  await expect(reader.locator('.paper-file-bar option:checked')).toContainText(
    'reader-citations.pdf',
  );
  await expect(reader.locator('.pdf-page')).toHaveCount(4);
  const secondPage = reader.locator('.pdf-page[data-page="2"]');
  const viewport = reader.locator('.pdf-viewport');
  await reader.getByLabel('PDF page', { exact: true }).fill('2');
  await expect(secondPage).toHaveAttribute('aria-busy', 'false');
  await viewport.hover();
  await page.mouse.wheel(0, 150);
  const readingPosition = async () => {
    const paper = (await secondPage.boundingBox())!;
    const area = (await viewport.boundingBox())!;
    return (area.y + 32 - paper.y) / paper.height;
  };
  await expect.poll(readingPosition).toBeGreaterThan(0.1);
  const position = await readingPosition();
  for (const [width, height] of [
    [1120, 760],
    [1000, 700],
    [800, 600],
    [1440, 960],
    [800, 600],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(secondPage).toHaveAttribute('aria-busy', 'false');
    await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('2');
    await expect.poll(readingPosition).toBeCloseTo(position, 2);
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    const bounds = (await reader.locator('.paper-original').boundingBox())!;
    for (const control of await reader
      .locator('.paper-file-bar button, .reader-toolbar button, .reader-toolbar label')
      .all()) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    }
    expect((await viewport.boundingBox())!.height).toBeGreaterThan(150);
    await expect(reader.getByRole('tab')).toHaveCount(4);
    for (const tab of await reader.getByRole('tab').all())
      await expect(tab).toBeInViewport({ ratio: 1 });
  }
  await reader.getByRole('button', { name: 'Browse papers', exact: true }).click();
  await expect(
    reader.getByRole('complementary', { name: 'Reader library' }),
  ).toBeInViewport();
  await reader.getByRole('button', { name: 'Browse papers', exact: true }).click();
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await reader
    .getByRole('region', { name: 'My notes', exact: true })
    .getByRole('button', {
      name: 'Write',
      exact: true,
    })
    .click();
  await expect(
    reader.getByRole('textbox', { name: 'My notes', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: 'test-results/compact-reader.png' });
  await reader.getByLabel('PDF zoom').selectOption('1.25');
  await expect(secondPage).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(1);
});
