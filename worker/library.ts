import type { Env } from './types';
import type { FileInfo, NoteDetail, NoteNode, NodeKind, VersionInfo } from '../shared/types';
import { PARENT_KINDS, TEXT_KINDS, UNTITLED_NAMES } from '../shared/types';
import { AppError, idValue, integer, textValue } from './http';
import {
  discardFile,
  getBlob,
  MAX_TEXT_BYTES,
  readBody,
  readText,
  storePaper,
  storeText,
} from './storage';
import { bookFields, bookOf, insertBook, isDiscussion, pageInfo } from './books';
import { FOLDER_ICON_MAX_BYTES, FOLDER_ICON_MIMES, isFolderEmoji } from '../shared/folder-icons';
import {
  insertProject,
  metadataStatement,
  PROJECT_CATEGORY_SQL,
  sealedMetadataStatement,
} from './projects';
import { sealedSize } from '../shared/encryption';
import { hasKey, locked } from './encryption';

// What a node is: its kind, or the kind of page a side table makes of it.
// The first matching row wins; keep this in step with NoteVariant.
const VARIANT_SQL = `CASE
    WHEN EXISTS(SELECT 1 FROM node_references r WHERE r.node_id=n.id) THEN 'reference'
    WHEN EXISTS(SELECT 1 FROM books b WHERE b.node_id=n.id) THEN 'book'
    WHEN EXISTS(SELECT 1 FROM projects p WHERE p.node_id=n.id) THEN 'project'
    WHEN EXISTS(SELECT 1 FROM book_discussions d WHERE d.node_id=n.id) THEN 'discussion'
    WHEN EXISTS(SELECT 1 FROM book_pages p JOIN books b ON b.node_id=n.parent_id WHERE p.node_id=n.id) THEN 'book-page'
    WHEN n.arxiv_id IS NOT NULL THEN 'paper'
    ELSE n.kind END`;
// Discussions below a book page live in the page, not in the tree or lists.
export const NOT_DISCUSSION = (alias: string) =>
  `NOT EXISTS(SELECT 1 FROM book_discussions d WHERE d.node_id=${alias}.id)`;
