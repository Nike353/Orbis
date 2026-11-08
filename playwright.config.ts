import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const e2eRoot =
  process.env.ORBIS_E2E_ROOT ?? join(tmpdir(), `orbis-e2e-${process.pid}-${Date.now()}`);
const repositoryRoot = process.cwd();
const e2eStatePath = `${e2eRoot}/data/imports/e2e-state.json`;
process.env.ORBIS_E2E_ROOT = e2eRoot;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-angle=swiftshader',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command:
      `npm run build && ` +
      `node scripts/prepare-e2e.mjs "${e2eRoot}" && ` +
      `cd "${e2eRoot}" && ` +
      `PATH="${repositoryRoot}/tests/fixtures/bin:$PATH" ` +
      `ORBIS_CLAUDE='bash "${repositoryRoot}/tests/fixtures/bin/claude"' ` +
      `ORBIS_CODEX="${e2eRoot}/not-installed-codex" ` +
      `ORBIS_DEFAULT_AGENT=claude ` +
      `ORBIS_E2E_FIXTURE=1 ORBIS_TEST_PYTHON="${repositoryRoot}/.venv/bin/python" ` +
      `ORBIS_STATE_PATH="${e2eStatePath}" ` +
      `"${repositoryRoot}/.venv/bin/python" tools/serve.py --port 4173`,
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
