import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const fixtureRoot = process.env.ORBIS_E2E_ROOT;
const canonicalGraph = JSON.parse(
  readFileSync(fixtureRoot ? `${fixtureRoot}/data/graph.json` : 'data/graph.json', 'utf8'),
);
const canonicalPaperCount = canonicalGraph.nodes.filter(
  (node: { type: string }) => node.type === 'paper',
).length;
const canonicalConceptCount = canonicalGraph.nodes.filter(
  (node: { type: string }) => node.type !== 'paper' && node.type !== 'cluster',
).length;
const visiblePaperIds = new Set(
  canonicalGraph.nodes
    .filter(
      (node: { type: string; status: string }) =>
        node.type === 'paper' && node.status !== 'rejected',
    )
    .map((node: { id: string }) => node.id),
);
const canonicalLineageCount = new Set(
  canonicalGraph.nodes
    .filter((node: { id: string }) => visiblePaperIds.has(node.id))
    .map((node: { cluster?: string }) => node.cluster),
).size;
const canonicalPaperEdgeCount = canonicalGraph.edges.filter(
  (edge: { source: string; target: string; status: string }) =>
    edge.status !== 'rejected' &&
    visiblePaperIds.has(edge.source) &&
    visiblePaperIds.has(edge.target),
).length;

async function waitForWorkspace(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Orbis', { exact: true })).toBeVisible();
  await expect(page.getByTestId('graph-stage')).toBeVisible();
}

async function verifyCanvasPixels(page: Page, name: string) {
  const canvas = page.locator('.graph-stage canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1_800);
  const buffer = await canvas.screenshot({
    path: `test-results/${name}-canvas.png`,
  });
  const png = PNG.sync.read(buffer);
  let foreground = 0;
  let saturated = 0;
  const colors = new Set<string>();
  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
    if (Math.abs(red - 17) + Math.abs(green - 20) + Math.abs(blue - 24) > 38) {
      foreground += 1;
    }
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > 45) {
      saturated += 1;
    }
  }
  expect(foreground).toBeGreaterThan(500);
  expect(saturated).toBeGreaterThan(120);
  expect(colors.size).toBeGreaterThan(12);
}

