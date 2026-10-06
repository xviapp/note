import type { Env } from './types';
import type { NoteNode } from '../shared/types';
import {
  markdownMetadata,
  PROJECT_CATEGORIES,
  PROJECT_STATUSES,
  projectCategory,
  projectMarkdown,
  setMarkdownStatus,
  type ProjectCategory,
  type ProjectOverview,
} from '../shared/projects';
import { AppError, idValue, textValue } from './http';
import { createNode, getNode, noteDetail, saveNote } from './library';
import { readText } from './storage';

// Category follows the actual tree, including a category folder itself. The
// project overview additionally traverses references without copying content.
export const PROJECT_CATEGORY_SQL = `(WITH RECURSIVE ancestors(id,parent_id,title,kind,depth) AS (
  SELECT n.id,n.parent_id,n.title,n.kind,0
  UNION ALL SELECT p.id,p.parent_id,p.title,p.kind,a.depth+1 FROM nodes p JOIN ancestors a ON p.id=a.parent_id WHERE a.depth<200
) SELECT lower(trim(a.title)) FROM ancestors a JOIN projects p ON p.node_id=a.parent_id
WHERE a.kind='folder' AND lower(trim(a.title)) IN ('todo','issue','note') ORDER BY a.depth LIMIT 1)`;

export function insertProject(env: Env, id: string, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare('INSERT INTO projects(node_id) VALUES(?)').bind(id),
    ...PROJECT_CATEGORIES.map((category, position) =>
      env.DB.prepare(
        `INSERT INTO nodes(id,parent_id,kind,title,position,revision,created_at,updated_at)
         VALUES(?,?,'folder',?,?,1,?,?)`,
      ).bind(crypto.randomUUID(), id, category, position, now, now),
    ),
  ];
}
export function metadataStatement(env: Env, id: string, version: string, content: string) {
  const metadata = markdownMetadata(content);
  return env.DB.prepare(
    `UPDATE nodes SET metadata_title=?,metadata_status=?,metadata_excerpt=?,metadata_version_id=?
     WHERE id=? AND current_version_id=?`,
  ).bind(metadata.title, metadata.status, metadata.summary, version, id, version);
}
async function requireProject(env: Env, id: string) {
  const node = await getNode(env, id);
  if (!node.is_project) throw new AppError(404, '这个目录不是项目。');
  return node;
}

