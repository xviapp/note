import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2),
  remote = args.includes('--remote');
if (args.includes('--help')) {
  console.log(
    '本地：npm run reset-password -- --local\n远端：npm run reset-password -- --remote --url https://你的站点\n保留所有笔记，撤销所有会话，并生成新的单次密码设置链接。',
  );
  process.exit(0);
}
if (!remote && !args.includes('--local')) throw new Error('请明确指定 --local 或 --remote。');
if (remote && args.includes('--local')) throw new Error('--local 和 --remote 只能选择一个。');
const urlArg = args[args.indexOf('--url') + 1];
if (remote && (!args.includes('--url') || !urlArg?.startsWith('https://')))
  throw new Error('远端重置需要 --url https://你的站点。');
let localPort = 5173;
try {
  localPort = JSON.parse(await readFile('.wrangler/local-ports.json', 'utf8')).uiPort || localPort;
} catch {
  /* No previous local launch. */
}
const siteUrl = remote ? new URL(urlArg).origin : `http://127.0.0.1:${localPort}`;
const token = randomBytes(32).toString('base64url'),
  directory = await mkdtemp(path.join(tmpdir(), 'note-reset-'));
const wrangler = (parameters, input) => {
  const result = spawnSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', ...parameters],
    { input, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit' },
  );
  if (result.status !== 0)
    throw new Error('重置尚未完成。站点保持锁定，修复上述错误后重新运行即可。');
};
const execute = async (sql) => {
  const file = path.join(directory, 'reset.sql');
  await writeFile(file, sql, { mode: 0o600 });
  wrangler(['d1', 'execute', 'DB', remote ? '--remote' : '--local', '--file', file, '--yes']);
};
try {
  // Fail closed: the old setup link must not become usable between revocation
  // and secret rotation, even if the secret update or final SQL fails.
  await execute(
    "UPDATE site SET password_hash='!reset-in-progress', password_salt=NULL, auth_epoch=auth_epoch+1 WHERE id=1;\nDELETE FROM sessions;\nDELETE FROM login_attempts;",
  );
  if (remote) wrangler(['secret', 'put', 'SETUP_TOKEN'], token + '\n');
  else {
    let variables = await readFile('.dev.vars', 'utf8');
    variables = /^SETUP_TOKEN=/m.test(variables)
      ? variables.replace(/^SETUP_TOKEN=.*$/m, `SETUP_TOKEN=${token}`)
      : `${variables}\nSETUP_TOKEN=${token}\n`;
    await writeFile('.dev.vars', variables, { mode: 0o600 });
    await chmod('.dev.vars', 0o600);
  }
  await execute(
    'UPDATE site SET password_hash=NULL, password_salt=NULL, initialized_at=NULL WHERE id=1;',
  );
  console.log(
    `\n旧会话已全部撤销，笔记和文件已保留。${remote ? '' : '请重新启动本地开发服务。'}\n用此专属链接设置新密码：\n${siteUrl}/#setup=${token}\n请勿公开此链接。`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