test.describe('Orbis product workspace', () => {
  test('renders a nonblank interactive 3D graph and core desktop workflows', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop interaction scenario');
    await waitForWorkspace(page);
    await verifyCanvasPixels(page, 'desktop');
    await page.screenshot({
      path: 'test-results/desktop-workspace.png',
      fullPage: true,
    });

    await expect(page.locator('.side-panel')).toHaveCount(0);
    await expect(page.getByText(`${canonicalPaperCount} papers`)).toBeVisible();
    await page
      .getByPlaceholder('Search papers, authors, concepts')
      .fill('Diffusion Policy');
    await expect(
      page.getByRole('button', { name: /Diffusion Policy \(Chi/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: /Diffusion Policy \(Chi/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Diffusion Policy (Chi et al. 2023)' }),
    ).toBeVisible();
    await expect(page.getByText('Connection evidence')).not.toBeVisible();
    await page.screenshot({
      path: 'test-results/desktop-node-inspector.png',
      fullPage: true,
    });

    await page.getByPlaceholder('Search papers, authors, concepts').fill('');
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('checkbox', { name: 'paper' }).uncheck();
    await expect(page.getByText('0 papers')).toBeVisible();
    await page.getByRole('button', { name: 'Reset all filters' }).click();
    await expect(page.getByText(`${canonicalPaperCount} papers`)).toBeVisible();
    await page
      .getByPlaceholder('Search papers, authors, concepts')
      .fill('no-results-for-empty-state');
    await expect(page.getByText('No papers in this view')).toBeVisible();
    await page.screenshot({
      path: 'test-results/desktop-empty-state.png',
      fullPage: true,
    });
    await page.getByPlaceholder('Search papers, authors, concepts').fill('');

    await page.getByRole('button', { name: 'Review queue' }).click();
    const accept = page.locator('.review-actions .accept').first();
    await expect(accept).toBeVisible();
    await accept.click();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  test('switches universe lenses and focuses fields and bridge-paper memberships', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop universe scenario');
    await waitForWorkspace(page);
    const stage = page.getByTestId('graph-stage');

    await expect(stage).toHaveAttribute('data-lens', 'semantic');
    await expect(stage).toHaveAttribute('data-concepts', 'hidden');
    await page.getByRole('button', { name: 'Time', exact: true }).click();
    await expect(stage).toHaveAttribute('data-lens', 'time');
    await expect(page.getByRole('button', { name: /universe rotation/i })).toBeDisabled();
    await page.getByRole('button', { name: 'Semantic', exact: true }).click();
    await expect(stage).toHaveAttribute('data-lens', 'semantic');

    await page.getByRole('button', { name: 'Show concept layer' }).click();
    await expect(stage).toHaveAttribute('data-concepts', 'visible');
    await expect(page.getByText(`${canonicalConceptCount} concepts`)).toBeVisible();
    await page.getByRole('button', { name: 'Hide concept layer' }).click();
    await expect(stage).toHaveAttribute('data-concepts', 'hidden');

    await page.getByRole('button', { name: 'Library' }).click();
    await page.getByRole('button', { name: 'Diffusion-Based Visuomotor Policies' }).click();
    await expect(stage).toHaveAttribute('data-selected-node', 'cluster:diffusion-policies');
    await expect(
      page.getByRole('heading', { name: 'Diffusion-Based Visuomotor Policies' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Focus selection in universe' }),
    ).toBeEnabled();

    await page.getByRole('button', { name: 'Clear field filter' }).click();
    await page.getByRole('button', { name: 'Close inspector' }).click();
    const search = page.getByPlaceholder('Search papers, authors, concepts');
    await search.fill('Diffusion Policy');
    await page.getByRole('button', { name: /Diffusion Policy \(Chi/ }).click();
    await expect(stage).toHaveAttribute(
      'data-selected-node',
      'paper:chi2023-diffusion-policy',
    );
    await expect(stage).toHaveAttribute('data-membership-rays', '2');
    await expect(
      page.getByRole('heading', { name: 'Diffusion Policy (Chi et al. 2023)' }),
    ).toBeVisible();
    await page.screenshot({
      path: 'test-results/desktop-bridge-paper.png',
      fullPage: true,
    });
  });

  test('switches between 2D paper lineages and the 3D literature universe', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop graph view scenario');
    await waitForWorkspace(page);
    const stage = page.getByTestId('graph-stage');

    await expect(stage).toHaveAttribute('data-view', 'universe');
    await page.getByRole('button', { name: '2D lineage view' }).click();
    await expect(stage).toHaveAttribute('data-view', 'lineages');
    await expect(stage).toHaveAttribute('data-paper-count', String(canonicalPaperCount));
    await expect(stage).toHaveAttribute('data-lane-count', String(canonicalLineageCount));
    await expect(stage).toHaveAttribute('data-edge-count', String(canonicalPaperEdgeCount));
    await expect(page.getByTestId('lineage-paper')).toHaveCount(canonicalPaperCount);
    await expect(page.getByTestId('lineage-lane')).toHaveCount(canonicalLineageCount);
    await page.screenshot({
      path: 'test-results/desktop-lineages.png',
      fullPage: true,
    });

    await page.getByRole('button', { name: '3D universe view' }).click();
    await expect(stage).toHaveAttribute('data-view', 'universe');
    await expect(stage).toHaveAttribute('data-lens', 'semantic');
    await verifyCanvasPixels(page, 'desktop-universe-restored');
  });

  test('exports a cluster and rejects malformed graph imports', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop file workflow');
    await waitForWorkspace(page);

    await page.getByRole('button', { name: 'Library' }).click();
    await page.getByRole('button', { name: 'Diffusion-Based Visuomotor Policies' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export cluster' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('diffusion-policies-notes.md');

    const input = page.locator('.workspace-actions input[type=file]');
    await input.setInputFiles({
      name: 'malformed.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"meta":{}}'),
    });
    await expect(page.getByText(/Could not open graph:/)).toBeVisible();
  });

  test('surfaces revision conflicts without overwriting disk', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop save workflow');
    await page.route('**/api/graph', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'revision conflict', current_revision: 4 }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(canonicalGraph),
        });
      }
    });
    await waitForWorkspace(page);
    await page.getByRole('button', { name: 'Review queue' }).click();
    await page.locator('.review-actions .accept').first().click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/changed on disk \(revision 4\)/)).toBeVisible();
  });

  test('supports keyboard inspection and persists relationship edits across reload', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop persistence workflow');
    let persisted = structuredClone(canonicalGraph);
    await page.route('**/api/graph', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as {
          graph: typeof canonicalGraph;
        };
        persisted = body.graph;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(persisted),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(persisted),
      });
    });

    await waitForWorkspace(page);
    await page.getByTestId('graph-stage').focus();
    await page.getByTestId('graph-stage').press('ArrowRight');
    await expect(page.getByLabel('Graph inspector')).toBeVisible();
    await page.getByRole('button', { name: 'Close inspector' }).click();

    const search = page.getByPlaceholder('Search papers, authors, concepts');
    await search.fill('Diffusion Policy');
    await page.getByRole('button', { name: /Diffusion Policy \(Chi/ }).click();
    await page.locator('.connection-list > button').first().click();
    await expect(page.getByText('Connection evidence')).toBeVisible();
    await page.getByRole('textbox', { name: 'Relation' }).fill('verified_by_test');
    await page.getByRole('button', { name: 'Apply edits' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Graph saved to disk.')).toBeVisible();

    const editedEdge = persisted.edges.find(
      (edge: { relation: string }) => edge.relation === 'verified_by_test',
    );
    expect(editedEdge?.origin).toBe('user');

    await page.reload();
    await expect(page.getByTestId('graph-stage')).toBeVisible();
    await search.fill('Diffusion Policy');
    await page.getByRole('button', { name: /Diffusion Policy \(Chi/ }).click();
    await page.locator('.connection-list > button').first().click();
    await expect(page.getByRole('textbox', { name: 'Relation' })).toHaveValue(
      'verified_by_test',
    );
  });

  test('provides a usable graph fallback when WebGL is unavailable', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop fallback workflow');
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        contextId: string,
        ...args: unknown[]
      ) {
        if (contextId === 'webgl' || contextId === 'webgl2') return null;
        return original.call(this, contextId as never, ...(args as []));
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    await waitForWorkspace(page);
    await expect(page.getByTestId('graph-fallback')).toBeVisible();
    await expect(page.getByText('WebGL unavailable')).toBeVisible();
    await page.screenshot({
      path: 'test-results/desktop-webgl-fallback.png',
      fullPage: true,
    });
    await page.locator('.fallback-grid button').first().click();
    await expect(page.getByLabel('Graph inspector')).toBeVisible();
  });

  test('exposes local-agent paper and batch workflows', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop agent workflow');
    await waitForWorkspace(page);
    await page.getByRole('button', { name: 'Add paper', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Add a paper or web source' }),
    ).toBeVisible();
    await expect(page.getByLabel('Agent')).toHaveValue('claude');
    await page
      .getByRole('textbox', { name: 'Paper URL' })
      .fill('https://arxiv.org/abs/2303.04137');
    await expect(page.getByRole('button', { name: 'Read & add' })).toBeEnabled();
    await page.getByRole('button', { name: 'Close add paper dialog' }).click();

    await page.getByRole('button', { name: 'Add papers' }).click();
    await expect(page.getByText('50 verified arXiv candidates')).toBeVisible();
    await expect(page.getByText('Claude Code ready')).toBeVisible();
    await page.screenshot({
      path: 'test-results/desktop-import-queue.png',
      fullPage: true,
    });
    const processButton = page.getByRole('button', {
      name: 'Process queue with Claude Code',
    });
    if (!(await processButton.isVisible())) {
      await expect(page.getByRole('button', { name: 'Queue complete' })).toBeDisabled();
      return;
    }
    await processButton.click();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.locator('.queue-status.cancelled').first()).toBeVisible();
  });

  test('fits the mobile viewport without overlap and exposes mobile review flow', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile layout scenario');
    await waitForWorkspace(page);
    await verifyCanvasPixels(page, 'mobile');
    await page.screenshot({
      path: 'test-results/mobile-workspace.png',
      fullPage: true,
    });

    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight);

    await page.getByRole('button', { name: '2D lineage view' }).click();
    await expect(page.getByTestId('graph-stage')).toHaveAttribute('data-view', 'lineages');
    await expect(page.getByTestId('lineage-paper')).toHaveCount(canonicalPaperCount);
    await page.screenshot({
      path: 'test-results/mobile-lineages.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: '3D universe view' }).click();

    await page.getByRole('button', { name: 'Review queue' }).click();
    await expect(page.getByRole('heading', { name: 'Proposal queue' })).toBeVisible();
    const panel = page.locator('.side-panel');
    const box = await panel.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: 'test-results/mobile-review.png',
      fullPage: true,
    });
  });
});
