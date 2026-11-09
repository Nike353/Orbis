import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Other workflow tests start past onboarding; these exercise a genuinely fresh profile.
test.use({ storageState: { cookies: [], origins: [] } });

test('first launch, complete tour, restart, replay, and skip', async ({
  page,
}, testInfo) => {
  const writes: string[] = [];
  // A fresh install has no papers; the tour must still work without sample data.
  await page.route('**/api/graph', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: readFileSync('data/graph.json', 'utf8'),
    }),
  );
  page.on('request', (r) => {
    if (r.method() === 'POST') writes.push(r.url());
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Welcome to your research universe.');
  await page.screenshot({
    path: `test-results/tutorial-welcome-${testInfo.project.name}.png`,
  });
  await page.getByRole('button', { name: 'Show me around' }).click();
  for (let step = 1; step <= 6; step++) {
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.locator('.app-header')).toHaveAttribute('inert', '');
    if (step === 1) {
      await expect(dialog).toHaveAccessibleName('Start with a source.');
      await expect(page.locator('.orbis-tour-spotlight')).toBeVisible();
      await page.screenshot({
        path: `test-results/tutorial-source-${testInfo.project.name}.png`,
      });
    }
    await dialog
      .getByRole('button', { name: step === 6 ? 'Start using Orbis' : 'Next', exact: true })
      .click();
  }
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
  await expect(page.locator('.app-header')).not.toHaveAttribute('inert', '');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open tutorial' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Open tutorial' }).click();
  await expect(dialog).toHaveAccessibleName('Welcome to your research universe.');
  await page.getByRole('button', { name: 'Skip tutorial' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open tutorial' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test('Escape skips the first tour and keyboard focus stays inside it', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Show me around' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Skip tutorial' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Show me around' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open tutorial' })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open tutorial' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
