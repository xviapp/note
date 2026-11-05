import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// `--blog` first runs against the public blog's Worker instead of the app's.
const blog = process.argv[2] === '--blog';
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
    ...process.argv.slice(blog ? 3 : 2),
    '--config',
    blog ? 'wrangler.blog.selfhost.jsonc' : 'wrangler.selfhost.jsonc',
    '--env',
    'production',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
