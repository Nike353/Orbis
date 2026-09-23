import { expect, test } from '@playwright/test';

test('passes selected model and effort from add, discuss, and compare', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop agent settings workflow');
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    health.agents.forEach((a: { available: boolean }) => {
      a.available = true;
    });
    health.default_agent = 'codex';
    await route.fulfill({ json: health });
  });
  let inserted: { settings?: { model: string; effort: string } } = {};
  await page.route('**/api/insert', async (route) => {
    inserted = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'done',
          ok: true,
          outcome: 'excluded',
          reason: 'Synthetic settings test',
          summary: '',
          graph_node_id: null,
          duration_s: 0,
          cost_usd: null,
        }) + '\n',
    });
  });
  const requests: { settings: { model: string; effort: string } }[] = [];
  await page.route('**/api/research/*/turns', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'completed' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add paper', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.6-sol');
  await expect(page.getByLabel('Effort')).toHaveValue('medium');
  await page.getByLabel('Model', { exact: true }).selectOption('gpt-5.5');
  await page.getByLabel('Effort').selectOption('high');
  await page.getByRole('textbox', { name: 'Paper URL' }).fill('https://example.org/test');
  await page.getByRole('button', { name: 'Read & add' }).click();
  await expect.poll(() => inserted.settings).toEqual({ model: 'gpt-5.5', effort: 'high' });
  await page.getByRole('button', { name: 'Close add paper dialog' }).click();
  await page.getByRole('button', { name: 'Discuss', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.5');
  await page.getByPlaceholder(/What is the key idea/).fill('Explain my research library');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].settings).toEqual({ model: 'gpt-5.5', effort: 'high' });
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.locator('.scope-picker input[type="checkbox"]').nth(0).check();
  await page.locator('.scope-picker input[type="checkbox"]').nth(1).check();
  await page.getByLabel('Research agent').selectOption('claude');
  await page.getByLabel('Model', { exact: true }).selectOption('opus');
  await page.getByLabel('Effort').selectOption('medium');
  await page.getByRole('button', { name: 'Build comparison' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].settings).toEqual({ model: 'opus', effort: 'medium' });
  await page.reload();
  await page.getByRole('button', { name: 'Add paper', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('opus');
  await expect(page.getByLabel('Effort')).toHaveValue('medium');
  await page.screenshot({ path: 'test-results/agent-model-settings.png' });
});
