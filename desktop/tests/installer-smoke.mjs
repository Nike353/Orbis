// Windows only: never install the real app identity or open its profile.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';
import { _electron, expect as playwrightExpect } from '@playwright/test';

if (process.platform !== 'win32') throw new Error('Installer checks require Windows.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expect = playwrightExpect.configure({ timeout: 20000 });
const configuration = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(configuration.build.nsis.perMachine, false);
assert.equal(configuration.build.nsis.allowElevation, false);
assert.equal(configuration.build.nsis.deleteAppDataOnUninstall, false);
await access(
  path.join(root, 'build', 'desktop-backend', 'orbis-server', 'orbis-server.exe'),
);
const scratch = await mkdtemp(path.join(tmpdir(), 'orbis-installer-'));
const guid = randomUUID();
const name = `Orbis Installer Check ${guid.slice(0, 8)}`;
const install = path.join(scratch, 'Installed app & space \u6d4b\u8bd5');
const executable = path.join(install, `${name}.exe`);
const uninstaller = path.join(install, `Uninstall ${name}.exe`);
const evidence = path.join(root, 'build', 'installer-check');
const versions = ['0.0.0-installer.1', '0.0.0-installer.2'];
const env = { ...process.env };
for (const agent of ['CLAUDE', 'CODEX', 'COPILOT'])
  env[`ORBIS_${agent}`] = 'orbis-test-missing-agent';
delete env.ELECTRON_RUN_AS_NODE;
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
// WScript.Shell exposes an ANSI target on some Windows versions.
const shortcutReader = `
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class ShortcutTarget {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  private class ShellLink {}
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path,
                 int length, IntPtr findData, uint flags);
  }
  public static string Read(string file) {
    object link = new ShellLink();
    try {
      ((IPersistFile)link).Load(file, 0);
      var path = new StringBuilder(32768);
      ((IShellLinkW)link).GetPath(path, path.Capacity, IntPtr.Zero, 0);
      return path.ToString();
    } finally { Marshal.FinalReleaseComObject(link); }
  }
}
`;
let profile;
let nativeScratch;
let application;
let installed = false;
let passed = false;
const checks = [];

function powershell(script, expected = 0) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; ${script}`;
  const result = spawnSync(
    path.join(
      process.env.SystemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 180000 },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result.stdout.trim();
}

function productionState() {
  return powershell(`
    $entries = @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' |
      Where-Object { $_.DisplayName -eq 'Orbis' -or $_.DisplayName -like 'Orbis [0-9]*' } |
      Sort-Object PSChildName | Select-Object PSChildName, DisplayVersion, InstallLocation, UninstallString);
    $links = @();
    foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
      $file = Join-Path $folder 'Orbis.lnk';
      if (Test-Path -LiteralPath $file) { $links += (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
    };
    ConvertTo-Json -Depth 4 -Compress -InputObject @{ entries = $entries; links = $links }
  `);
}

const originalState = productionState();

function registration() {
  return JSON.parse(
    powershell(`
    $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}';
    if (-not (Test-Path -LiteralPath $key)) { 'null'; return };
    $entry = Get-ItemProperty -LiteralPath $key;
    $location = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\${guid}').InstallLocation;
    $desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ${quote(name + '.lnk')};
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) ${quote(name + '.lnk')};
    Add-Type -TypeDefinition ${quote(shortcutReader)};
    foreach ($link in @($desktop, $menu)) { if (-not (Test-Path -LiteralPath $link)) { throw "Missing QA shortcut: $link" } };
    ConvertTo-Json -Compress -InputObject @{
      name = $entry.DisplayName; version = $entry.DisplayVersion; location = $location;
      desktop = $desktop; menu = $menu;
      desktopTarget = [ShortcutTarget]::Read($desktop);
      menuTarget = [ShortcutTarget]::Read($menu)
    }
  `),
  );
}

function runSetup(file, uninstall = false, expected = 0, direct = false) {
  // NSIS's temporary uninstaller launcher does not forward the child's exit code.
  const argumentsText = uninstall
    ? `/currentuser /S${direct ? ` _?=${install}` : ''}`
    : `/currentuser /S /D=${install}`;
  powershell(
    `$p = Start-Process -FilePath ${quote(file)} -ArgumentList ${quote(argumentsText)} -Wait -PassThru; exit $p.ExitCode`,
    expected,
  );
}

async function snapshot() {
  const files = {};
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.name !== '.server.lock')
        files[relative] = createHash('sha256')
          .update(await readFile(path.join(directory, entry.name)))
          .digest('hex');
    }
  }
  await visit(path.join(profile, 'Profile', 'Library'));
  return files;
}

async function launch(version) {
  application = await _electron.launch({
    executablePath: executable,
    env: { ...env, ORBIS_USER_DATA: profile },
    chromiumSandbox: true,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  await expect(page.getByTestId('graph-stage')).toBeVisible();
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version);
  await page.getByRole('button', { name: 'Choose graph' }).click();
  const mainGraph = page.getByRole('button', { name: /^Native fixture/ });
  await expect(mainGraph).toBeVisible();
  if (await mainGraph.isEnabled()) await mainGraph.click();
  else await page.getByRole('button', { name: 'Close graph picker' }).click();
  await expect(page.getByTestId('graph-stage')).toBeVisible();
  await page.getByPlaceholder('Search papers, authors, concepts').fill('Reader fixture A');
  await page.getByRole('button', { name: /^Reader fixture A/ }).click();
  await page.getByRole('button', { name: 'Read paper', exact: true }).click();
  const reader = page.getByRole('dialog', { name: /Reader fixture A/ });
  await expect(reader.getByLabel('PDF page', { exact: true })).toHaveValue('3');
  await expect(reader.locator('.pdf-page[data-page="3"]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await reader.getByRole('tab', { name: 'My notes', exact: true }).click();
  await expect(reader.locator('.notes-preview')).toContainText('Native authored notes');
  await expect(reader.getByLabel('Highlight comment')).toHaveValue(
    'Unsent native highlight comment.',
  );
  await reader.getByRole('tab', { name: 'Discuss', exact: true }).click();
  await expect(reader.locator('.research-turn')).toHaveCount(2);
}

async function close() {
  if (!application) return;
  let timer;
  const child = application.process();
  const exited = child.exitCode === null ? once(child, 'close') : Promise.resolve();
  try {
    await Promise.race([
      application.close().then(() => exited),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Installed app did not quit.')), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  application = undefined;
}

async function uninstall() {
  runSetup(uninstaller, true);
  installed = false;
  await expect
    .poll(() => powershell(`Test-Path -LiteralPath ${quote(executable)}`))
    .toBe('False');
  await expect
    .poll(() =>
      powershell(`
        (Test-Path -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}') -or
        (Test-Path -LiteralPath 'HKCU:\\Software\\${guid}')
      `),
    )
    .toBe('False');
  assert.equal(registration(), null);
}

try {
  await mkdir(evidence, { recursive: true });
  console.log(`QA identity: ${name}; isolated files: ${scratch}`);
  const installers = [];
  for (const version of versions) {
    const output = path.join(scratch, version);
    await builder.build({
      projectDir: root,
      targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64),
      publish: 'never',
      config: {
        appId: `org.orbis.research.installcheck.${guid}`,
        productName: name,
        executableName: name,
        compression: 'store',
        directories: { output },
        artifactName: 'installer.exe',
        extraMetadata: { version },
        win: { signExecutable: false },
        nsis: { guid, shortcutName: name, runAfterFinish: false },
      },
    });
    installers.push(path.join(output, 'installer.exe'));
  }
  runSetup(installers[0]);
  installed = true;
  const initial = registration();
  assert.equal(initial.name, `${name} ${versions[0]}`);
  assert.equal(initial.version, versions[0]);
  for (const target of [initial.desktopTarget, initial.menuTarget])
    assert.equal(
      (await realpath(target)).toLowerCase(),
      (await realpath(executable)).toLowerCase(),
    );
  assert.equal(
    (await realpath(initial.location)).toLowerCase(),
    (await realpath(install)).toLowerCase(),
  );
  checks.push('per-user install in Unicode/space path, registration and both shortcuts');
  const output = execFileSync(
    process.execPath,
    [path.join(root, 'desktop', 'tests', 'native-smoke.mjs'), executable],
    {
      cwd: root,
      env: { ...process.env, ORBIS_NATIVE_SMOKE_AGENT: 'copilot' },
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  console.log(output);
  nativeScratch = output
    .match(/Native smoke passed; synthetic artifacts: (.+)/)?.[1]
    ?.trim();
  assert.ok(nativeScratch, 'Native smoke did not report its synthetic profile.');
  nativeScratch = await realpath(nativeScratch);
  assert.equal(
    path.dirname(nativeScratch).toLowerCase(),
    (await realpath(tmpdir())).toLowerCase(),
  );
  assert.ok(path.basename(nativeScratch).startsWith('orbis-native-smoke-'));
  profile = path.join(nativeScratch, 'ProfileHome');
  checks.push(
    'installed native reader, synthetic Copilot discussion/cancellation, saved drafts and reopen',
  );

  await launch(versions[0]);
  runSetup(installers[1], false, 2);
  runSetup(uninstaller, true, 2, true);
  assert.equal(registration().version, versions[0]);
  assert.equal(application.process().exitCode, null);
  await close();
  checks.push('running app blocks upgrade and uninstall without being terminated');

  const beforeUpgrade = await snapshot();
  runSetup(installers[1]);
  assert.equal(registration().version, versions[1]);
  assert.deepEqual(await snapshot(), beforeUpgrade);
  await launch(versions[1]);
  await close();
  checks.push(
    'version upgrade preserves all library bytes and reopens notes, PDF, highlights and history',
  );

  const beforeUninstall = await snapshot();
  const shortcuts = registration();
  await uninstall();
  for (const link of [shortcuts.desktop, shortcuts.menu])
    assert.equal(powershell(`Test-Path -LiteralPath ${quote(link)}`), 'False');
  assert.deepEqual(await snapshot(), beforeUninstall);
  checks.push(
    'uninstall removes application, registry entry and shortcuts but retains library',
  );

  runSetup(installers[1]);
  installed = true;
  assert.deepEqual(await snapshot(), beforeUninstall);
  await launch(versions[1]);
  await close();
  checks.push('reinstall opens the retained library');
  await uninstall();
  assert.deepEqual(
    productionState(),
    originalState,
    'Real Orbis installation or shortcuts changed.',
  );
  await copyFile(path.join(nativeScratch, 'reader.png'), path.join(evidence, 'reader.png'));
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify({ versions, checks, productionUntouched: true }, null, 2),
  );
  passed = true;
  console.log(`Installer checks passed. Results: ${evidence}`);
} finally {
  await close();
  if (installed) await uninstall();
  assert.deepEqual(
    productionState(),
    originalState,
    'Real Orbis installation or shortcuts changed.',
  );
  if (passed) {
    await rm(scratch, { recursive: true });
    await rm(nativeScratch, { recursive: true });
  } else
    console.error(`Installer checks incomplete; isolated evidence retained at ${scratch}`);
}
