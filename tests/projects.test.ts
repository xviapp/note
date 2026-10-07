/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/types';
import type { NoteDetail, NoteNode } from '../shared/types';
import type { ProjectOverview } from '../shared/projects';
import { validateBackup, type LibraryBackup } from '../shared/backup';
import { storeText } from '../worker/storage';
import { projectPrompt } from '../worker/projects';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let cookie = '';
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
const request = (
  path: string,
  method = 'GET',
  data?: unknown,
  extra: Record<string, string> = {},
) =>
  SELF.fetch(`https://notes.test${path}`, {
    method,
    headers: { cookie, origin: 'https://notes.test', 'content-type': 'application/json', ...extra },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
async function ok<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  data?: unknown,
  extra: Record<string, string> = {},
): Promise<T> {
  const response = await request(path, method, data, extra);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
const create = (data: object, key?: string) =>
  ok<NoteNode>('/api/nodes', 'POST', data, key ? { 'x-idempotency-key': key } : {});
const overview = (id: string) => ok<ProjectOverview>(`/api/nodes/${id}/project`);
const detail = (id: string) => ok<NoteDetail>(`/api/nodes/${id}`);
const children = async (id: string) =>
  (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${id}`)).nodes;
const unlock = async (id: string) => ({
  'x-note-edit': (await ok<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: id })).token,
});
beforeEach(async () => {
  await bindings.DB.batch(
    [
      'DELETE FROM backup_jobs',
      'DELETE FROM backup_restore_nodes',
      'DELETE FROM assistant_threads',
      'DELETE FROM nodes',
      'DELETE FROM trash_batches',
      'DELETE FROM blobs',
      'DELETE FROM idempotency',
      'DELETE FROM sessions',
      'DELETE FROM login_attempts',
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0,quota_bytes=8000000000,allocated_bytes=0 WHERE id=1',
    ].map((sql) => bindings.DB.prepare(sql)),
  );
  cookie = '';
  const response = await request('/api/auth/setup', 'POST', {
    token: bindings.SETUP_TOKEN,
    password: 'Project2026',
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
});

describe('project folders and Markdown indexing', () => {
  it('creates exactly three real directories atomically and replays creation and item requests', async () => {
    const key = crypto.randomUUID();
    const project = await create({ kind: 'folder', project: true }, key);
    expect(project).toMatchObject({ title: '未命名项目', variant: 'project' });
    expect((await create({ kind: 'folder', project: true }, key)).id).toBe(project.id);
    expect((await children(project.id)).map((node) => [node.title, node.project_category])).toEqual(
      [
        ['todo', 'todo'],
        ['issue', 'issue'],
        ['note', 'note'],
      ],
    );
    const itemKey = crypto.randomUUID();
    const item = await ok<NoteNode>(
      `/api/nodes/${project.id}/project/items`,
      'POST',
      { category: 'todo', title: '增加引用', content: '保持原内容' },
      { 'x-idempotency-key': itemKey },
    );
    expect(
      (
        await ok<NoteNode>(
          `/api/nodes/${project.id}/project/items`,
          'POST',
          { category: 'todo', title: '增加引用' },
          { 'x-idempotency-key': itemKey },
        )
      ).id,
    ).toBe(item.id);
    expect((await detail(item.id)).content).toBe(
      '---\ntitle: "增加引用"\nstatus: todo\n---\n\n保持原内容',
    );
    expect((await overview(project.id)).items).toEqual([
      expect.objectContaining({
        id: item.id,
        title: '增加引用',
        status: 'todo',
        summary: '保持原内容',
        category: 'todo',
      }),
    ]);
    const longTitle = '长'.repeat(200);
    const longItem = await ok<NoteNode>(`/api/nodes/${project.id}/project/items`, 'POST', {
      category: 'note',
      title: longTitle,
    });
    expect(longItem.title).toHaveLength(200);
    expect((await detail(longItem.id)).metadata_title).toBe(longTitle);
    for (const data of [
      { kind: 'markdown', project: true },
      { kind: 'folder', project: false },
      { kind: 'folder', project: true, book: {} },
    ])
      expect((await request('/api/nodes', 'POST', data)).status).toBe(400);
    expect((await request(`/api/nodes/${item.id}/project`)).status).toBe(404);
    expect(
      (
        await request(`/api/nodes/${project.id}/project/items`, 'POST', {
          category: 'task',
          title: '错分类',
        })
      ).status,
    ).toBe(400);
  });

  it('indexes nested Markdown, handles missing titles and states, and follows moves without stale classification', async () => {
    const project = await create({ kind: 'folder', title: '开发', project: true });
    const dirs = await children(project.id);
    const nested = await create({ kind: 'folder', title: '第一版', parentId: dirs[0].id });
    const item = await create({
      kind: 'markdown',
      title: 'fallback.md',
      parentId: nested.id,
      content: '# 修复图片\n\n正文',
    });
    const unnamed = await create({
      kind: 'markdown',
      title: '只有文件名.md',
      parentId: dirs[2].id,
      content: '设计资料',
    });
    await create({ kind: 'text', title: '不索引文本', parentId: dirs[0].id, content: '正文' });
    expect((await overview(project.id)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: item.id, title: '修复图片', status: null, category: 'todo' }),
        expect.objectContaining({ id: unnamed.id, title: '只有文件名.md', category: 'note' }),
      ]),
    );
    const saved = await ok<NoteNode>(
      `/api/nodes/${item.id}/content`,
      'PUT',
      {
        revision: item.revision,
        content: '---\ntitle: 新标题\nstatus: done\n---\n\n新正文',
        attachments: [],
      },
      await unlock(item.id),
    );
    const moved = await ok<NoteNode>(`/api/nodes/${item.id}`, 'PATCH', {
      revision: saved.revision,
      parentId: dirs[1].id,
    });
    expect(moved.project_category).toBe('issue');
    expect((await overview(project.id)).items.find((row) => row.id === item.id)).toMatchObject({
      category: 'issue',
      title: '新标题',
      status: 'done',
      summary: '新正文',
    });
    await ok(`/api/nodes/${item.id}`, 'PATCH', { revision: moved.revision, parentId: null });
    expect((await overview(project.id)).items.some((row) => row.id === item.id)).toBe(false);
  });

  it('deduplicates source files and terminates cyclic folder references, preserving originals when aliases are deleted', async () => {
    const project = await create({ kind: 'folder', project: true });
    const todo = (await children(project.id))[0];
    const source = await create({ kind: 'folder', title: '外部资料' });
    const item = await create({
      kind: 'markdown',
      title: '任务.md',
      parentId: source.id,
      content: '---\ntitle: 引用任务\nstatus: doing\n---\n正文',
    });
    await create({ kind: 'folder', title: '循环', parentId: source.id, referenceId: source.id });
    const alias = await create({
      kind: 'folder',
      title: '资料引用',
      parentId: todo.id,
      referenceId: source.id,
    });
    await create({ kind: 'folder', parentId: todo.id, referenceId: item.id });
    expect((await detail(alias.id)).reference?.target?.id).toBe(source.id);
    expect((await overview(project.id)).items).toHaveLength(1);
    expect(
      (
        await request('/api/nodes', 'POST', {
          kind: 'markdown',
          title: '禁止子级',
          parentId: alias.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/nodes/${item.id}`, 'PATCH', {
          revision: item.revision,
          parentId: alias.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await request('/api/nodes', 'POST', { kind: 'folder', referenceId: 'missing' })).status,
    ).toBe(404);
    await ok(`/api/nodes/${alias.id}`, 'DELETE', { count: 1 });
    expect((await detail(source.id)).title).toBe('外部资料');
    expect((await overview(project.id)).items).toHaveLength(1);
    const trash = await ok<{ id: string }>(`/api/nodes/${source.id}`, 'DELETE', { count: 3 });
    expect((await overview(project.id)).items).toHaveLength(0);
    expect((await overview(project.id)).warnings).toHaveLength(1);
    await ok(`/api/trash/${trash.id}/restore`, 'POST', {});
    expect((await overview(project.id)).items).toHaveLength(1);
  });

  it('writes status through to the source, preserves assets and history, and rejects conflicts, invalid states and files moved away', async () => {
    const project = await create({ kind: 'folder', project: true });
    const todo = (await children(project.id))[0];
    const attachment = await storeText(bindings, '附件内容');
    const content = `---\ntitle: 任务\nowner: me\nstatus: todo\n---\n\n完整正文 [附件](/api/files/${attachment.id})`;
    const source = await create({
      kind: 'markdown',
      title: '任务.md',
      content,
      attachments: [attachment.id],
    });
    await create({ kind: 'folder', referenceId: source.id, parentId: todo.id });
    const payload = {
      projectId: project.id,
      category: 'todo',
      status: 'done',
      revision: source.revision,
      utcOffsetMinutes: 480,
    };
    expect((await request(`/api/nodes/${source.id}/project-status`, 'PUT', payload)).status).toBe(
      403,
    );
    const headers = await unlock(source.id);
    const operationHeaders = { ...headers, 'x-idempotency-key': crypto.randomUUID() };
    const saved = await ok<NoteNode>(
      `/api/nodes/${source.id}/project-status`,
      'PUT',
      payload,
      operationHeaders,
    );
    const updated = (await detail(source.id)).content;
    expect(updated.startsWith(content.replace('status: todo', 'status: done'))).toBe(true);
    expect(updated).toMatch(/## 状态变更\n\n> \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00\n\n待办 → 已完成\n$/);
    expect((await ok<NoteNode>(`/api/nodes/${source.id}/project-status`, 'PUT', payload, operationHeaders)).revision).toBe(saved.revision);
    expect((await detail(source.id)).content).toBe(updated);
    expect((await detail(source.id)).attachments.map((file) => file.id)).toEqual([attachment.id]);
    expect((await overview(project.id)).items[0].status).toBe('done');
    expect(
      (
        await request(
          `/api/nodes/${source.id}/project-status`,
          'PUT',
          { ...payload, status: 'doing' },
          headers,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/api/nodes/${source.id}/project-status`,
          'PUT',
          { ...payload, revision: saved.revision, status: 'closed' },
          headers,
        )
      ).status,
    ).toBe(400);
    const { versions } = await ok<{ versions: { id: string }[] }>(
      `/api/nodes/${source.id}/versions`,
    );
    await ok(
      `/api/nodes/${source.id}/versions/${versions[1].id}/restore`,
      'POST',
      { revision: saved.revision },
      headers,
    );
    expect((await overview(project.id)).items[0].status).toBe('todo');
    const unrelated = await create({ kind: 'markdown', title: '不属于项目', content: '正文' });
    expect(
      (
        await request(
          `/api/nodes/${unrelated.id}/project-status`,
          'PUT',
          { ...payload, revision: unrelated.revision },
          await unlock(unrelated.id),
        )
      ).status,
    ).toBe(409);
    const ambiguous = await create({
      kind: 'markdown',
      title: '重复状态',
      content: '---\nstatus: todo\nstatus: done\n---\n正文',
      parentId: todo.id,
    });
    expect(
      (
        await request(
          `/api/nodes/${ambiguous.id}/project-status`,
          'PUT',
          { ...payload, revision: ambiguous.revision },
          await unlock(ambiguous.id),
        )
      ).status,
    ).toBe(400);
  });

  it('rebuilds old metadata in bounded batches and reflects trash and restore', async () => {
    const project = await create({ kind: 'folder', project: true });
    const todo = (await children(project.id))[0];
    for (let index = 0; index < 15; index++)
      await create({
        kind: 'markdown',
        title: `旧文件${index}.md`,
        parentId: todo.id,
        content: `---\ntitle: 标题${index}\nstatus: done\n---\n正文`,
      });
    await bindings.DB.prepare('UPDATE nodes SET metadata_version_id=NULL').run();
    const first = await overview(project.id);
    expect(first.items).toHaveLength(15);
    expect(first.indexing).toBe(3);
    const second = await overview(project.id);
    expect(second.indexing).toBe(0);
    expect(second.items.every((row) => row.status === 'done' && row.title.startsWith('标题'))).toBe(
      true,
    );
    const row = second.items[0];
    const trash = await ok<{ id: string }>(`/api/nodes/${row.id}`, 'DELETE', { count: 1 });
    expect((await overview(project.id)).items).toHaveLength(14);
    await ok(`/api/trash/${trash.id}/restore`, 'POST', {});
    expect((await overview(project.id)).items).toHaveLength(15);
  });

  it('round-trips project markers and reference targets and accepts older backups without project fields', async () => {
    const project = await create({ kind: 'folder', title: '备份项目', project: true });
    const todo = (await children(project.id))[0];
    const source = await create({
      kind: 'markdown',
      title: '原任务.md',
      content: '---\ntitle: 原任务\nstatus: doing\n---\n正文',
    });
    await create({ kind: 'folder', title: '任务引用', parentId: todo.id, referenceId: source.id });
    const { archive } = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST', {});
    expect(archive.tables.projects).toEqual([{ node_id: project.id }]);
    expect(archive.tables.node_references[0].target_id).toBe(source.id);
    const stage = await ok<{ id: string }>('/api/backups/restore', 'POST', archive);
    for (const file of archive.files) {
      const blob = await bindings.DB.prepare('SELECT object_key FROM blobs WHERE id=?')
        .bind(file.id)
        .first<{ object_key: string }>();
      const object = await bindings.FILES.get(blob!.object_key);
      const response = await SELF.fetch(
        `https://notes.test/api/backups/${stage.id}/files/${file.id}`,
        {
          method: 'POST',
          headers: { cookie, origin: 'https://notes.test' },
          body: await object!.arrayBuffer(),
        },
      );
      expect(response.ok, await response.clone().text()).toBe(true);
    }
    const { rootId } = await ok<{ rootId: string }>(`/api/backups/${stage.id}/commit`, 'POST', {});
    const restored = (await children(rootId)).find((node) => node.variant === 'project')!;
    const result = await overview(restored.id);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ title: '原任务', status: 'doing' });
    expect(result.items[0].id).not.toBe(source.id);
    const restoredTodo = (await children(restored.id))[0];
    const reference = (await children(restoredTodo.id))[0];
    expect(reference.reference_target_id).toBe(result.items[0].id);
    const legacy = structuredClone(archive);
    delete (legacy.tables as Partial<LibraryBackup['tables']>).projects;
    delete (legacy.tables as Partial<LibraryBackup['tables']>).node_references;
    for (const node of legacy.tables.nodes)
      for (const field of [
        'metadata_title',
        'metadata_status',
        'metadata_excerpt',
        'metadata_version_id',
      ])
        delete node[field];
    expect(validateBackup(legacy).tables.projects).toEqual([]);
  });

  it('tells 青藜 about the project and its open work, not its notes', async () => {
    const project = await create({ kind: 'folder', title: '页间改版', project: true });
    const add = (category: string, title: string) =>
      ok<NoteNode>(`/api/nodes/${project.id}/project/items`, 'POST', { category, title });
    const todo = await add('todo', '增加引用');
    await add('issue', '同步失败');
    await add('note', '方案草稿');
    // Indexing happens when the project page reads its overview.
    await ok(`/api/nodes/${project.id}/project`);
    const prompt = await projectPrompt(bindings, await detail(todo.id));
    expect(prompt).toContain('当前文件属于项目「页间改版」');
    expect(prompt).toContain('[待办·待办] 增加引用');
    expect(prompt).toContain('[问题·待处理] 同步失败');
    expect(prompt).not.toContain('方案草稿');
    expect(await projectPrompt(bindings, await create({ kind: 'markdown', title: '无关' }))).toBe(
      '',
    );
  });
});
