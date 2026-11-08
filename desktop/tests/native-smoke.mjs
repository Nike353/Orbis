// Run manually against a packaged executable; uses synthetic data and no provider/Drive.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.argv[2];
if (!executablePath) throw new Error('Pass the packaged Orbis executable as the argument.');
const scratch = await mkdtemp(path.join(tmpdir(), 'orbis-native-smoke-'));
const profile = path.join(scratch, 'ProfileHome');
const fixture = path.join(scratch, 'SourceLibrary');
execFileSync(
  path.join(root, '.venv/bin/python'),
  [
    '-c',
    `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "tests"))
from test_research import graph_fixture
from fixtures.reader_pdf import pdf_bytes, PAGES
from tools.agent_bridge import atomic_write_graph, atomic_write_json
from tools.workspace import initialize_workspace
from tools.documents import DocumentStore
from tools.graph_catalog import GraphCatalog
root = Path(sys.argv[2])
initialize_workspace(root)
child = GraphCatalog(root, Path(sys.argv[1]) / "tools/serve.py").create("Independent fixture")
for folder, title in [(root, "Native fixture"), (root / "graphs" / child["id"], child["name"])]:
    graph = graph_fixture()
    graph["meta"]["title"] = title
    graph["nodes"][1]["label"] = graph["nodes"][1]["paper"]["title"] = "Reader fixture A"
    graph["nodes"][2]["label"] = graph["nodes"][2]["paper"]["title"] = "Reader fixture B"
    graph["nodes"][1]["notes"] = "Imported personal notes: $x^2$."
    graph["edges"] = [{"id": "e1", "source": "paper:a", "target": "paper:b",
        "relation": "supports", "transition_note": "Complete synthetic connection notes.",
        "confidence": 1.0, "evidence": "Full connection evidence must survive import.",
        "status": "accepted", "origin": "user", "created_at": "2026-01-01"}]
    atomic_write_graph(folder, graph)
    (folder / "papers/fixture.md").write_text("# Imported reading note\\n\\nFull source note.")
    documents = DocumentStore(folder)
    doc = documents.attach("paper:a", pdf_bytes(), filename="fixture.pdf")
    documents.annotate({"document_id": doc["id"], "page": 3, "quote": PAGES[2][1],
        "comment": "Imported saved highlight comment."})
    atomic_write_json(folder / "data/research.json", {"schema_version": 1,
        "sessions": [{"id": "fixture-history", "title": "Imported history",
            "scope_ids": ["paper:a"], "criteria": [], "archived": False,
            "created_at": "2026-01-01T00:00:00Z", "turns": []}]})
`,
    root,
    fixture,
  ],
  { cwd: root },
);
const fixtureCommand = `"${path.join(root, '.venv/bin/python')}" "${path.join(root, 'tests/fixtures/research_agent.py')}"`;
const env = {
  ...process.env,
  ORBIS_USER_DATA: profile,
  ORBIS_CODEX: fixtureCommand,
  ORBIS_CLAUDE: fixtureCommand,
  ORBIS_DEFAULT_AGENT: 'codex',
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
async function launch() {
  console.log('Launching isolated packaged app.');
  application = await _electron.launch({
    executablePath,
    // The Linux preview uses software WebGL; macOS should exercise its native GPU.
    args:
      process.platform === 'linux'
        ? [
            '--disable-setuid-sandbox',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--use-angle=swiftshader',
          ]
        : [],
    chromiumSandbox: true,
    env,
    timeout: 45000,
  });
  application.process().stderr.on('data', (data) => process.stderr.write(data));
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(
    page.getByTestId('graph-stage').or(page.locator('.empty-universe')),
  ).toBeVisible();
  console.log('Packaged renderer is ready.');
  return page;
}
async function quit() {
  let timer;
  const child = application.process();
  const exited = child.exitCode === null ? once(child, 'close') : Promise.resolve();
  try {
    await Promise.race([
      application.close().then(() => exited),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native quit did not finish.')), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  application = undefined;
}
async function openReader(page) {
  await page.getByPlaceholder('Search papers, authors, concepts').fill('Reader fixture A');
  await page.getByRole('button', { name: /^Reader fixture A/ }).click();
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  const reader = page.getByRole('dialog', { name: /Reader fixture A/ });
  const currentPage = await reader.getByLabel('PDF page', { exact: true }).inputValue();
  await expect(reader.locator(`.pdf-page[data-page="${currentPage}"]`)).toHaveAttribute(
    'aria-busy',
    'false',
  );
  return reader;
}
try {
  let page = await launch();
  const native = await application.evaluate(({ app, BrowserWindow, safeStorage }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    storage:
      process.platform === 'linux'
        ? safeStorage.getSelectedStorageBackend()
        : process.platform === 'darwin'
          ? 'keychain'
          : 'platform',
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    encryptionRoundTrip:
      safeStorage.decryptString(safeStorage.encryptString('orbis-native-smoke')) ===
      'orbis-native-smoke',
    preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    noSandbox: process.argv.includes('--no-sandbox'),
  }));
  assert.equal(native.packaged, true);
  assert.equal(native.noSandbox, false);
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity'])
    assert.equal(native.preferences[key], true);
  assert.equal(native.preferences.nodeIntegration, false);
  assert.equal(native.encryptionAvailable, true);
  assert.equal(native.encryptionRoundTrip, true);
  assert.notEqual(native.storage, 'basic_text');
  console.log('Native sandbox and secure storage verified.');
  await application.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    dialog.showErrorBox = (title, message) => console.error(title, message);
  }, fixture);
  const mainOrigin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'Choose graph' }).click();
  await page.getByPlaceholder('e.g. World models, Reading list…').fill('Empty secondary');
  await page.getByRole('button', { name: 'Create empty graph' }).click();
  await page.getByRole('button', { name: /Empty secondary.*Open graph/ }).click();
  await expect.poll(() => new URL(page.url()).origin).not.toBe(mainOrigin);
  await expect(
    page.getByRole('heading', { name: 'Your paper universe starts here.' }),
  ).toBeVisible();
  const rejected = await page.evaluate(async () => {
    try {
      await window.orbis.importLibrary();
      return 'unexpected import';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(rejected, /Main graph/);
  console.log('Secondary graph import guard verified.');
  await page.getByRole('button', { name: 'Choose graph' }).click();
  await page.getByRole('button', { name: /My paper universe.*Open graph/ }).click();
  await expect(page).toHaveURL(mainOrigin + '/');
  await page.getByRole('button', { name: 'Google Drive sync settings' }).click();
  await page.getByRole('button', { name: 'Import existing Orbis library' }).click();
  await page.getByRole('button', { name: 'Close sync settings' }).click();
  await expect(page.locator('.graph-stage canvas')).toBeVisible();
  const library = path.join(profile, 'Profile/Library');
  const imported = JSON.parse(
    await readFile(path.join(library, 'data/graph.json'), 'utf8'),
  );
  assert.equal(imported.nodes.length, 3);
  assert.equal(imported.edges[0].evidence, 'Full connection evidence must survive import.');
  assert.equal(
    JSON.parse(await readFile(path.join(library, 'data/graphs.json'), 'utf8')).length,
    1,
  );
  console.log('Originals and two independent graphs imported.');
  await page.getByRole('button', { name: 'Add paper', exact: true }).click();
  await page.getByLabel('Agent', { exact: true }).selectOption('codex');
  await page.getByLabel('Model', { exact: true }).selectOption('gpt-5.5');
  await page.getByLabel('Effort', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Close add paper dialog' }).click();
  await page.getByRole('button', { name: 'Time', exact: true }).click();
  const canvas = page.locator('.graph-stage canvas');
  await canvas.evaluate((element) => element.setAttribute('data-native-retained', 'yes'));
  let reader = await openReader(page);
  await reader.getByLabel('PDF page', { exact: true }).fill('3');
  await expect(reader.locator('.pdf-page[data-page="3"] .textLayer')).toContainText(
    '82 percent accuracy',
  );
  await reader.getByLabel('Keep offline').click();
  await expect(reader.getByLabel('Keep offline')).toBeChecked();
  await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
  await reader
    .getByRole('textbox', { name: 'Your question' })
    .fill('Reader test: Explain the accuracy and baseline.');
  await reader.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(reader.getByText('Original-source excerpts', { exact: true })).toBeVisible();
  await reader
    .getByRole('textbox', { name: 'Your question' })
    .fill('Unsent native discussion draft.');
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await reader.getByRole('button', { name: 'Edit comment', exact: true }).click();
  await reader.getByLabel('Highlight comment').fill('Unsent native highlight comment.');
  const notes = reader.getByRole('region', { name: 'My notes', exact: true });
  await notes.getByRole('button', { name: 'Write', exact: true }).click();
  await notes.getByLabel('My notes', { exact: true }).fill('Native authored notes: $x^2$.');
  await page.screenshot({ path: path.join(scratch, 'reader.png') });
  console.log('Reader and drafts ready for native quit.');
  const firstOrigin = new URL(page.url()).origin;
  await quit();
  page = await launch();
  assert.notEqual(new URL(page.url()).origin, firstOrigin);
  reader = await openReader(page);
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('3');
  await expect(reader.getByLabel('Keep offline')).toBeChecked();
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await expect(reader.locator('.notes-preview')).toContainText('Native authored notes');
  await expect(reader.locator('.notes-preview .katex')).toHaveCount(1);
  await expect(reader.getByLabel('Highlight comment')).toHaveValue(
    'Unsent native highlight comment.',
  );
  await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
  await expect(reader.getByRole('textbox', { name: 'Your question' })).toHaveValue(
    'Unsent native discussion draft.',
  );
  await expect(reader.locator('.research-turn')).toHaveCount(1);
  await expect(reader.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.5');
  await expect(reader.getByLabel('Effort', { exact: true })).toHaveValue('high');
  console.log('Native reopen preserved notes, drafts, page and model settings.');
  await reader.getByRole('button', { name: 'Back to galaxy', exact: true }).click();
  await expect(page.locator('.graph-stage canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Choose graph' }).click();
  const reopenedMainOrigin = new URL(page.url()).origin;
  await page.getByRole('button', { name: /Independent fixture.*Open graph/ }).click();
  await expect.poll(() => new URL(page.url()).origin).not.toBe(reopenedMainOrigin);
  await expect(page.getByTestId('graph-stage')).toBeVisible();
  reader = await openReader(page);
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await expect(reader.locator('.notes-preview')).toContainText('Imported personal notes');
  await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
  await expect(reader.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.5');
  await expect(reader.getByLabel('Effort', { exact: true })).toHaveValue('high');
  await expect(reader.getByRole('textbox', { name: 'Your question' })).toHaveValue('');
  assert.deepEqual(errors, []);
  await quit();
  page = await launch();
  const closed = application.waitForEvent('close', { timeout: 20000 });
  await page.evaluate(() => window.close());
  await closed;
  application = undefined;
  assert.deepEqual(errors, []);
  console.log('Renderer-initiated close exits without a stale-window JavaScript error.');
  await writeFile(
    path.join(scratch, 'result.json'),
    JSON.stringify(
      {
        version: native.version,
        storage: native.storage,
        packaged: true,
        sandbox: true,
        checks: [
          'empty start',
          'secondary import guard',
          'two-graph import with originals and highlights',
          'PDF rendering',
          'discussion',
          'native quit and reopen',
          'renderer-initiated close',
          'notes and drafts',
          'reading position',
          'Keep offline',
          'model/effort across origins and restart',
          'independent graph isolation',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Native smoke passed; synthetic artifacts: ${scratch}`);
} catch (error) {
  console.error('Native smoke failed:', error);
  throw error;
} finally {
  if (application) {
    const timer = setTimeout(() => application.process().kill('SIGKILL'), 5000);
    try {
      await application.close();
    } finally {
      clearTimeout(timer);
    }
  }
}
