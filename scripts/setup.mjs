import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
let existing = '';
try {
  existing = await readFile('.dev.vars', 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const secret = () => randomBytes(32).toString('base64url');
if (!/^APP_SECRET=/m.test(existing)) existing += `\nAPP_SECRET=${secret()}\n`;
if (!/^SETUP_TOKEN=/m.test(existing)) existing += `\nSETUP_TOKEN=${secret()}\n`;
await writeFile('.dev.vars', existing.trim() + '\n', { mode: 0o600 });
await chmod('.dev.vars', 0o600);
const result = spawnSync(
  process.execPath,
  ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local'],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status || 1);
const token = existing.match(/^SETUP_TOKEN=["']?([^\s"']+)/m)?.[1];
let uiPort = 5173;
try {
  uiPort = JSON.parse(await readFile('.wrangler/local-ports.json', 'utf8')).uiPort || uiPort;
} catch {
  /* First startup uses the default port. */
}
uiPort = Number(process.env.NOTE_UI_PORT || uiPort);
console.log(
  `\n本地配置完成。运行 npm run dev，然后打开：\nhttp://127.0.0.1:${uiPort}/#setup=${token}\n\n此链接仅用于首次设置密码，请勿公开。已有密码时会直接显示登录页。`,
);
