import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'public/licenses'), { recursive: true });
for (const name of ['noto-serif-sc', 'noto-sans-sc'])
  await cp(
    path.join(root, `node_modules/@fontsource/${name}/LICENSE`),
    path.join(root, `public/licenses/${name}.txt`),
  );
await mkdir(path.join(root, 'public/pdf'), { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(
    path.join(root, 'node_modules/pdfjs-dist', directory),
    path.join(root, 'public/pdf', directory),
    { recursive: true },
  );
}
