import { cp, mkdir, access } from 'node:fs/promises';

await mkdir('dist/data/imports', { recursive: true });
await cp('data/graph.json', 'dist/data/graph.json');
await cp('data/graph.js', 'dist/data/graph.js');
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(`node_modules/pdfjs-dist/${folder}`, `dist/pdfjs/${folder}`, {
    recursive: true,
  });
}
if (
  await access('data/imports').then(
    () => true,
    () => false,
  )
) {
  await cp('data/imports', 'dist/data/imports', { recursive: true, force: true });
}
