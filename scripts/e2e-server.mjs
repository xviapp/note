import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createServer } from 'node:http';

// A local stand-in for DeepSeek: tests never reach the paid service. Page
// photos read as fixed text, JSON requests get a summary or a reading-note
// section, and chats get a short streamed reply.
const mock = createServer((request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
    return;
  }
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    const body = JSON.parse(raw);
    const system = String(body.messages[0]?.content ?? '');
    const reply = system.includes('书页文字识别')
      ? '作者认为，农业革命让食物增多，却让多数人更辛苦。\n\n与其说人类驯化了小麦，不如说小麦驯化了人类。'
      : system.includes('读书笔记')
        ? JSON.stringify({
            conclusion: '多数人的生活并没有变好。',
            basis: '第 12 页：农民比采集者工作更辛苦。',
            other: '暂无',
            next: '采集社会真的更有闲暇吗？',
          })
        : body.response_format
          ? JSON.stringify({
              summary: '作者质疑农业革命让生活更好的说法。',
              questions: ['为什么说农业革命是骗局？', '小麦如何驯化了人类？'],
            })
          : '先回答：作者是说个体的生活变差了。';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    response.end();
  });
});
mock.listen(8798, '127.0.0.1');

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
      vars: { APP_NAME: '页间', DEEPSEEK_BASE_URL: 'http://127.0.0.1:8798' },
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
process.on('SIGINT', () => {
  mock.close();
  child.kill('SIGINT');
});
process.on('SIGTERM', () => {
  mock.close();
  child.kill('SIGTERM');
});
child.on('exit', (code) => {
  mock.close();
  process.exitCode = code || 0;
});
