#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { hostname } from 'node:os';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findChanges, type Changes } from './changes.ts';
import { Client, loadCredentials, saveCredentials, serverOrigin, type Credentials } from './client.ts';
import { Progress } from './progress.ts';
import { canConfirm, confirm, readSecret } from './prompt.ts';
import { pull, workspaceKeyring, type PullReport } from './pull.ts';
import { Pusher, resolveConflict, type PushReport } from './push.ts';
import { noteDiff, remoteChanges } from './review.ts';
import { resolveTarget } from './target.ts';
import { findWorkspace, Workspace, type State } from './workspace.ts';

const HELP = `页间命令行工具：把笔记同步到本地目录，改完再写回。

用法：
  xvi login <站点> [--read-only]    登录并保存令牌；--read-only 只能拉取
  xvi logout                        撤销令牌
  xvi pull <条目> [目录]            把条目及其下级拉取到新目录（默认当前目录）
  xvi pull --all [目录]             拉取全部条目
  xvi pull                          在已同步的目录中再次拉取
  xvi status [--diff]               查看本地和远端的变化
  xvi push [--delete] [--yes]       确认后写回本地修改；--delete 才写回删除
  xvi push --dry-run                只显示将写回的内容
  xvi resolve <文件>                合并完冲突后标记为已解决

<条目> 可以是链接、ID 或从顶层开始的标题路径（如 工作/项目）。

选项：
  --server <站点>   指定站点（也可用 XVI_SERVER）
  --dir <目录>      工作目录
  --pdf             同时下载 PDF
  --decrypt         同时拉取加密条目，并以明文保存在目录中
  -h, --help        显示帮助
`;
const progress = new Progress();
const ask = (label: string) => progress.during(() => readSecret(label));
function printList(title: string, items: string[]): void {
  if (!items.length) return;
  console.log(`${title}：`);
  for (const item of [...items].sort()) console.log(`  ${item}`);
}
function printFailures(failed: { path: string; message: string }[]): void {
  if (!failed.length) return;
  console.error('以下条目失败，可稍后重试：');
  for (const { path, message } of failed) console.error(`  ${path}：${message}`);
  process.exitCode = 1;
}
function printPullReport(report: PullReport): void {
  console.log(
    `新增 ${report.added.length}，更新 ${report.updated.length}，移动 ${report.moved.length}，移除 ${report.removed.length}，未变 ${report.unchanged}。`,
  );
  printList('本地有改动，已保留', report.edited);
  printList('本地和远端都有改动，远端版本存为 .remote 文件（合并后运行 xvi resolve）', report.conflicts);
  printList('远端已移除或移动，因本地有改动而保留', report.kept);
  printList('目标位置已有其他文件，未写入', report.blocked);
  printList('本地已移动但还没写回，未更新（先运行 xvi push）', report.movedLocally);
  const skipped = [
    report.locked && `${report.locked} 个未解锁的加密条目（本地副本保持原样）`,
    report.encrypted && `${report.encrypted} 个加密条目`,
    report.references && `${report.references} 个项目引用`,
    report.omittedPdfs && `${report.omittedPdfs} 个 PDF（加 --pdf 可下载）`,
  ].filter(Boolean);
  if (skipped.length) console.log(`已跳过 ${skipped.join('、')}。`);
  printFailures(report.failed);
}
function printChanges(changes: Changes, state: State, deleting: boolean): void {
  printList('修改', changes.edits);
  printList('新建', changes.creates);
  printList('移动或改名', changes.moves.filter((move) => !move.carried).map(({ from, to }) => `${from} → ${to}`));
  const deletes = changes.deletes.map(
    ({ id, count }) => `${state.entries[id].path}${count > 1 ? `（连同下级共 ${count} 个）` : ''}`,
  );
  printList(deleting ? '移入回收站' : '本地已删除，未写回（加 --delete 才写回，否则下次拉取时恢复）', deletes);
  printList('有未解决的冲突（合并后运行 xvi resolve）', changes.conflicts);
  printList('只读类型，不会写回', changes.readOnly);
  printList('不是笔记文件，不会写回', changes.ignored);
  printList('无法写回', changes.blocked.map(({ path, reason }) => `${path}：${reason}`));
}
const hasWork = (changes: Changes, deleting: boolean) =>
  changes.edits.length ||
  changes.creates.length ||
  changes.moves.length ||
  (deleting && changes.deletes.length);