// The key a node's content is encrypted with: its own setting or the nearest
// ancestor's ('none' stops inheritance), null when plain.
export const KEY_SQL = (alias: string) => `(WITH RECURSIVE up(id,parent_id,encryption,depth) AS (
  SELECT ${alias}.id,${alias}.parent_id,${alias}.encryption,0
  UNION ALL SELECT p.id,p.parent_id,p.encryption,u.depth+1 FROM nodes p JOIN up u ON p.id=u.parent_id
  WHERE u.encryption IS NULL AND u.depth<200
) SELECT NULLIF(encryption,'none') FROM up WHERE encryption IS NOT NULL ORDER BY depth LIMIT 1)`;
export const NODE_COLUMNS = `n.*,${KEY_SQL('n')} key_id,(SELECT COUNT(*) FROM nodes c WHERE c.parent_id=n.id AND c.trash_id IS NULL AND ${NOT_DISCUSSION('c')}) child_count,
  EXISTS(SELECT 1 FROM favorites f WHERE f.node_id=n.id) favorite,
  ${VARIANT_SQL} variant,
  (SELECT target_id FROM node_references r WHERE r.node_id=n.id) reference_target_id,
  (SELECT t.kind FROM node_references r JOIN nodes t ON t.id=r.target_id WHERE r.node_id=n.id AND t.trash_id IS NULL) reference_kind,
  ${PROJECT_CATEGORY_SQL} project_category`;
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
    query = `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.trash_id IS NULL AND n.parent_id IS ? AND ${NOT_DISCUSSION('n')} ORDER BY n.position,n.id LIMIT ? OFFSET ?`;
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
      'SELECT b.id,b.name,b.mime,b.size,b.key_id FROM version_assets a JOIN blobs b ON b.id=a.blob_id WHERE a.version_id=? ORDER BY b.created_at,b.id',
    )
      .bind(version)
      .all<FileInfo>()
  ).results;
}
export async function nodePath(env: Env, id: string) {
  const crumbs = await env.DB.prepare(
    `WITH RECURSIVE parents(id,title,parent_id,encryption,depth) AS (
    SELECT id,title,parent_id,encryption,0 FROM nodes WHERE id=?
    UNION ALL SELECT n.id,n.title,n.parent_id,n.encryption,p.depth+1 FROM nodes n JOIN parents p ON p.parent_id=n.id WHERE p.depth<200
  ) SELECT id,title,encryption FROM parents ORDER BY depth DESC`,
  )
    .bind(id)
    .all<{ id: string; title: string; encryption: string | null }>();
  return crumbs.results;
}
export async function noteDetail(env: Env, id: string): Promise<NoteDetail> {
  const node = await getNode(env, id);
  let body: { content: string; sealed?: string } = { content: '' };
  if (node.current_version_id) {
    const version = await env.DB.prepare('SELECT body_blob_id FROM versions WHERE id=?')
      .bind(node.current_version_id)
      .first<{ body_blob_id: string }>();
    if (version) body = await readBody(env, version.body_blob_id);
  }
  const file = node.file_blob_id ? await getBlob(env, node.file_blob_id) : undefined;
  const book = await bookOf(env, id);
  const page = book ? await pageInfo(env, node) : undefined;
  const discussion = book && node.parent_id && (await isDiscussion(env, id));
  let reference: NoteDetail['reference'];
  if (node.variant === 'reference') {
    let target: NoteNode | null = null;
    if (node.reference_target_id) {
      try {
        target = await getNode(env, node.reference_target_id);
      } catch (error) {
        if (!(error instanceof AppError) || ![404, 410].includes(error.status)) throw error;
      }
    }
    reference = { target };
  }
  return {
    ...node,
    ...body,
    attachments: await attachments(env, node.current_version_id),
    file: file
      ? { id: file.id, name: file.name, mime: file.mime, size: file.size, key_id: file.key_id }
      : undefined,
    breadcrumbs: await nodePath(env, id),
    ...(book ? { book } : {}),
    ...(page ? { book_page: page } : {}),
    ...(discussion ? { discussion_page: node.parent_id! } : {}),
    ...(reference ? { reference } : {}),
  };
}
// A note's detail with its text, for the Worker's own use (books, projects):
// an encrypted body needs its key in the request.
export async function plainDetail(env: Env, id: string): Promise<NoteDetail> {
  const detail = await noteDetail(env, id);
  if (detail.sealed) throw locked();
  return detail;
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
  // Rows created with the node in the same batch (book pages, discussions).
  extra?: (id: string, now: number) => D1PreparedStatement[],
): Promise<NoteNode> {
  const operation = paper ? 'import-arxiv' : 'create';
  const previous = await priorOperation(env, key, operation);
  if (previous) return previous;
  const kind = data.kind as NodeKind;
  if (!['folder', 'markdown', 'text', 'pdf', 'image', 'link'].includes(kind))
    throw new AppError(400, '节点类型不正确。');
  const suppliedTitle = textValue(data.title ?? '', '标题', 200, true).trim();
  const project = data.project !== undefined;
  if (
    project &&
    (data.project !== true ||
      kind !== 'folder' ||
      data.book !== undefined ||
      data.referenceId !== undefined ||
      paper)
  )
    throw new AppError(400, '项目需要使用独立的文件夹。');
  const reference =
    data.referenceId === undefined ? null : await getNode(env, idValue(data.referenceId));
  if (reference && (kind !== 'folder' || data.book !== undefined || paper))
    throw new AppError(400, '引用不能同时创建其他内容。');
  let title =
    suppliedTitle ||
    (project
      ? '未命名项目'
      : reference
        ? reference.title
        : data.book !== undefined
          ? '未命名书籍'
          : UNTITLED_NAMES[kind]);
  const icon = await folderIcon(env, kind, data.icon);
  // A book is a folder created together with its details.
  if (data.book !== undefined && (kind !== 'folder' || paper))
    throw new AppError(400, '只能新建文件夹形式的书籍。');
  const book =
    data.book === undefined
      ? null
      : bookFields(
          data.book && typeof data.book === 'object' && !Array.isArray(data.book)
            ? (data.book as Record<string, unknown>)
            : {},
        );
  const parent = data.parentId == null ? null : idValue(data.parentId);
  // The key the new node's content inherits.
  let scope: string | null = null;
  if (parent) {
    const p = await getNode(env, parent);
    if (!PARENT_KINDS.includes(p.kind) || p.variant === 'reference')
      throw new AppError(400, '这个节点不能包含子节点，请打开引用的原目录。');
    scope = p.key_id ?? null;
  }
  const url = kind === 'link' ? validUrl(data.url) : null;
  let fileId: string | null = null;
  if (kind === 'pdf' || kind === 'image') {
    const file = await getBlob(env, idValue(data.fileId));
    if (kind === 'pdf' ? file.mime !== 'application/pdf' : !file.mime.startsWith('image/'))
      throw new AppError(400, '文件内容与节点类型不符。');
    if (scope && file.key_id !== scope)
      throw new AppError(409, '目标位置已加密，请刷新后重新上传。', 'ENCRYPTION_CHANGED');
    fileId = file.id;
    if (!suppliedTitle && file.name.trim()) title = file.name.trim();
  }
  const isText = TEXT_KINDS.includes(kind);
  // arXiv papers are public and imported as they are; see docs/encryption.md.
  const sealedBody = isText && !paper ? await deviceBody(env, data, scope) : null;
  const content =
    isText && !sealedBody ? textValue(data.content ?? '', '正文', 1_048_576, true) : '';
  const assets = paper
    ? paper.assets
    : isText
      ? attachmentIds(content, data.attachments ?? [])
      : [];
  const blob = paper
      ? await storePaper(env, paper.html)
      : isText
        ? (sealedBody ?? (await storeText(env, content, scope)))
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
  if (book) statements.push(insertBook(env, id, book));
  if (project) statements.push(...insertProject(env, id, now));
  if (reference)
    statements.push(
      env.DB.prepare('INSERT INTO node_references(node_id,target_id) VALUES(?,?)').bind(
        id,
        reference.id,
      ),
    );
  if (extra) statements.push(...extra(id, now));
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
      ...(kind === 'markdown'
        ? [
            sealedBody
              ? sealedMetadataStatement(env, id, version, data.metadata, scope!)
              : await metadataStatement(env, id, version, content, scope),
          ]
        : []),
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
// A body sealed on the device: the note's key must match, so plain text never
// lands in an encrypted folder (and sealed text never in a plain one).
async function deviceBody(env: Env, data: Record<string, unknown>, scope: string | null) {
  if (data.bodyBlobId === undefined) {
    // Features that write on the Worker carry the key; plain writes from a
    // device that missed the setting are refused so it can seal and retry.
    if (scope && !hasKey(env, scope))
      throw env.KEYS
        ? locked()
        : new AppError(409, '这个位置已加密，请刷新后重试。', 'ENCRYPTION_CHANGED');
    return null;
  }
  const blob = await getBlob(env, idValue(data.bodyBlobId));
  if (!scope || blob.key_id !== scope)
    throw new AppError(409, '这个位置的加密设置已变化，请刷新后重试。', 'ENCRYPTION_CHANGED');
  if (blob.size > sealedSize(MAX_TEXT_BYTES))
    throw new AppError(413, '单篇正文最多 1 MiB，请拆分为多个子笔记。');
  return blob;
}
export async function saveNote(
  env: Env,
  id: string,
  data: Record<string, unknown>,
  key: string,
  // Restoring a version reuses its body; a sealed one has no text here.
  reuse?: { bodyId: string; sealed: boolean },
): Promise<NoteNode> {
  const previous = await priorOperation(env, key, `save:${id}`);
  if (previous) return previous;
  const node = await getNode(env, id),
    revision = integer(data.revision, '版本号');
  if (!TEXT_KINDS.includes(node.kind)) throw new AppError(400, '只有文本笔记可以编辑正文。');
  if (node.revision !== revision)
    throw new AppError(409, '这篇笔记已在其他页面更新，当前编辑内容已保留。', 'VERSION_CONFLICT');
  const scope = node.key_id ?? null;
  const sealedBody = reuse ? null : await deviceBody(env, data, scope);
  const known = !sealedBody && !reuse?.sealed;
  const content = known ? textValue(data.content, '正文', 1_048_576, true) : '',
    assets = attachmentIds(content, data.attachments ?? []);
  const current = await env.DB.prepare(
    'SELECT body_blob_id,key_id FROM versions v JOIN blobs b ON b.id=v.body_blob_id WHERE v.id=?',
  )
    .bind(node.current_version_id)
    .first<{ body_blob_id: string; key_id: string | null }>();
  const oldAssets = (await attachments(env, node.current_version_id)).map((x) => x.id).sort();
  // Text is compared only when this request can read both sides.
  const unchangedBody =
    !!current &&
    (current.body_blob_id === (reuse?.bodyId ?? sealedBody?.id) ||
      (known &&
        current.key_id === scope &&
        (!current.key_id || hasKey(env, current.key_id)) &&
        content === (await readText(env, current.body_blob_id))));
  if (unchangedBody && JSON.stringify(assets) === JSON.stringify(oldAssets)) return node;
  const fresh = reuse || sealedBody || unchangedBody ? null : await storeText(env, content, scope),
    bodyId = reuse?.bodyId ?? sealedBody?.id ?? (unchangedBody ? current!.body_blob_id : fresh!.id);
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
      // A restored sealed version leaves its summary to be rebuilt when read.
      ...(node.kind === 'markdown' && !reuse?.sealed
        ? [
            sealedBody
              ? sealedMetadataStatement(env, id, version, data.metadata, scope!)
              : await metadataStatement(env, id, version, content, scope),
          ]
        : []),
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
  if (moving && parent && (await getNode(env, parent)).variant === 'reference')
    throw new AppError(400, '不能移入引用，请打开原目录后再移动。');
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
): Promise<{ content: string; sealed?: string; attachments: FileInfo[]; bodyId: string }> {
  await getNode(env, id);
  const row = await env.DB.prepare('SELECT body_blob_id FROM versions WHERE id=? AND node_id=?')
    .bind(idValue(version), id)
    .first<{ body_blob_id: string }>();
  if (!row) throw new AppError(404, '这个历史版本已超出保留数量。');
  return {
    ...(await readBody(env, row.body_blob_id)),
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
    { bodyId: detail.bodyId, sealed: !!detail.sealed },
  );
}
