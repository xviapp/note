import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const state = '.wrangler/e2e/state';
await rm(state, { recursive: true, force: true });
await mkdir('.wrangler/e2e', { recursive: true });
const config = path.resolve('.wrangler/e2e/wrangler.json');
await writeFile(
  config,
  JSON.stringify(
    {
      name: 'xvi-note-e2e',
      main: path.resolve('worker/index.ts'),
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      assets: {
        directory: path.resolve('dist'),
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api/*'],
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'xvi-note-e2e',
          database_id: '00000000-0000-0000-0000-000000000002',
          migrations_dir: path.resolve('migrations'),
        },
      ],
      r2_buckets: [{ binding: 'FILES', bucket_name: 'xvi-note-e2e-files' }],
      vars: { APP_NAME: '页间' },
    },
    null,
    2,
  ),
);
await writeFile(
  '.wrangler/e2e/.dev.vars',
  'APP_SECRET=e2e-test-only-app-secret-never-deploy-0001\nSETUP_TOKEN=e2e-test-only-setup-token-never-deploy-0001\n',
  { mode: 0o600 },
);
const cli = 'node_modules/wrangler/bin/wrangler.js';
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const migration = spawnSync(
  process.execPath,
  [cli, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state, '--config', config],
  { stdio: 'inherit', env },
);
if (migration.status !== 0) process.exit(migration.status || 1);
const child = spawn(
  process.execPath,
  [
    cli,
    'dev',
    '--config',
    config,
    '--port',
    '8799',
    '--ip',
    '127.0.0.1',
    '--inspector-port',
    '9239',
    '--persist-to',
    state,
  ],
  { stdio: 'inherit', env },
);
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
