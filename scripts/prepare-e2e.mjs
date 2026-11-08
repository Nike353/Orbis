import { cp, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const targetArgument = process.argv[2];
if (!targetArgument) {
  throw new Error('Usage: node scripts/prepare-e2e.mjs <temporary-directory>');
}

const target = resolve(targetArgument);
const temporaryRoot = resolve(tmpdir());
if (!isAbsolute(target) || !target.startsWith(`${temporaryRoot}/`)) {
  throw new Error('The E2E workspace must be inside the system temporary directory.');
}

await mkdir(target, { recursive: true });
execFileSync(resolve('.venv/bin/python'), [
  'tests/fixtures/reader_pdf.py',
  `${target}/reader-fixture.pdf`,
]);
execFileSync(resolve('.venv/bin/python'), [
  'tests/fixtures/reader_pdf.py',
  `${target}/reader-citations.pdf`,
  '--citations',
]);
for (const source of ['dist', 'docs', 'prompts', 'tools']) {
  await cp(source, `${target}/${source}`, {
    recursive: true,
    force: true,
  });
}
for (const source of ['data', 'papers']) {
  await cp(`tests/fixtures/library/${source}`, `${target}/${source}`, {
    recursive: true,
    force: true,
  });
}

// The legacy static queue URL must also resolve to synthetic data in browser tests.
await cp(
  'tests/fixtures/library/data/imports/humanoid-loco-manipulation-2026.json',
  `${target}/data/imports/adaptation-appendix-b-051-106.json`,
);
