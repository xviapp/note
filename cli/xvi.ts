#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { Client, loadCredentials, saveCredentials, serverOrigin } from './client.ts';
import { pull, type PullReport } from './pull.ts';
import { resolveTarget } from './target.ts';
import { Workspace } from './workspace.ts';

const HELP = `页间命令行工具：把笔记同步到本地目录。

用法：
  xvi login <站点>             登录并保存会话
  xvi logout                   退出登录
  xvi pull <条目> [目录]       把条目及其下级拉取到新目录（默认当前目录）
  xvi pull --all [目录]        拉取全部条目
  xvi pull [--dir 目录]        在已同步的目录中再次拉取

<条目> 可以是链接、ID 或从顶层开始的标题路径（如 工作/项目）。

选项：
  --server <站点>   指定站点（也可用 XVI_SERVER）
  --dir <目录>      工作目录
  --pdf             同时下载 PDF
  -h, --help        显示帮助
`;
async function readPassword(): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const lines = createInterface({ input: stdin });
    for await (const line of lines) return line;
    throw new Error('没有读取到密码。');
  }
  stdout.write('密码：');
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const prompt = createInterface({ input: stdin, output: silent, terminal: true });
  try {
    return await prompt.question('');
  } finally {
    prompt.close();
    stdout.write('\n');
  }
}
function printList(title: string, paths: string[]): void {
  if (!paths.length) return;
  console.log(`${title}：`);
  for (const path of paths.sort()) console.log(`  ${path}`);
}
function printReport(report: PullReport): void {
  console.log(
    `新增 ${report.added.length}，更新 ${report.updated.length}，移除 ${report.removed.length}，未变 ${report.unchanged}。`,
  );
  printList('本地有改动，已保留', report.edited);
  printList('本地和远端都有改动，未覆盖本地（删除本地文件后再拉取可取回远端版本）', report.conflicts);
  printList('远端已移除或移动，因本地有改动而保留', report.kept);
  printList('目标位置已有其他文件，未写入', report.blocked);
  const skipped = [
    report.encrypted && `${report.encrypted} 个加密条目`,
    report.references && `${report.references} 个项目引用`,
    report.omittedPdfs && `${report.omittedPdfs} 个 PDF（加 --pdf 可下载）`,
  ].filter(Boolean);
  if (skipped.length) console.log(`已跳过 ${skipped.join('、')}。`);
  if (report.failed.length) {
    console.error('以下条目拉取失败，可稍后重试：');
    for (const { path, message } of report.failed) console.error(`  ${path}：${message}`);
    process.exitCode = 1;
  }
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      pdf: { type: 'boolean', default: false },
      server: { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const credentials = await loadCredentials();
  const named = values.server ?? process.env.XVI_SERVER;
  if (command === 'login') {
    const value = rest[0] ?? named ?? credentials.default;
    if (!value) throw new Error('请指定站点，例如 xvi login https://note.example.com');
    const server = serverOrigin(value);
    const client = new Client(server, null);
    await client.login(await readPassword());
    credentials.sessions[server] = client.session!;
    credentials.default = server;
    await saveCredentials(credentials);
    console.log(`已登录 ${server}。`);
    return;
  }
  if (command === 'logout') {
    const value = rest[0] ?? named ?? credentials.default;
    const server = value ? serverOrigin(value) : null;
    if (!server || !credentials.sessions[server]) {
      console.log('当前没有登录。');
      return;
    }
    await new Client(server, credentials.sessions[server]).logout();
    delete credentials.sessions[server];
    if (credentials.default === server) delete credentials.default;
    await saveCredentials(credentials);
    console.log(`已退出 ${server}。`);
    return;
  }
  if (command === 'pull') {
    if (rest.length > 2) throw new Error('参数过多，请查看 xvi --help。');
    let target = rest[0] as string | undefined,
      dirArgument = rest[1] ?? values.dir;
    if (values.all && rest.length > 1) throw new Error('--all 不需要指定条目。');
    if (values.all) [target, dirArgument] = [undefined, rest[0] ?? values.dir];
    const dir = resolve(dirArgument ?? '.');
    const saved = await new Workspace(dir).loadState();
    if (!target && !values.all && !saved)
      throw new Error('这个目录还没有同步过。请指定条目，或用 --all 拉取全部。');
    const value = named ?? saved?.server ?? credentials.default;
    if (!value) throw new Error('请先运行 xvi login <站点>。');
    const server = serverOrigin(value);
    const session = credentials.sessions[server];
    if (!session) throw new Error(`还没有登录 ${server}，请先运行 xvi login。`);
    const client = new Client(server, session);
    const root = target
      ? await resolveTarget(client, target)
      : values.all
        ? null
        : (saved!.root ?? null);
    const { report } = await pull({ client, dir, root, pdf: values.pdf });
    printReport(report);
    return;
  }
  throw new Error(`未知命令：${command}。请查看 xvi --help。`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
