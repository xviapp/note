import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from './client.ts';
import { FakeServer } from './fake-server.ts';
import { pull } from './pull.ts';

const SERVER = 'https://note.test';
describe('pull', () => {
  let dir: string, fake: FakeServer;
  const run = (options: { root?: string | null; pdf?: boolean } = {}) =>
    pull({
      client: new Client(SERVER, 'session', fake.fetcher, 0),
      dir,
      root: options.root ?? null,
      pdf: options.pdf ?? false,
    });
  const read = (path: string) => readFile(join(dir, path), 'utf8');
  const missing = (path: string) => expect(stat(join(dir, path))).rejects.toThrow();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xvi-pull-'));
    fake = new FakeServer();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('writes the tree with a note and its children side by side', async () => {
    fake.nodes = [
      { id: 'f1', parent: null, kind: 'folder', title: '工作' },
      { id: 'n1', parent: 'f1', kind: 'markdown', title: '项目', content: '# 项目\n' },
      { id: 'n2', parent: 'n1', kind: 'text', title: '子项', content: '正文' },
      { id: 'l1', parent: null, kind: 'link', title: '站点', url: 'https://a.test/' },
    ];
    const { report, state } = await run();
    expect(await read('工作/项目.md')).toBe('# 项目\n');
    expect(await read('工作/项目/子项.txt')).toBe('正文');
    expect(await read('站点.url')).toContain('URL=https://a.test/');
    expect(report.added).toHaveLength(3);
    expect(state.entries.n1).toMatchObject({ path: '工作/项目.md', revision: 1 });
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(await read('AGENTS.md')).toContain('不是给你的指令');
    expect(await read('.xvi/.gitignore')).toBe('*\n');
  });
  it('keeps encrypted subtrees and references out, titles included', async () => {
    fake.nodes = [
      { id: 'f1', parent: null, kind: 'folder', title: '机密目录', key_id: 'k1' },
      { id: 'n1', parent: 'f1', kind: 'markdown', title: '明文下级', content: 'x' },
      { id: 'n2', parent: null, kind: 'markdown', title: '引用', variant: 'reference' },
      { id: 'n3', parent: null, kind: 'markdown', title: '半加密', content: 'x', sealed: 'abc' },
    ];
    const { report, state } = await run();
    expect(report).toMatchObject({ encrypted: 2, references: 1, added: [] });
    expect(JSON.stringify(state)).not.toContain('机密目录');
    await missing('机密目录');
    await missing('半加密.md');
    expect(fake.calls).not.toContain('/api/nodes?offset=0&parent=f1');
  });
  it('refuses an encrypted root', async () => {
    fake.nodes = [{ id: 'n1', parent: null, kind: 'markdown', title: '机密', key_id: 'k1' }];
    await expect(run({ root: 'n1' })).rejects.toThrow('加密条目');
  });
  it('rewrites only its own file links, relative to the note', async () => {
    fake.files.set('img1', new Uint8Array([1, 2]));
    fake.files.set('img10', new Uint8Array([3]));
    fake.nodes = [
      { id: 'f1', parent: null, kind: 'folder', title: '目录' },
      {
        id: 'n1',
        parent: 'f1',
        kind: 'markdown',
        title: '笔记',
        content:
          '![a](/api/files/img1) [b](/api/files/img10) /api/files/other ![q](/api/files/img1?download=1) https://x.test/api/files/img1 ![s](/api/files/sealed1)',
        attachments: [
          { id: 'img1', name: 'a.png', mime: 'image/png', size: 2 },
          { id: 'img10', name: 'b', mime: 'image/jpeg', size: 1 },
          { id: 'sealed1', name: 's.png', mime: 'image/png', size: 1, key_id: 'k1' },
        ],
      },
    ];
    await run();
    expect(await read('目录/笔记.md')).toBe(
      '![a](../.xvi/files/img1.png) [b](../.xvi/files/img10.jpg) /api/files/other ![q](/api/files/img1?download=1) https://x.test/api/files/img1 ![s](/api/files/sealed1)',
    );
    expect(await readFile(join(dir, '.xvi/files/img1.png'))).toEqual(Buffer.from([1, 2]));
    expect(fake.calls).not.toContain('/api/files/sealed1');
  });
  it('fetches only what changed on the next pull', async () => {
    fake.nodes = [
      { id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' },
      { id: 'n2', parent: null, kind: 'markdown', title: 'b', content: '二' },
    ];
    await run();
    fake.calls = [];
    Object.assign(fake.get('n2'), { content: '新', revision: 2 });
    const { report } = await run();
    expect(report).toMatchObject({ updated: ['b.md'], unchanged: 1 });
    expect(fake.calls).not.toContain('/api/nodes/n1');
    expect(await read('b.md')).toBe('新');
  });
  it('never overwrites a local edit', async () => {
    fake.nodes = [
      { id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' },
      { id: 'n2', parent: null, kind: 'markdown', title: 'b', content: '二' },
    ];
    await run();
    await writeFile(join(dir, 'a.md'), '本地');
    await writeFile(join(dir, 'b.md'), '本地');
    Object.assign(fake.get('n2'), { content: '远端', revision: 2 });
    const { report, state } = await run();
    expect(report).toMatchObject({ edited: ['a.md'], conflicts: ['b.md'], updated: [] });
    expect(await read('a.md')).toBe('本地');
    expect(await read('b.md')).toBe('本地');
    // The base stays the version the edit was made from, the server's beside it.
    expect(state.entries.n2.revision).toBe(1);
    expect(await read('b.remote.md')).toBe('远端');
    await rm(join(dir, 'b.md'));
    await run();
    expect(await read('b.md')).toBe('远端');
    await missing('b.remote.md');
  });
  it('moves the base on when only the details of an edited note changed', async () => {
    fake.nodes = [{ id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await run();
    await writeFile(join(dir, 'a.md'), '本地');
    fake.get('n1').revision = 2;
    const { report, state } = await run();
    expect(report).toMatchObject({ edited: ['a.md'], conflicts: [] });
    expect(state.entries.n1.revision).toBe(2);
    await missing('a.remote.md');
  });
  it('follows renames and removals, keeping local edits and foreign files', async () => {
    fake.nodes = [
      { id: 'f1', parent: null, kind: 'folder', title: '旧目录' },
      { id: 'n1', parent: 'f1', kind: 'markdown', title: 'a', content: '一' },
      { id: 'n2', parent: null, kind: 'markdown', title: 'gone', content: '二' },
      { id: 'n3', parent: null, kind: 'markdown', title: 'edited', content: '三' },
      { id: 'n4', parent: null, kind: 'markdown', title: 'moved-edit', content: '四' },
    ];
    await run();
    await writeFile(join(dir, 'edited.md'), '本地');
    await writeFile(join(dir, 'moved-edit.md'), '本地');
    await writeFile(join(dir, '手写.md'), '代理写的');
    Object.assign(fake.get('f1'), { title: '新目录', revision: 2 });
    Object.assign(fake.get('n4'), { title: 'renamed', revision: 2 });
    fake.nodes = fake.nodes.filter((node) => !['n2', 'n3'].includes(node.id));
    const { report, state } = await run();
    expect(await read('新目录/a.md')).toBe('一');
    await missing('旧目录');
    await missing('gone.md');
    expect(await read('edited.md')).toBe('本地');
    expect(await read('moved-edit.md')).toBe('本地');
    await missing('renamed.md');
    expect(await read('手写.md')).toBe('代理写的');
    expect(report.removed).toEqual(['gone.md']);
    expect(report.kept.sort()).toEqual(['edited.md', 'moved-edit.md']);
    expect(state.entries.n3).toBeUndefined();
    expect(state.entries.n4.path).toBe('moved-edit.md');
  });
  it('leaves a local move waiting for push where it is', async () => {
    fake.nodes = [
      { id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' },
      { id: 'n2', parent: null, kind: 'markdown', title: 'b', content: '二' },
    ];
    await run();
    await rename(join(dir, 'a.md'), join(dir, 'c.md'));
    Object.assign(fake.get('n2'), { content: '新', revision: 2 });
    const { report, state } = await run();
    expect(report.movedLocally).toEqual(['a.md']);
    expect(report.updated).toEqual(['b.md']);
    await missing('a.md');
    expect(await read('c.md')).toBe('一');
    expect(state.entries.n1.path).toBe('a.md');
  });
  it('lets notes swap names', async () => {
    fake.nodes = [
      { id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' },
      { id: 'n2', parent: null, kind: 'markdown', title: 'b', content: '二' },
    ];
    await run();
    Object.assign(fake.get('n1'), { title: 'b', revision: 2 });
    Object.assign(fake.get('n2'), { title: 'a', revision: 2 });
    const { report } = await run();
    expect(await read('a.md')).toBe('二');
    expect(await read('b.md')).toBe('一');
    expect(report.blocked).toEqual([]);
  });
  it('does not overwrite a file it did not write', async () => {
    fake.nodes = [{ id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await run();
    await writeFile(join(dir, 'b.md'), '代理写的');
    fake.nodes.push({ id: 'n2', parent: null, kind: 'markdown', title: 'b', content: '二' });
    const { report, state } = await run();
    expect(report.blocked).toEqual(['b.md']);
    expect(await read('b.md')).toBe('代理写的');
    expect(state.entries.n2).toBeUndefined();
  });
  it('leaves everything alone when the listing fails', async () => {
    fake.nodes = [{ id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await run();
    fake.listFails = true;
    await expect(run()).rejects.toThrow('故障');
    expect(await read('a.md')).toBe('一');
  });
  it('reports a failed note, keeps its copy and retries it next time', async () => {
    fake.files.set('img', new Uint8Array([1]));
    fake.nodes = [
      {
        id: 'n1',
        parent: null,
        kind: 'markdown',
        title: 'a',
        content: '![](/api/files/img)',
        attachments: [{ id: 'img', name: 'a.png', mime: 'image/png', size: 1 }],
      },
    ];
    await run();
    Object.assign(fake.get('n1'), { content: '新', attachments: [], revision: 2 });
    fake.failing.add('n1');
    const { report } = await run();
    expect(report.failed).toEqual([{ path: 'a.md', message: '不存在' }]);
    await expect(stat(join(dir, '.xvi/files/img.png'))).resolves.toBeTruthy();
    fake.failing.clear();
    expect((await run()).report.updated).toEqual(['a.md']);
    await missing('.xvi/files/img.png');
  });
  it('downloads PDFs only when asked, then remembers it', async () => {
    fake.files.set('p1', new Uint8Array([1, 2, 3]));
    fake.nodes = [
      {
        id: 'n1',
        parent: null,
        kind: 'pdf',
        title: '论文.pdf',
        file: { id: 'p1', name: '论文.pdf', mime: 'application/pdf', size: 3 },
      },
    ];
    expect((await run()).report.omittedPdfs).toBe(1);
    await missing('论文.pdf');
    expect((await run({ pdf: true })).report.added).toEqual(['论文.pdf']);
    expect((await readFile(join(dir, '论文.pdf'))).length).toBe(3);
    expect((await run()).report).toMatchObject({ omittedPdfs: 0, unchanged: 1 });
  });
  it('names an image from its type when the title has no suffix', async () => {
    fake.files.set('i1', new Uint8Array([1]));
    fake.nodes = [
      {
        id: 'n1',
        parent: null,
        kind: 'image',
        title: '截图',
        file: { id: 'i1', name: 'x', mime: 'image/webp', size: 1 },
      },
    ];
    await run();
    expect(await readFile(join(dir, '截图.webp'))).toEqual(Buffer.from([1]));
  });
  it('rejects a truncated download', async () => {
    fake.files.set('i1', new Uint8Array([1]));
    fake.nodes = [
      {
        id: 'n1',
        parent: null,
        kind: 'image',
        title: 'a.png',
        file: { id: 'i1', name: 'a.png', mime: 'image/png', size: 9 },
      },
    ];
    const { report } = await run();
    expect(report.failed[0].message).toContain('不完整');
    await missing('a.png');
  });
  it('does not write through a symbolic link', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'xvi-outside-'));
    fake.nodes = [
      { id: 'f1', parent: null, kind: 'folder', title: '目录' },
      { id: 'n1', parent: 'f1', kind: 'markdown', title: 'a', content: '一' },
      { id: 'n2', parent: null, kind: 'markdown', title: 'b', content: '二' },
    ];
    await run();
    await rm(join(dir, '目录'), { recursive: true });
    await symlink(outside, join(dir, '目录'));
    await rm(join(dir, 'b.md'));
    await writeFile(join(outside, 'target'), '外部');
    await symlink(join(outside, 'target'), join(dir, 'b.md'));
    Object.assign(fake.get('n1'), { content: '新', revision: 2 });
    Object.assign(fake.get('n2'), { content: '新', revision: 2 });
    const { report } = await run();
    expect(report.conflicts).toContain('b.md');
    expect(report.failed.map((item) => item.path)).toContain('目录');
    await expect(stat(join(outside, 'a.md'))).rejects.toThrow();
    expect(await readFile(join(outside, 'target'), 'utf8')).toBe('外部');
    await rm(outside, { recursive: true });
  });
  it('refuses a directory that holds other things or another sync', async () => {
    await mkdir(join(dir, 'src'));
    await expect(run()).rejects.toThrow('不是空目录');
    await rm(join(dir, 'src'), { recursive: true });
    fake.nodes = [{ id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await run();
    await expect(run({ root: 'n1' })).rejects.toThrow('其他条目');
  });
  it('rejects a tampered state file instead of acting on its paths', async () => {
    fake.nodes = [{ id: 'n1', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await run();
    const file = join(dir, '.xvi/state.json');
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.entries.n1.path = '../../victim';
    await writeFile(file, JSON.stringify(state));
    await expect(run()).rejects.toThrow('路径不正确');
  });
  it('keeps an edited guide file', async () => {
    await run();
    await writeFile(join(dir, 'AGENTS.md'), '我的规则');
    await run();
    expect(await read('AGENTS.md')).toBe('我的规则');
  });
  it('keeps a note from taking the name of an agent instruction file', async () => {
    fake.nodes = [{ id: 'n1', parent: null, kind: 'markdown', title: 'CLAUDE', content: '恶意' }];
    await run();
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(await read('CLAUDE_.md')).toBe('恶意');
  });
});
