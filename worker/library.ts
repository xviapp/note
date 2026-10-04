import type { Env } from './types';
import type { FileInfo, NoteDetail, NoteNode, NodeKind, VersionInfo } from '../shared/types';
import { PARENT_KINDS, TEXT_KINDS, UNTITLED_NAMES } from '../shared/types';
import { AppError, idValue, integer, textValue } from './http';
import { discardFile, getBlob, readText, storePaper, storeText } from './storage';
import { FOLDER_ICON_MAX_BYTES, FOLDER_ICON_MIMES, isFolderEmoji } from '../shared/folder-icons';

export const NODE_COLUMNS = `n.*,(SELECT COUNT(*) FROM nodes c WHERE c.parent_id=n.id AND c.trash_id IS NULL) child_count,
  EXISTS(SELECT 1 FROM favorites f WHERE f.node_id=n.id) favorite`;
export async function getNode(env: Env, id: string, includeTrash = false): Promise<NoteNode> {
  const node = await env.DB.prepare(`SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id=?`)
    .bind(idValue(id))
    .first<NoteNode>();
  if (!node) throw new AppError(404, '笔记不存在，可能已被永久删除。', 'NODE_UNAVAILABLE');
  if (node.trash_id && !includeTrash)
    throw new AppError(410, '这篇笔记在回收站中，恢复后可以继续阅读。', 'NODE_TRASHED');
  return node;
}
export async function listNodes(
  env: Env,
  url: URL,
): Promise<{ nodes: NoteNode[]; nextOffset: number | null }> {
  const view = url.searchParams.get('view') || 'tree',
    offset = Math.max(0, Number(url.searchParams.get('offset')) || 0),
    limit = 100;
  let query = '',
    params: (string | number | null)[] = [];
  if (view === 'favorites') {
    query = `SELECT ${NODE_COLUMNS} FROM nodes n JOIN favorites f ON f.node_id=n.id WHERE n.trash_id IS NULL ORDER BY f.created_at DESC,n.id LIMIT ? OFFSET ?`;
    params = [limit + 1, offset];
  } else if (view === 'recent') {
    query = `SELECT ${NODE_COLUMNS} FROM nodes n JOIN reading_states r ON r.node_id=n.id WHERE n.trash_id IS NULL ORDER BY r.last_opened_at DESC,n.id LIMIT 20`;
  } else {
    const parent = url.searchParams.get('parent') || null;
    if (parent) await getNode(env, parent);
    query = `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.trash_id IS NULL AND n.parent_id IS ? ORDER BY n.position,n.id LIMIT ? OFFSET ?`;
    params = [parent, limit + 1, offset];
  }
  const result = await env.DB.prepare(query)
    .bind(...params)
    .all<NoteNode>();
  return {
    nodes: result.results.slice(0, limit),
    nextOffset: result.results.length > limit ? offset + limit : null,
  };
}
async function attachments(env: Env, version: string | null): Promise<FileInfo[]> {
  if (!version) return [];
  return (
    await env.DB.prepare(
      'SELECT b.id,b.name,b.mime,b.size FROM version_assets a JOIN blobs b ON b.id=a.blob_id WHERE a.version_id=? ORDER BY b.created_at,b.id',
    )
      .bind(version)
      .all<FileInfo>()
  ).results;
}
export async function nodePath(env: Env, id: string) {
  const crumbs = await env.DB.prepare(
    `WITH RECURSIVE parents(id,title,parent_id,depth) AS (
    SELECT id,title,parent_id,0 FROM nodes WHERE id=?
    UNION ALL SELECT n.id,n.title,n.parent_id,p.depth+1 FROM nodes n JOIN parents p ON p.parent_id=n.id WHERE p.depth<200
  ) SELECT id,title FROM parents ORDER BY depth DESC`,
  )
    .bind(id)
    .all<{ id: string; title: string }>();
  return crumbs.results;
}
export async function noteDetail(env: Env, id: string): Promise<NoteDetail> {
  const node = await getNode(env, id);
  let content = '';
  if (node.current_version_id) {
    const version = await env.DB.prepare('SELECT body_blob_id FROM versions WHERE id=?')
      .bind(node.current_version_id)
      .first<{ body_blob_id: string }>();
    if (version) content = await readText(env, version.body_blob_id);
  }
  const file = node.file_blob_id ? await getBlob(env, node.file_blob_id) : undefined;
  return {
    ...node,
    content,
    attachments: await attachments(env, node.current_version_id),
    file: file ? { id: file.id, name: file.name, mime: file.mime, size: file.size } : undefined,
    breadcrumbs: await nodePath(env, id),
  };
}
export function operationKey(request: Request): string {
  const key = request.headers.get('x-idempotency-key');
  return key ? idValue(key) : crypto.randomUUID();
}
export async function priorOperation(
  env: Env,
  key: string,
  operation: string,
): Promise<NoteNode | null> {
  const row = await env.DB.prepare('SELECT node_id,operation FROM idempotency WHERE key=?')
    .bind(key)
    .first<{ node_id: string; operation: string }>();
  if (!row) return null;
  if (row.operation !== operation) throw new AppError(409, '操作标识已使用，请重新发起操作。');
  return getNode(env, row.node_id);
}
function validUrl(input: unknown): string {
  const value = textValue(input, '网页地址', 4000);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, '请输入完整的 http 或 https 网址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new AppError(400, '网页链接仅支持不含账号密码的 http 和 https 地址。');
  return url.href;
}
function attachmentIds(content: string, ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > 100)
    throw new AppError(400, '每篇笔记最多关联 100 个附件。');
  const values = new Set(ids.map(idValue));
  for (const match of content.matchAll(/\/api\/files\/([a-zA-Z0-9_-]{1,80})/g))
    values.add(match[1]);
  if (values.size > 100) throw new AppError(400, '每篇笔记最多关联 100 个附件。');
  return [...values].sort();
}
async function folderIcon(
  env: Env,
  kind: NodeKind,
  input: unknown,
  current?: NoteNode,
): Promise<{ emoji: string | null; fileId: string | null }> {
  if (input === undefined)
    return { emoji: current?.icon_emoji ?? null, fileId: current?.icon_blob_id ?? null };
  if (kind !== 'folder') throw new AppError(400, '只有文件夹可以自定义图标。');
  if (input === null) return { emoji: null, fileId: null };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError(400, '图标格式不正确。');
  const value = input as Record<string, unknown>;
  const emoji = value.emoji ?? null,
    fileId = value.fileId ?? null;
  if (emoji !== null && !isFolderEmoji(emoji)) throw new AppError(400, '请输入一个 Emoji。');
  if (emoji !== null && fileId !== null) throw new AppError(400, '请选择 Emoji 或图片作为图标。');
  if (fileId !== null) {
    const file = await getBlob(env, idValue(fileId));
    if (!FOLDER_ICON_MIMES.includes(file.mime) || file.size > FOLDER_ICON_MAX_BYTES)
      throw new AppError(400, '文件夹图标需要使用不超过 128 KiB 的图片。');
    return { emoji: null, fileId: file.id };
  }
  return { emoji: emoji as string | null, fileId: null };
}
export async function createNode(
  env: Env,
  data: Record<string, unknown>,
  key: string,
  paper?: { arxivId: string; html: string; assets: string[] },
): Promise<NoteNode> {
  const operation = paper ? 'import-arxiv' : 'create';
  const previous = await priorOperation(env, key, operation);
  if (previous) return previous;
  const kind = data.kind as NodeKind;
  if (!['folder', 'markdown', 'text', 'pdf', 'image', 'link'].includes(kind))
    throw new AppError(400, '节点类型不正确。');
  const suppliedTitle = textValue(data.title ?? '', '标题', 200, true).trim();
  let title = suppliedTitle || UNTITLED_NAMES[kind];
  const icon = await folderIcon(env, kind, data.icon);
  const parent = data.parentId == null ? null : idValue(data.parentId);
  if (parent) {
    const p = await getNode(env, parent);
    if (!PARENT_KINDS.includes(p.kind)) throw new AppError(400, '这个节点不能包含子节点。');
  }
  const url = kind === 'link' ? validUrl(data.url) : null;
  let fileId: string | null = null;
  if (kind === 'pdf' || kind === 'image') {
    const file = await getBlob(env, idValue(data.fileId));
    if (kind === 'pdf' ? file.mime !== 'application/pdf' : !file.mime.startsWith('image/'))
      throw new AppError(400, '文件内容与节点类型不符。');
    fileId = file.id;
    if (!suppliedTitle && file.name.trim()) title = file.name.trim();
  }
  const isText = TEXT_KINDS.includes(kind),
    content = isText ? textValue(data.content ?? '', '正文', 1_048_576, true) : '';
  const assets = paper
    ? paper.assets
    : isText
      ? attachmentIds(content, data.attachments ?? [])
      : [];
  const blob = paper
      ? await storePaper(env, paper.html)
      : isText
        ? await storeText(env, content)
        : null,
    id = crypto.randomUUID(),
    now = Date.now(),
    version = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      'INSERT INTO idempotency(key,operation,node_id,result_revision,created_at) VALUES(?,?,?,?,?)',
    ).bind(key, operation, id, 1, now),
    env.DB.prepare(
      `INSERT INTO nodes(id,parent_id,kind,title,position,url,file_blob_id,revision,created_at,updated_at,arxiv_id,icon_emoji,icon_blob_id)
      VALUES(?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM nodes WHERE parent_id IS ?),?,?,?,?,?,?,?,?)`,
    ).bind(
      id,
      parent,
      kind,
      title,
      parent,
      url,
      fileId,
      blob ? 0 : 1,
      now,
      now,
      paper?.arxivId ?? null,
      icon.emoji,
      icon.fileId,
    ),
  ];
  if (blob)
    statements.push(
      env.DB.prepare(
        'INSERT INTO versions(id,node_id,sequence,body_blob_id,created_at) VALUES(?,?,1,?,?)',
      ).bind(version, id, blob.id, now),
      env.DB.prepare(
        'INSERT INTO version_assets(version_id,blob_id) SELECT ?,value FROM json_each(?)',
      ).bind(version, JSON.stringify(assets)),
      env.DB.prepare('UPDATE nodes SET revision=1,current_version_id=? WHERE id=?').bind(
        version,
        id,
      ),
    );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (blob) await discardFile(env, blob.id).catch(() => {});
    const prior = await priorOperation(env, key, operation);
    if (prior) return prior;
    throw error;
  }
  return getNode(env, id);
}
export async function saveNote(
  env: Env,
  id: string,
  data: Record<string, unknown>,
  key: string,
  reuseBody?: string,
): Promise<NoteNode> {
  const previous = await priorOperation(env, key, `save:${id}`);
  if (previous) return previous;
  const node = await getNode(env, id),
    revision = integer(data.revision, '版本号');
  if (!TEXT_KINDS.includes(node.kind)) throw new AppError(400, '只有文本笔记可以编辑正文。');
  if (node.revision !== revision)
    throw new AppError(409, '这篇笔记已在其他页面更新，当前编辑内容已保留。', 'VERSION_CONFLICT');
  const content = textValue(data.content, '正文', 1_048_576, true),
    assets = attachmentIds(content, data.attachments ?? []);
  const current = await env.DB.prepare('SELECT body_blob_id FROM versions WHERE id=?')
    .bind(node.current_version_id)
    .first<{ body_blob_id: string }>();
  const oldAssets = (await attachments(env, node.current_version_id)).map((x) => x.id).sort();
  const unchangedBody = current && content === (await readText(env, current.body_blob_id));
  if (unchangedBody && JSON.stringify(assets) === JSON.stringify(oldAssets)) return node;
  const fresh = reuseBody || unchangedBody ? null : await storeText(env, content),
    bodyId = reuseBody || (unchangedBody ? current!.body_blob_id : fresh!.id);
  const version = crypto.randomUUID(),
    now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO idempotency(key,operation,node_id,result_revision,created_at) VALUES(?,?,?,?,?)',
      ).bind(key, `save:${id}`, id, revision + 1, now),
      env.DB.prepare(
        'INSERT INTO versions(id,node_id,sequence,body_blob_id,created_at) VALUES(?,?,?,?,?)',
      ).bind(version, id, revision + 1, bodyId, now),
      env.DB.prepare(
        'INSERT INTO version_assets(version_id,blob_id) SELECT ?,value FROM json_each(?)',
      ).bind(version, JSON.stringify(assets)),
      env.DB.prepare(
        'UPDATE nodes SET current_version_id=?,revision=revision+1,updated_at=? WHERE id=?',
      ).bind(version, now, id),
      env.DB.prepare(
        'DELETE FROM versions WHERE node_id=? AND id NOT IN (SELECT id FROM versions WHERE node_id=? ORDER BY sequence DESC LIMIT 6)',
      ).bind(id, id),
    ]);
  } catch (error) {
    if (fresh) await discardFile(env, fresh.id).catch(() => {});
    const prior = await priorOperation(env, key, `save:${id}`);
    if (prior) return prior;
    throw error;
  }
  return getNode(env, id);
}
export async function updateNode(
  env: Env,
  id: string,
  data: Record<string, unknown>,
): Promise<NoteNode> {
  const node = await getNode(env, id),
    revision = integer(data.revision, '版本号');
  const title = data.title === undefined ? node.title : textValue(data.title, '标题').trim();
  const parent =
    data.parentId === undefined
      ? node.parent_id
      : data.parentId === null
        ? null
        : idValue(data.parentId);
  const url = data.url === undefined ? node.url : node.kind === 'link' ? validUrl(data.url) : null;
  if (node.arxiv_id && url !== node.url)
    throw new AppError(400, '已保存论文的原文地址不能修改，请重新导入其他论文。');
  const icon = await folderIcon(env, node.kind, data.icon, node);
  const position = data.position === undefined ? Date.now() : data.position;
  if (typeof position !== 'number' || !Number.isFinite(position))
    throw new AppError(400, '节点顺序不正确。');
  // Only write parent_id when moving; renaming must not depend on an unrelated parent update trigger.
  const moving = data.parentId !== undefined;
  const result = await env.DB.prepare(
    `UPDATE nodes SET title=?,url=?,icon_emoji=?,icon_blob_id=?,${moving ? 'parent_id=?,position=?,' : ''} revision=revision+1,updated_at=? WHERE id=? AND revision=? AND trash_id IS NULL RETURNING id`,
  )
    .bind(
      title,
      url,
      icon.emoji,
      icon.fileId,
      ...(moving ? [parent, position] : []),
      Date.now(),
      id,
      revision,
    )
    .first();
  if (!result) throw new AppError(409, '节点已在其他页面更新，请刷新后重试。', 'VERSION_CONFLICT');
  if (node.icon_blob_id && node.icon_blob_id !== icon.fileId)
    await discardFile(env, node.icon_blob_id).catch(() => {});
  return getNode(env, id);
}
export async function versionsList(env: Env, id: string): Promise<VersionInfo[]> {
  const node = await getNode(env, id);
  const result = await env.DB.prepare(
    'SELECT id,sequence,created_at FROM versions WHERE node_id=? ORDER BY sequence DESC LIMIT 6',
  )
    .bind(id)
    .all<{ id: string; sequence: number; created_at: number }>();
  return result.results.map((v) => ({ ...v, current: v.id === node.current_version_id }));
}
export async function versionDetail(
  env: Env,
  id: string,
  version: string,
): Promise<{ content: string; attachments: FileInfo[]; bodyId: string }> {
  await getNode(env, id);
  const row = await env.DB.prepare('SELECT body_blob_id FROM versions WHERE id=? AND node_id=?')
    .bind(idValue(version), id)
    .first<{ body_blob_id: string }>();
  if (!row) throw new AppError(404, '这个历史版本已超出保留数量。');
  return {
    content: await readText(env, row.body_blob_id),
    attachments: await attachments(env, version),
    bodyId: row.body_blob_id,
  };
}
export async function restoreVersion(
  env: Env,
  id: string,
  version: string,
  revision: unknown,
  key: string,
): Promise<NoteNode> {
  const detail = await versionDetail(env, id, version);
  return saveNote(
    env,
    id,
    { revision, content: detail.content, attachments: detail.attachments.map((x) => x.id) },
    key,
    detail.bodyId,
  );
}
