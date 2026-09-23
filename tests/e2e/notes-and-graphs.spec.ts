import { expect, test } from '@playwright/test';

test('creates an independent graph and saves rendered Markdown notes', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop editing workflow');
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose graph' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your graph' })).toBeVisible();
  await page.getByPlaceholder('e.g. World models, Reading list…').fill('Notes test');
  await page.getByRole('button', { name: 'Create empty graph' }).click();
  await page.getByRole('button', { name: /Notes test.*Open graph/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Your paper universe starts here.' }),
  ).toBeVisible();
  const child = new URL(page.url()).origin;
  const graph = await (await page.request.get(child + '/api/graph')).json();
  expect(graph.nodes).toHaveLength(0);
  graph.meta.revision++;
  graph.nodes = [
    {
      id: 'cluster:notes',
      type: 'cluster',
      label: 'Notes',
      origin: 'user',
      status: 'accepted',
    },
    {
      id: 'paper:alpha',
      type: 'paper',
      label: 'Alpha blog',
      cluster: 'cluster:notes',
      origin: 'user',
      status: 'accepted',
      paper: {
        source_kind: 'blog',
        title: 'Alpha blog',
        authors: [],
        year: null,
        venue: 'Example',
        url: 'https://example.org/alpha',
        summary: 'Synthetic browser test.',
        key_findings: [],
      },
    },
  ];
  expect(
    (
      await page.request.put(child + '/api/graph', { data: { base_revision: 0, graph } })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: '2D lineage view' }).click();
  await page.getByTestId('lineage-paper').click();
  const notes = '## A useful idea\n\n- **My observation**\n\n$$\nL = x^2\n$$';
  await page.getByRole('textbox', { name: 'Personal notes', exact: true }).fill(notes);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A useful idea' })).toBeVisible();
  await expect(page.locator('.notes-preview .katex')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  const saved = await (await page.request.get(child + '/api/graph')).json();
  expect(saved.nodes.find((n: { id: string }) => n.id === 'paper:alpha').notes).toBe(notes);
  await page.getByRole('button', { name: 'Add paper', exact: true }).click();
  await page.getByRole('combobox', { name: 'Source type' }).selectOption('website');
  await expect(page.getByText('Website URL', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Choose graph' }).click();
  const catalog = await (await page.request.get(child + '/api/graphs')).json();
  const main = catalog.graphs.find((g: { id: string }) => g.id === 'main');
  await page.getByRole('button', { name: new RegExp(main.name) }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  const mainGraph = await (await page.request.get('/api/graph')).json();
  expect(mainGraph.nodes.some((n: { id: string }) => n.id === 'paper:alpha')).toBeFalsy();
});