function printPushReport(report: PushReport): void {
  printList('已写回', report.saved);
  printList('已新建', report.created);
  printList('已移动或改名', report.moved);
  printList('已移入回收站', report.trashed);
  for (const warning of report.warnings) console.log(warning);
  if (report.conflicts.length) {
    printList('远端也有改动，未写回（合并 .remote 文件后运行 xvi resolve）', report.conflicts);
    process.exitCode = 1;
  }
  printFailures(report.failed);
}
function clientFor(credentials: Credentials, value: string | undefined): Client {
  if (!value) throw new Error('请先运行 xvi login <站点>。');
  const server = serverOrigin(value);
  const client = new Client(server, credentials.tokens[server] ?? null);
  client.session = credentials.sessions?.[server] ?? null;
  if (!client.token && !client.session) throw new Error(`还没有登录 ${server}，请先运行 xvi login。`);
  return client;
}
async function openWorkspace(dir: string | undefined): Promise<{ workspace: Workspace; state: State }> {
  const workspace = await findWorkspace(resolve(dir ?? '.'));
  const state = await workspace?.loadState();
  if (!workspace || !state) throw new Error('这里不是同步目录，请先运行 xvi pull。');
  return { workspace, state };
}
async function showDiffs(client: Client, workspace: Workspace, state: State, changes: Changes) {
  const keyring = workspaceKeyring(client, state, ask);
  for (const [index, path] of changes.edits.entries()) {
    const id = Object.keys(state.entries).find((key) => state.entries[key].path === path)!;
    progress.update(`比较差异 ${index + 1}/${changes.edits.length}：${path}`);
    const diff = await noteDiff(client, workspace, state, keyring, id);
    progress.clear();
    if (diff === null) {
      console.log('未找到 git，无法显示差异。');
      return;
    }
    process.stdout.write(diff);
  }
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      decrypt: { type: 'boolean', default: false },
      delete: { type: 'boolean', default: false },
      diff: { type: 'boolean', default: false },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      pdf: { type: 'boolean', default: false },
      'read-only': { type: 'boolean', default: false },
      server: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
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
    const password = await readSecret('密码：');
    if (!password) throw new Error('没有读取到密码。');
    await client.login(password, hostname(), values['read-only'] ? 'read' : 'write');
    credentials.tokens[server] = client.token!;
    credentials.default = server;
    // The session an earlier version saved has no further use.
    const old = credentials.sessions?.[server];
    if (old) {
      const previous = new Client(server, null);
      previous.session = old;
      await previous.logout().catch(() => {});
      delete credentials.sessions![server];
    }
    await saveCredentials(credentials);
    console.log(`已登录 ${server}${values['read-only'] ? '（只读）' : ''}。`);
    return;
  }
  if (command === 'logout') {
    const value = rest[0] ?? named ?? credentials.default;
    const server = value ? serverOrigin(value) : null;
    if (!server || (!credentials.tokens[server] && !credentials.sessions?.[server])) {
      console.log('当前没有登录。');
      return;
    }
    await clientFor(credentials, server).logout();
    delete credentials.tokens[server];
    delete credentials.sessions?.[server];
    if (credentials.default === server) delete credentials.default;
    await saveCredentials(credentials);
    console.log(`已退出 ${server}。`);
    return;
  }
  if (command === 'pull') {
    if (rest.length > 2) throw new Error('参数过多，请查看 xvi --help。');
    if (values.all && rest.length > 1) throw new Error('--all 不需要指定条目。');
    const target = values.all ? undefined : rest[0];
    const dirArgument = values.dir ?? (values.all ? rest[0] : rest[1]);
    const found = target || values.all ? null : await findWorkspace(resolve(dirArgument ?? '.'));
    const dir = found?.root ?? resolve(dirArgument ?? '.');
    const saved = await new Workspace(dir).loadState();
    if (!target && !values.all && !saved)
      throw new Error('这个目录还没有同步过。请指定条目，或用 --all 拉取全部。');
    const client = clientFor(credentials, named ?? saved?.server ?? credentials.default);
    const root = target
      ? await resolveTarget(client, target)
      : values.all
        ? null
        : (saved!.root ?? null);
    if (values.decrypt && !saved?.decrypt)
      console.log('解密后的内容会以明文保存在目录中，在其中运行的工具也会读取并发给模型服务商。');
    const { report } = await pull({ client, dir, root, pdf: values.pdf, decrypt: values.decrypt, ask, onProgress: progress.update });
    progress.clear();
    printPullReport(report);
    return;
  }
  if (command === 'status') {
    const { workspace, state } = await openWorkspace(values.dir);
    const changes = await findChanges(workspace, state);
    printChanges(changes, state, false);
    const client = clientFor(credentials, named ?? state.server);
    const remote = await remoteChanges(client, state, progress.update).catch((error: unknown) => {
      progress.clear();
      console.log(`无法检查远端：${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    progress.clear();
    printList('远端有变化（运行 xvi pull 同步）', remote);
    if (!hasWork(changes, true) && !remote.length && !changes.conflicts.length) console.log('没有变化。');
    if (values.diff) await showDiffs(client, workspace, state, changes);
    return;
  }
  if (command === 'push') {
    const { workspace, state } = await openWorkspace(values.dir);
    if (Object.values(state.entries).some((entry) => entry.parent === undefined))
      throw new Error('这个目录由旧版本同步，请先运行 xvi pull。');
    const changes = await findChanges(workspace, state);
    printChanges(changes, state, values.delete);
    if (!hasWork(changes, values.delete)) {
      console.log('没有可写回的内容。');
      return;
    }
    const client = clientFor(credentials, named ?? state.server);
    if (!values.yes || values['dry-run']) await showDiffs(client, workspace, state, changes);
    if (values['dry-run']) return;
    if (!values.yes) {
      if (!canConfirm()) throw new Error('需要确认才能写回：请在终端中运行，或加 --yes。');
      if (!(await confirm('确认写回？[y/N] '))) {
        console.log('已取消。');
        return;
      }
    }
    const keyring = workspaceKeyring(client, state, ask);
    const pusher = new Pusher(client, workspace, state, changes, keyring, progress.update);
    try {
      const report = await pusher.run({ deletes: values.delete });
      progress.clear();
      printPushReport(report);
    } finally {
      await workspace.saveState(state);
      await workspace.clearTemporary();
    }
    return;
  }
  if (command === 'resolve') {
    if (rest.length !== 1) throw new Error('请指定要标记的文件，例如 xvi resolve 笔记.md');
    const { workspace, state } = await openWorkspace(values.dir);
    const path = relative(workspace.root, resolve(rest[0])).replaceAll('\\', '/');
    await resolveConflict(workspace, state, path);
    console.log(`已解决 ${path}，运行 xvi push 写回。`);
    return;
  }
  throw new Error(`未知命令：${command}。请查看 xvi --help。`);
}
main().catch((error: unknown) => {
  progress.clear();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
