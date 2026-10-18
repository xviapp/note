import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from './api';

const api = vi.fn();
const upload = vi.fn();
vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>();
  return {
    ...actual,
    api: (...args: unknown[]) => api(...args),
    upload: (...args: unknown[]) => upload(...args),
  };
});
const { planImport, runImport, startImport } = await import('./vault-import');

const entry = (path: string, text = 'x') => ({ path, size: text.length, file: new File([text], path.split('/').pop()!) });
const shape = (plan: ReturnType<typeof planImport>) =>
  plan.items.map((item) => `${item.parent ?? '·'} > ${item.path} (${item.kind} ${item.title} #${item.position})`);

beforeEach(() => {
  api.mockReset();
  upload.mockReset();
});

it('plans a vault: ignored files, skipped ones, folder notes and creation order', () => {
  const plan = planImport([
    entry('库/.obsidian/app.json'),
    entry('库/笔记 10.md'),
    entry('库/笔记 2.md'),
    entry('库/attachments/图.png'),
    entry('库/项目.md'),
    entry('库/项目/计划.md'),
    entry('库/读书/读书.md'),
    entry('库/读书/摘录.txt'),
    entry('库/读书/书.docx'),
    entry('库/读书/空.pdf', ''),
  ]);
  expect(plan).toMatchObject({ name: '库', wrap: true });
  expect(plan.skipped).toEqual([
    { path: '读书/书.docx', reason: '不支持的文件类型' },
    { path: '读书/空.pdf', reason: '文件为空' },
  ]);
  expect(shape(plan)).toEqual([
    // Folders first, then files, then notes, each after what holds it.
    '· > attachments (folder attachments #3)',
    'attachments > attachments/图.png (image 图.png #1)',
    // 读书/读书.md holds its own folder, and 项目.md holds 项目/; both list as folders.
    '· > 读书/读书.md (markdown 读书 #1)',
    '· > 项目.md (markdown 项目 #2)',
    '· > 笔记 2.md (markdown 笔记 2 #4)',
    '· > 笔记 10.md (markdown 笔记 10 #5)',
    '读书/读书.md > 读书/摘录.txt (text 摘录 #1)',
    '项目.md > 项目/计划.md (markdown 计划 #1)',
  ]);
});

it('plans loose files without a folder of their own', () => {
  const plan = planImport([entry('a.md'), entry('b.png')]);
  expect(plan.wrap).toBe(false);
  expect(plan.items.map((item) => item.path)).toEqual(['b.png', 'a.md']);
  expect(planImport([entry('a.md'), entry('目录/b.md')])).toMatchObject({ name: '', wrap: true });
});

it('resolves links by path, by name and by the shortest path', () => {
  const plan = planImport([
    entry('库/a/笔记.md'),
    entry('库/a/img/图.png'),
    entry('库/b/图.png'),
    entry('库/深/层/图.png'),
    entry('库/Other.md'),
    entry('库/b/c/Other.md'),
    entry('库/项目.md'),
    entry('库/项目/x.md'),
  ]);
  const resolve = (target: string, wiki = false) => plan.resolve('a/笔记.md', target, wiki);
  expect(resolve('img/图.png')).toBe('a/img/图.png');
  expect(resolve('../b/图.png')).toBe('b/图.png');
  expect(resolve('b/图.png')).toBe('b/图.png');
  expect(resolve('../../出界.png')).toBeNull();
  expect(resolve('图.png', true)).toBe('b/图.png');
  expect(resolve('other', true)).toBe('Other.md');
  expect(resolve('c/Other', true)).toBe('b/c/Other.md');
  expect(resolve('../other.md')).toBe('Other.md');
  expect(resolve('../项目')).toBe('项目.md');
  expect(resolve('没有', true)).toBeNull();
});

it('creates entries under IDs it chose, with links written, and retries what failed', async () => {
  const plan = planImport([entry('库/a.md', '见 [[b]] 与 ![[图.png|200]] 和 [[缺失]]'), entry('库/b.md', 'B'), entry('库/图.png', 'png')]);
  const state = startImport(plan, 'parent', new Date(2026, 9, 19));
  expect(state.title).toBe('库 导入 2026-10-19');
  upload.mockResolvedValue({ id: 'blob-1', name: '图.png', mime: 'image/png', size: 3 });
  let refuse = true;
  api.mockImplementation(async (_path: string, _method: string, body: Record<string, unknown>) => {
    if (body.title === 'b' && refuse) throw new ApiError('不行', 400);
    return { id: body.id };
  });
  const progress = vi.fn();
  await runImport(state, progress, new AbortController().signal);
  const posts = api.mock.calls.map((call) => call[2] as Record<string, unknown>);
  expect(posts[0]).toEqual({ id: state.rootId, kind: 'folder', title: '库 导入 2026-10-19', parentId: 'parent' });
  expect(upload).toHaveBeenCalledWith(expect.any(File), state.rootId);
  const note = posts.find((body) => body.title === 'a')!;
  expect(note).toMatchObject({ id: state.ids.get('a.md'), parentId: state.rootId, position: 2 });
  expect(note.content).toBe(`见 [b](/n/${state.ids.get('b.md')}) 与 ![](/api/files/blob-1) 和 [[缺失]]`);
  expect(posts.find((body) => body.kind === 'image')).toMatchObject({ fileId: 'blob-1', title: '图.png' });
  expect(state.failed).toEqual(new Map([['b.md', '不行']]));
  expect(state.missing).toEqual(new Map([['a.md', ['缺失']]]));
  // Each entry's ID is its operation key, so a retry cannot create it twice.
  expect(api.mock.calls.every((call) => call[3] === (call[2] as { id: string }).id)).toBe(true);
  refuse = false;
  api.mockClear();
  await runImport(state, progress, new AbortController().signal);
  expect(api.mock.calls.map((call) => (call[2] as { title: string }).title)).toEqual(['b']);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(state.failed.size).toBe(0);
});

it('stops when the connection is lost and leaves entries inside a failed folder', async () => {
  const plan = planImport([entry('库/子/a.md'), entry('库/b.md')]);
  const state = startImport(plan, null);
  api.mockImplementation(async (_path: string, _method: string, body: Record<string, unknown>) => {
    if (body.title === '子') throw new ApiError('目录有误', 400);
    return {};
  });
  await runImport(state, () => {}, new AbortController().signal);
  expect(state.failed.get('子/a.md')).toBe('所在文件夹未能导入。');
  expect(state.created.has('b.md')).toBe(true);
  api.mockRejectedValue(new ApiError('连接已中断', 0));
  await expect(runImport(state, () => {}, new AbortController().signal)).rejects.toThrow('连接已中断');
});