// UNION deduplicates (category,id), making folder references and even cycles
// finite. Each category contains a source Markdown file at most once.
const REACH = `WITH RECURSIVE reach(category,id) AS (
  SELECT lower(trim(n.title)),n.id FROM nodes n WHERE n.parent_id=? AND n.kind='folder'
    AND n.trash_id IS NULL AND lower(trim(n.title)) IN ('todo','issue','note')
  UNION SELECT r.category,c.id FROM reach r JOIN nodes c ON c.parent_id=r.id WHERE c.trash_id IS NULL
  UNION SELECT r.category,t.id FROM reach r JOIN node_references f ON f.node_id=r.id
    JOIN nodes t ON t.id=f.target_id WHERE t.trash_id IS NULL
)`;
async function projectRows(env: Env, id: string) {
  return (
    await env.DB.prepare(
      `${REACH}
      SELECT n.*,r.category,v.body_blob_id FROM reach r JOIN nodes n ON n.id=r.id
      JOIN versions v ON v.id=n.current_version_id WHERE n.kind='markdown' AND n.trash_id IS NULL
      ORDER BY n.updated_at DESC,n.id,r.category`,
    )
      .bind(id)
      .all<NoteNode & { category: ProjectCategory; body_blob_id: string }>()
  ).results;
}
export async function projectOverview(env: Env, id: string): Promise<ProjectOverview> {
  await requireProject(env, id);
  const rows = await projectRows(env, id);
  const missing = [
    ...new Map(
      rows
        .filter((row) => row.metadata_version_id !== row.current_version_id)
        .map((row) => [row.id, row]),
    ).values(),
  ];
  // Old notes and restored archives rebuild only the summaries they need.
  // Bound first-open rebuilding to keep each request inside D1's query budget.
  // The client continues automatically until every current version is indexed.
  for (const row of missing.slice(0, 12)) {
    const content = await readText(env, row.body_blob_id);
    await metadataStatement(env, row.id, row.current_version_id!, content).run();
  }
  const current = missing.length ? await projectRows(env, id) : rows;
  const directories = (
    await env.DB.prepare(
      `SELECT id,title,lower(trim(title)) category FROM nodes
      WHERE parent_id=? AND kind='folder' AND trash_id IS NULL AND lower(trim(title)) IN ('todo','issue','note')
      ORDER BY position,id`,
    )
      .bind(id)
      .all<ProjectOverview['directories'][number]>()
  ).results;
  const broken = (
    await env.DB.prepare(
      `${REACH}
      SELECT DISTINCT n.title FROM reach r JOIN nodes n ON n.id=r.id JOIN node_references f ON f.node_id=n.id
      LEFT JOIN nodes t ON t.id=f.target_id WHERE t.id IS NULL OR t.trash_id IS NOT NULL`,
    )
      .bind(id)
      .all<{ title: string }>()
  ).results;
  return {
    directories,
    items: current.map((row) => {
      const indexed = row.metadata_version_id === row.current_version_id;
      return {
        id: row.id,
        category: row.category,
        title: (indexed && row.metadata_title) || row.title,
        status: (indexed && row.metadata_status) || null,
        summary: (indexed && row.metadata_excerpt) || '',
        revision: row.revision,
        updated_at: row.updated_at,
      };
    }),
    warnings: broken.map((row) => `「${row.title}」引用的内容已删除或在回收站中。`),
    indexing: new Set(
      current
        .filter((row) => row.metadata_version_id !== row.current_version_id)
        .map((row) => row.id),
    ).size,
  };
}
export async function createProjectItem(
  env: Env,
  id: string,
  data: Record<string, unknown>,
  key: string,
) {
  await requireProject(env, id);
  const category = projectCategory(data.category);
  if (!category) throw new AppError(400, '请选择待办、问题或笔记。');
  const title = textValue(data.title, '标题', 200).trim();
  const content = textValue(data.content ?? '', '说明', 1_048_000, true);
  // Writing always goes to an actual directory. References are read-through.
  let directory = await env.DB.prepare(
    `SELECT n.id FROM nodes n WHERE parent_id=? AND kind='folder'
    AND trash_id IS NULL AND lower(trim(title))=?
    AND NOT EXISTS(SELECT 1 FROM node_references r WHERE r.node_id=n.id) ORDER BY position,id LIMIT 1`,
  )
    .bind(id, category)
    .first<{ id: string }>();
  if (!directory)
    directory = await createNode(
      env,
      { kind: 'folder', title: category, parentId: id },
      `${key}-dir`,
    );
  return createNode(
    env,
    {
      kind: 'markdown',
      title: /\.md$/i.test(title) ? title : `${title.slice(0, 197)}.md`,
      parentId: directory.id,
      content: projectMarkdown(category, title) + content,
    },
    key,
  );
}
export async function saveProjectStatus(
  env: Env,
  id: string,
  data: Record<string, unknown>,
  key: string,
) {
  const projectId = idValue(data.projectId);
  await requireProject(env, projectId);
  const category = projectCategory(data.category);
  if (
    !category ||
    typeof data.status !== 'string' ||
    !Object.hasOwn(PROJECT_STATUSES[category], data.status)
  )
    throw new AppError(400, '这个分类不支持所选状态。');
  const member = await env.DB.prepare(`${REACH} SELECT 1 FROM reach WHERE category=? AND id=?`)
    .bind(projectId, category, idValue(id))
    .first();
  if (!member) throw new AppError(409, '这篇笔记已移出项目，请刷新后重试。');
  const detail = await noteDetail(env, id);
  if (detail.kind !== 'markdown') throw new AppError(400, '只有 Markdown 文件支持项目状态。');
  let content: string;
  try {
    content = setMarkdownStatus(detail.content, data.status);
  } catch (error) {
    throw new AppError(400, error instanceof Error ? error.message : '无法修改文首状态。');
  }
  return saveNote(
    env,
    id,
    {
      revision: data.revision,
      content,
      attachments: detail.attachments.map((file) => file.id),
    },
    key,
  );
}
