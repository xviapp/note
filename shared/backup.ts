import { FOLDER_ICON_MAX_BYTES, FOLDER_ICON_MIMES, isFolderEmoji } from './folder-icons';

export const BACKUP_FORMAT = 'yejian-library';
export const BACKUP_METADATA_LIMIT = 16 * 1024 * 1024;
export const backupColumns = {
  nodes: [
    'id',
    'parent_id',
    'kind',
    'title',
    'position',
    'url',
    'arxiv_id',
    'file_blob_id',
    'icon_emoji',
    'icon_blob_id',
    'current_version_id',
    'revision',
    'trash_id',
    'created_at',
    'updated_at',
  ],
  versions: ['id', 'node_id', 'sequence', 'body_blob_id', 'created_at'],
  version_assets: ['version_id', 'blob_id'],
  favorites: ['node_id', 'created_at'],
  reading_states: ['node_id', 'position', 'version', 'last_opened_at', 'updated_at'],
  assistant_threads: ['node_id'],
  assistant_messages: [
    'sequence',
    'id',
    'node_id',
    'request_id',
    'role',
    'status',
    'body_blob_id',
    'image_blob_id',
    'exported_node_id',
    'error',
    'created_at',
  ],
  assistant_message_files: ['message_id', 'blob_id'],
  translations: [
    'id',
    'node_id',
    'source_hash',
    'target_language',
    'excerpt',
    'location_label',
    'body_blob_id',
    'updated_at',
  ],
  trash_batches: [
    'id',
    'root_id',
    'title',
    'original_parent_id',
    'expected_count',
    'deleted_at',
    'expires_at',
    'purging',
  ],
} as const;
export type BackupTable = keyof typeof backupColumns;
export type BackupRow = Record<string, string | number | null>;
export interface BackupFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  created_at: number;
}
export interface LibraryBackup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: number;
  tables: Record<BackupTable, BackupRow[]>;
  files: BackupFile[];
}
const invalid = (detail: string): never => {
  throw new Error(`备份无效：${detail}`);
};
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function orderBackupNodes(nodes: BackupRow[]) {
  const map = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | number | null, BackupRow[]>();
  const queue: BackupRow[] = [];
  for (const node of nodes) {
    if (node.parent_id === null) queue.push(node);
    else {
      if (!map.has(node.parent_id)) invalid('上级节点缺失。');
      const siblings = children.get(node.parent_id);
      if (siblings) siblings.push(node);
      else children.set(node.parent_id, [node]);
    }
  }
  for (let i = 0; i < queue.length; i++) queue.push(...(children.get(queue[i].id) || []));
  if (queue.length !== nodes.length) invalid('目录存在循环。');
  return queue;
}
export function validateBackup(input: unknown): LibraryBackup {
  if (!input || typeof input !== 'object') invalid('缺少清单。');
  const data = input as LibraryBackup;
  if (data.format !== BACKUP_FORMAT || data.version !== 1 || !Number.isSafeInteger(data.createdAt))
    invalid('格式或版本不支持。');
  if (!data.tables || !Array.isArray(data.files)) invalid('缺少文件或目录。');
  if (new TextEncoder().encode(JSON.stringify(data)).length > BACKUP_METADATA_LIMIT)
    invalid('目录清单超过 16 MiB。');
  const globalIds = new Set<string>();
  const unique = (value: unknown) => {
    if (!id(value) || globalIds.has(value)) invalid('标识缺失或重复。');
    globalIds.add(value as string);
  };
  for (const file of data.files) {
    unique(file.id);
    if (
      typeof file.name !== 'string' ||
      file.name.length > 200 ||
      typeof file.mime !== 'string' ||
      !/^(text\/(plain|html)(; charset=utf-8)?|application\/(json(; charset=utf-8)?|pdf|octet-stream)|image\/(png|jpeg|gif|webp|avif|svg\+xml))$/.test(
        file.mime,
      ) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 50_000_000 ||
      !Number.isSafeInteger(file.created_at)
    )
      invalid('文件信息不正确。');
  }
  for (const [table, columns] of Object.entries(backupColumns)) {
    const rows = data.tables[table as BackupTable];
    if (!Array.isArray(rows)) invalid(`缺少 ${table}。`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('记录格式错误。');
      // Older v1 archives predate custom folder icons.
      if (table === 'nodes') {
        if (row.icon_emoji === undefined) row.icon_emoji = null;
        if (row.icon_blob_id === undefined) row.icon_blob_id = null;
      }
      for (const column of columns) {
        const value = row[column];
        if (
          value !== null &&
          typeof value !== 'string' &&
          !(typeof value === 'number' && Number.isFinite(value))
        )
          invalid('记录字段缺失。');
      }
      if (columns.some((column) => column === 'id')) unique(row.id);
    }
  }
  const nodes = new Map(data.tables.nodes.map((n) => [n.id, n]));
  const files = new Map(data.files.map((f) => [f.id, f]));
  const versions = new Map(data.tables.versions.map((v) => [v.id, v]));
  const messages = new Map(data.tables.assistant_messages.map((m) => [m.id, m]));
  const hasFile = (value: unknown, nullable = false) => {
    if (nullable && value === null) return;
    if (!id(value) || !files.has(value)) invalid('文件引用缺失。');
  };
  for (const node of data.tables.nodes) {
    if (
      !['folder', 'markdown', 'text', 'pdf', 'image', 'link'].includes(String(node.kind)) ||
      typeof node.title !== 'string' ||
      !node.title.trim() ||
      node.title.length > 200 ||
      !Number.isSafeInteger(node.revision) ||
      Number(node.revision) < 0 ||
      typeof node.position !== 'number'
    )
      invalid('笔记信息不正确。');
    if (node.url !== null) {
      let url: URL;
      try {
        url = new URL(String(node.url));
      } catch {
        return invalid('网页地址错误。');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        invalid('网页地址错误。');
    }
    if (
      (node.kind === 'link' && !node.url) ||
      (node.arxiv_id !== null && (node.kind !== 'link' || typeof node.arxiv_id !== 'string'))
    )
      invalid('论文信息不正确。');
    hasFile(node.file_blob_id, !['pdf', 'image'].includes(String(node.kind)));
    if (node.kind === 'pdf' && files.get(String(node.file_blob_id))?.mime !== 'application/pdf')
      invalid('PDF 类型不正确。');
    if (node.kind === 'image' && !files.get(String(node.file_blob_id))?.mime.startsWith('image/'))
      invalid('图片类型不正确。');
    hasFile(node.icon_blob_id, true);
    if (
      (node.kind !== 'folder' && (node.icon_emoji !== null || node.icon_blob_id !== null)) ||
      (node.icon_emoji !== null && (!isFolderEmoji(node.icon_emoji) || node.icon_blob_id !== null))
    )
      invalid('文件夹图标不正确。');
    if (node.icon_blob_id !== null) {
      const icon = files.get(String(node.icon_blob_id))!;
      if (!FOLDER_ICON_MIMES.includes(icon.mime) || icon.size > FOLDER_ICON_MAX_BYTES)
        invalid('文件夹图标图片不正确。');
    }
    if (
      node.current_version_id !== null &&
      versions.get(node.current_version_id)?.node_id !== node.id
    )
      invalid('正文版本缺失。');
  }
  orderBackupNodes(data.tables.nodes);
  for (const table of [
    'versions',
    'favorites',
    'reading_states',
    'assistant_threads',
    'assistant_messages',
    'translations',
  ] as const)
    for (const row of data.tables[table]) if (!nodes.has(row.node_id)) invalid('所属笔记缺失。');
  for (const version of data.tables.versions) {
    hasFile(version.body_blob_id);
    if (
      !Number.isSafeInteger(version.sequence) ||
      Number(version.sequence) < 1 ||
      Number(version.sequence) > Number(nodes.get(version.node_id)!.revision)
    )
      invalid('历史版本不正确。');
  }
  for (const asset of data.tables.version_assets) {
    if (!versions.has(asset.version_id)) invalid('附件所属版本缺失。');
    hasFile(asset.blob_id);
  }
  for (const row of data.tables.assistant_messages) {
    hasFile(row.body_blob_id, true);
    hasFile(row.image_blob_id, true);
    if (
      !['user', 'assistant'].includes(String(row.role)) ||
      !['pending', 'completed', 'interrupted', 'failed'].includes(String(row.status))
    )
      invalid('对话信息不正确。');
  }
  for (const row of data.tables.assistant_message_files) {
    if (!messages.has(row.message_id)) invalid('附件所属对话缺失。');
    hasFile(row.blob_id);
  }
  for (const row of data.tables.translations) hasFile(row.body_blob_id, true);
  for (const row of data.tables.reading_states) {
    try {
      if (
        typeof row.position !== 'string' ||
        row.position.length > 8192 ||
        !Number.isSafeInteger(row.version) ||
        Number(row.version) < 0
      )
        invalid('阅读位置不正确。');
      const position = JSON.parse(String(row.position));
      if (!position || typeof position !== 'object' || Array.isArray(position))
        invalid('阅读位置不正确。');
      for (const key of ['ratio', 'headingRatio', 'pageRatio']) {
        const value = position[key];
        if (
          value !== undefined &&
          (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
        )
          invalid('阅读位置不正确。');
      }
      if (
        position.heading !== undefined &&
        (typeof position.heading !== 'string' || position.heading.length > 300)
      )
        invalid('阅读标题不正确。');
      if (
        position.page !== undefined &&
        (!Number.isSafeInteger(position.page) || position.page < 1 || position.page > 100000)
      )
        invalid('PDF 页码不正确。');
    } catch {
      invalid('阅读位置不正确。');
    }
  }
  return data;
}

export function rewriteBackupText(text: string, mapping: Record<string, string>): string {
  const mapped = (value: string) => (Object.hasOwn(mapping, value) ? mapping[value] : value);
  const links = (value: string) =>
    value.replace(
      /(\/api\/files\/|\/n\/)([a-zA-Z0-9_-]{1,80})/g,
      (_all, prefix: string, value: string) => prefix + mapped(value),
    );
  const heading = (value: string) =>
    value.replace(/paper-([a-zA-Z0-9_-]+)/g, (all, rest: string) => {
      // PaperView namespaces heading IDs with the owning node ID on each render.
      for (let end = rest.lastIndexOf('-'); end > 0; end = rest.lastIndexOf('-', end - 1))
        if (Object.hasOwn(mapping, rest.slice(0, end)))
          return `paper-${mapping[rest.slice(0, end)]}${rest.slice(end)}`;
      return all;
    });
  try {
    JSON.parse(text);
    // Replace only changed string tokens. A plain-text note containing formatted
    // JSON must keep its whitespace, number spelling and untouched escapes.
    let key = '';
    return text.replace(/("(?:[^"\\]|\\.)*")(\s*:)?/g, (token, encoded: string, colon?: string) => {
      const value = JSON.parse(encoded) as string;
      if (colon) {
        key = value;
        return token;
      }
      const next = key === 'heading' ? heading(value) : links(mapped(value));
      key = '';
      return next === value ? encoded : JSON.stringify(next);
    });
  } catch {
    return links(text);
  }
}
