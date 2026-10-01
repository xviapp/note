import { spawn } from 'node:child_process';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
async function availablePort(preferred) {
  if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535)
    throw new Error('开发端口必须在 1024 到 65535 之间。');
  for (let port = preferred; port <= Math.min(65535, preferred + 100); port++) {
    const free = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', (error) =>
        error.code === 'EADDRINUSE' ? resolve(false) : reject(error),
      );
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('没有可用的本地开发端口，请通过 NOTE_UI_PORT 或 NOTE_WORKER_PORT 指定。');
}
const uiPort = await availablePort(Number(process.env.NOTE_UI_PORT || 5173));
const workerPort = await availablePort(Number(process.env.NOTE_WORKER_PORT || 8787));
process.env.NOTE_UI_PORT = String(uiPort);
process.env.NOTE_WORKER_PORT = String(workerPort);
await mkdir('.wrangler', { recursive: true });
await writeFile('.wrangler/local-ports.json', JSON.stringify({ uiPort, workerPort }));
await import('./setup.mjs');
await import('./assets.mjs');
await mkdir('dist', { recursive: true });
try {
  await access('dist/index.html');
} catch {
  await writeFile(
    'dist/index.html',
    `<!doctype html><p>开发界面位于 http://127.0.0.1:${uiPort}</p>`,
  );
}
const worker = spawn(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'dev',
    '--port',
    String(workerPort),
    '--ip',
    '127.0.0.1',
  ],
  { stdio: 'inherit' },
);
const ui = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(uiPort),
    '--strictPort',
  ],
  { stdio: 'inherit' },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  worker.kill('SIGTERM');
  ui.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
worker.on('exit', (code) => stop(code || 0));
ui.on('exit', (code) => stop(code || 0));
