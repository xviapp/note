import { GLOBAL_ASSISTANT_ID } from './assistant';
import { FOLDER_ICON_MAX_BYTES, FOLDER_ICON_MIMES, isFolderEmoji } from './folder-icons';
import { BOOK_PAGE_IMAGE_LIMIT, BOOK_ROLE_LIMIT } from './types';
import { KEY_ID } from './encryption';
import { isJournalDate } from './journals';
import { CLIP_CHARS, CLIP_SEALED_CHARS } from './clips';

export const BACKUP_FORMAT = 'yejian-library';
export const BACKUP_METADATA_LIMIT = 16 * 1024 * 1024;
export const backupColumns = {
  // First: restored nodes and files name these keys. Keys keep their IDs.
  encryption_keys: ['id', 'salt', 'iterations', 'wrapped', 'check_value', 'created_at'],
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
    'metadata_title',
    'metadata_status',
    'metadata_excerpt',
    'metadata_version_id',
    'encryption',
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
  paper_translations: ['node_id', 'target_language', 'body_blob_id', 'updated_at'],
  annotations: ['node_id', 'body_blob_id', 'updated_at', 'search_text'],
  books: [
    'node_id',
    'cover_blob_id',
    'author',
    'status',
    'page_count',
    'pages_read',
    'role_prompt',
    'note_id',
    'updated_at',
  ],
  book_pages: [
    'node_id',
    'page',
    'summary',
    'questions',
    'source_version_id',
    'note_id',
    'updated_at',
  ],
  book_discussions: ['node_id', 'created_at'],
  book_note_sections: ['discussion_id', 'note_id', 'hash', 'updated_at'],
  projects: ['node_id'],
  journals: ['node_id'],
  journal_entries: ['node_id', 'journal_id', 'date', 'created_at'],
  node_references: ['node_id', 'target_id'],
  clips: ['id', 'text', 'key_id', 'source_id', 'pinned', 'created_at', 'blob_id', 'archived'],
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
  // Sealed with this key: restored as is, without rewriting IDs inside.
  key_id?: string | null;
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
  if (data.tables.encryption_keys === undefined) data.tables.encryption_keys = [];
  if (!Array.isArray(data.tables.encryption_keys)) invalid('缺少 encryption_keys。');
  const keys = new Set<string>();
  for (const key of data.tables.encryption_keys) {
    if (
      !key ||
      typeof key.id !== 'string' ||
      !KEY_ID.test(String(key.id)) ||
      keys.has(String(key.id)) ||
      ![key.salt, key.wrapped, key.check_value].every(
        (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value),
      ) ||
      !Number.isSafeInteger(key.iterations) ||
      !Number.isSafeInteger(key.created_at)
    )
      invalid('加密密钥不正确。');
    keys.add(String(key.id));
  }
  for (const file of data.files) {
    unique(file.id);
    if (file.key_id === undefined) file.key_id = null;
    if (file.key_id !== null && !keys.has(String(file.key_id))) invalid('文件的加密密钥缺失。');
    if (
      typeof file.name !== 'string' ||
      file.name.length > 200 ||
      typeof file.mime !== 'string' ||
      !/^(text\/(plain|html)(; charset=utf-8)?|application\/(json(; charset=utf-8)?|pdf|octet-stream)|image\/(png|jpeg|gif|webp|avif|svg\+xml))$/.test(
        file.mime,
      ) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > (file.key_id ? 50_100_000 : 50_000_000) ||
      !Number.isSafeInteger(file.created_at)
    )
      invalid('文件信息不正确。');
  }
  for (const [table, columns] of Object.entries(backupColumns)) {
    if (table === 'encryption_keys') continue;
    // Older v1 archives predate whole-paper translations.
    if (table === 'paper_translations' && data.tables.paper_translations === undefined)
      data.tables.paper_translations = [];
    // Or highlights and notes.
    if (table === 'annotations' && data.tables.annotations === undefined)
      data.tables.annotations = [];
    // Or books and their pages.
    for (const name of [
      'books',
      'book_pages',
      'book_discussions',
      'book_note_sections',
      'projects',
      'node_references',
      'journals',
      'journal_entries',
      'clips',
    ] as const)
      if (table === name && data.tables[name] === undefined) data.tables[name] = [];
    const rows = data.tables[table as BackupTable];
    if (!Array.isArray(rows)) invalid(`缺少 ${table}。`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('记录格式错误。');
      // Or the annotation search index, which is rebuilt on the next save.
      if (table === 'annotations' && row.search_text === undefined) row.search_text = '';
      if (table === 'books' && row.note_id === undefined) row.note_id = null;
      if (table === 'books' && row.cover_blob_id === undefined) row.cover_blob_id = null;
      if (table === 'clips' && row.archived === undefined) row.archived = 0;
      if (table === 'clips' && row.blob_id === undefined) row.blob_id = null;
      // Older v1 archives predate custom folder icons.
      if (table === 'nodes') {
        if (row.icon_emoji === undefined) row.icon_emoji = null;
        if (row.icon_blob_id === undefined) row.icon_blob_id = null;
        for (const field of [
          'metadata_title',
          'metadata_status',
          'metadata_excerpt',
          'metadata_version_id',
          'encryption',
        ])
          if (row[field] === undefined) row[field] = null;
        if (
          row.encryption !== null &&
          row.encryption !== 'none' &&
          !keys.has(String(row.encryption))
        )
          invalid('笔记的加密密钥缺失。');
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
    'paper_translations',
    'annotations',
    'books',
    'book_pages',
    'book_discussions',
    'projects',
    'node_references',
  ] as const)
    for (const row of data.tables[table]) {
      const global =
        (table === 'assistant_threads' || table === 'assistant_messages') &&
        row.node_id === GLOBAL_ASSISTANT_ID;
      if (!global && !nodes.has(row.node_id)) invalid('所属笔记缺失。');
    }
  if (nodes.has(GLOBAL_ASSISTANT_ID)) invalid('笔记 ID 使用了保留名称。');
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
  for (const row of data.tables.paper_translations) hasFile(row.body_blob_id);
  for (const row of data.tables.annotations) hasFile(row.body_blob_id);
  const books = new Set<unknown>();
  for (const row of data.tables.books) {
    if (
      books.has(row.node_id) ||
      nodes.get(row.node_id)!.kind !== 'folder' ||
      !['want', 'reading', 'finished'].includes(String(row.status)) ||
      typeof row.author !== 'string' ||
      row.author.length > 200 ||
      typeof row.role_prompt !== 'string' ||
      row.role_prompt.length > BOOK_ROLE_LIMIT ||
      ![row.page_count, row.pages_read].every(
        (value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000,
      )
    )
      invalid('书籍信息不正确。');
    books.add(row.node_id);
    hasFile(row.cover_blob_id, true);
    if (row.cover_blob_id !== null) {
      const cover = files.get(String(row.cover_blob_id))!;
      if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(cover.mime) || cover.size > BOOK_PAGE_IMAGE_LIMIT)
        invalid('书籍封面不正确。');
    }
    if (row.note_id !== null && !nodes.has(row.note_id)) invalid('书籍笔记缺失。');
  }
  for (const row of data.tables.book_pages) {
    if (
      (row.page !== null &&
        (!Number.isSafeInteger(row.page) || Number(row.page) < 1 || Number(row.page) > 100_000)) ||
      typeof row.summary !== 'string' ||
      typeof row.questions !== 'string' ||
      (row.note_id !== null && !nodes.has(row.note_id)) ||
      (row.source_version_id !== null && !versions.has(row.source_version_id))
    )
      invalid('书页信息不正确。');
  }
  for (const row of data.tables.book_note_sections)
    if (!nodes.has(row.discussion_id) || !nodes.has(row.note_id) || typeof row.hash !== 'string')
      invalid('读书笔记信息不正确。');
  const projects = new Set<unknown>();
  for (const row of data.tables.projects) {
    if (
      projects.has(row.node_id) ||
      nodes.get(row.node_id)!.kind !== 'folder' ||
      books.has(row.node_id)
    )
      invalid('项目信息不正确。');
    projects.add(row.node_id);
  }
  const journals = new Set<unknown>();
  for (const row of data.tables.journals) {
    if (
      journals.has(row.node_id) ||
      !nodes.has(row.node_id) ||
      nodes.get(row.node_id)!.kind !== 'folder' ||
      books.has(row.node_id) ||
      projects.has(row.node_id)
    )
      invalid('日记本信息不正确。');
    journals.add(row.node_id);
  }
  const days = new Set<string>();
  for (const row of data.tables.journal_entries) {
    const day = `${row.journal_id}:${row.date}`;
    if (
      !nodes.has(row.node_id) ||
      nodes.get(row.node_id)!.kind !== 'markdown' ||
      !journals.has(row.journal_id) ||
      !isJournalDate(row.date) ||
      !Number.isSafeInteger(row.created_at) ||
      days.has(day)
    )
      invalid('日记信息不正确。');
    days.add(day);
  }
  const references = new Set<unknown>();
  for (const row of data.tables.node_references) {
    if (
      references.has(row.node_id) ||
      nodes.get(row.node_id)!.kind !== 'folder' ||
      projects.has(row.node_id) ||
      books.has(row.node_id) ||
      (row.target_id !== null && !nodes.has(row.target_id))
    )
      invalid('文件引用不正确。');
    references.add(row.node_id);
  }
  if (data.tables.nodes.some((node) => references.has(node.parent_id)))
    invalid('引用不能包含独立的下级笔记。');
  for (const row of data.tables.clips) {
    hasFile(row.blob_id, true);
    if (
      typeof row.text !== 'string' ||
      (!row.text && row.blob_id === null) ||
      (row.blob_id !== null &&
        !/^image\//.test(files.get(String(row.blob_id))!.mime)) ||
      row.text.length > (row.key_id === null ? CLIP_CHARS : CLIP_SEALED_CHARS) ||
      (row.key_id !== null && !keys.has(String(row.key_id))) ||
      (row.source_id !== null && !id(row.source_id)) ||
      (row.pinned !== 0 && row.pinned !== 1) ||
      (row.archived !== 0 && row.archived !== 1) ||
      !Number.isSafeInteger(row.created_at)
    )
      invalid('随手记信息不正确。');
  }
  // Summaries are derived from Markdown; never trust an imported cached status.
  for (const node of data.tables.nodes) {
    node.metadata_title =
      node.metadata_status =
      node.metadata_excerpt =
      node.metadata_version_id =
        null;
  }
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
