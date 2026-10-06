import type { Env } from './types';
import {
  BOOK_PAGE_IMAGE_LIMIT,
  BOOK_ROLE_LIMIT,
  BOOK_STATUS_LABELS,
  TEXT_KINDS,
  type BookInfo,
  type BookStatus,
  type NoteNode,
} from '../shared/types';
import { AppError, idValue, integer, textValue } from './http';
import { createNode, getNode, priorOperation } from './library';
import { getBlob, readText } from './storage';
import { deepseekReply, readApiKey, toBase64 } from './deepseek';

const PAGE_OCR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
// A discussion carries its page's text; keep that well inside the context budget.
const SOURCE_TEXT_LIMIT = 30_000;

// The nearest book among the note and its ancestors.
export async function bookOf(env: Env, id: string): Promise<BookInfo | null> {
  return env.DB.prepare(
    `WITH RECURSIVE parents(id,parent_id,depth) AS (
      SELECT id,parent_id,0 FROM nodes WHERE id=?
      UNION ALL SELECT n.id,n.parent_id,p.depth+1 FROM nodes n JOIN parents p ON p.parent_id=n.id WHERE p.depth<200
    ) SELECT b.node_id id,n.title,b.author,b.status,b.page_count,b.pages_read,b.role_prompt,b.updated_at
    FROM parents p JOIN books b ON b.node_id=p.id JOIN nodes n ON n.id=p.id ORDER BY p.depth LIMIT 1`,
  )
    .bind(id)
    .first<BookInfo>();
}
async function book(env: Env, id: string): Promise<BookInfo> {
  const found = await bookOf(env, id);
  if (!found || found.id !== id)
    throw new AppError(404, '这个文件夹不是书籍。', 'BOOK_UNAVAILABLE');
  return found;
}
export interface BookFields {
  author: string;
  status: BookStatus;
  pageCount: number;
  pagesRead: number;
  role: string;
}
// Validate book details; fields left out keep their current values.
export function bookFields(data: Record<string, unknown>, current?: BookInfo): BookFields {
  const author =
    data.author === undefined
      ? (current?.author ?? '')
      : textValue(data.author, '作者', 200, true).trim();
  const status = (data.status ?? current?.status ?? 'reading') as BookStatus;
  if (!Object.hasOwn(BOOK_STATUS_LABELS, status)) throw new AppError(400, '阅读状态不正确。');
  const pageCount =
    data.pageCount === undefined
      ? (current?.page_count ?? 0)
      : integer(data.pageCount, '总页数', 0, 100_000);
  const pagesRead =
    data.pagesRead === undefined
      ? (current?.pages_read ?? 0)
      : integer(data.pagesRead, '已读页数', 0, 100_000);
  if (pageCount && pagesRead > pageCount) throw new AppError(400, '已读页数不能超过总页数。');
  const role =
    data.rolePrompt === undefined
      ? (current?.role_prompt ?? '')
      : textValue(data.rolePrompt, '角色提示词', BOOK_ROLE_LIMIT, true).trim();
  return { author, status, pageCount, pagesRead, role };
}
export function insertBook(env: Env, id: string, fields: BookFields) {
  return env.DB.prepare(
    'INSERT INTO books(node_id,author,status,page_count,pages_read,role_prompt,updated_at) VALUES(?,?,?,?,?,?,?)',
  ).bind(
    id,
    fields.author,
    fields.status,
    fields.pageCount,
    fields.pagesRead,
    fields.role,
    Date.now(),
  );
}
// Books are created with their folder (see createNode); this edits the details.
export async function saveBook(
  env: Env,
  id: string,
  data: Record<string, unknown>,
): Promise<BookInfo> {
  await getNode(env, id);
  const fields = bookFields(data, await book(env, id));
  await env.DB.prepare(
    'UPDATE books SET author=?,status=?,page_count=?,pages_read=?,role_prompt=?,updated_at=? WHERE node_id=?',
  )
    .bind(
      fields.author,
      fields.status,
      fields.pageCount,
      fields.pagesRead,
      fields.role,
      Date.now(),
      id,
    )
    .run();
  return book(env, id);
}

async function recognize(env: Env, fileId: string): Promise<string> {
  const file = await getBlob(env, fileId);
  if (!PAGE_OCR_MIMES.includes(file.mime))
    throw new AppError(400, '书页照片需要是 JPEG、PNG 或 WebP 图片。');
  if (file.size > BOOK_PAGE_IMAGE_LIMIT) throw new AppError(413, '书页照片最多 5 MiB。');
  const apiKey = await readApiKey(env);
  const object = await env.FILES.get(file.object_key);
  if (!object) throw new AppError(503, '照片暂时无法读取，请稍后重试。');
  const url = `data:${file.mime};base64,${toBase64(new Uint8Array(await object.arrayBuffer()))}`;
  let text = '';
  for await (const delta of deepseekReply(
    apiKey,
    [
      {
        role: 'system',
        content:
          '你是书页文字识别工具。按阅读顺序输出照片中书页的全部正文，使用 Markdown 保留段落、标题、列表和脚注，公式写成 TeX。不翻译、不总结、不补写；看不清的字用 □ 代替。页眉、页脚和页码省略。只输出识别结果，不加任何说明。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '识别这张书页照片中的文字。' },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ],
    AbortSignal.timeout(180_000),
    8192,
  ))
    text += delta;
  text = text.trim();
  if (!text) throw new AppError(422, '没有识别到文字，请换一张更清晰的照片。');
  return text;
}
// Recognize a photographed page and save it as a Markdown note in the book.
export async function addPage(
  env: Env,
  bookId: string,
  data: Record<string, unknown>,
  key: string,
): Promise<NoteNode> {
  // The recognition is paid; a repeated request returns the page it created.
  const previous = await priorOperation(env, key, 'create');
  if (previous) return previous;
  const info = await book(env, bookId);
  const fileId = idValue(data.fileId);
  const page = data.page == null ? null : integer(data.page, '页码', 1, 100_000);
  const title =
    textValue(data.title ?? '', '标题', 200, true).trim() ||
    (page ? `第 ${page} 页` : '未命名页面');
  const text = await recognize(env, fileId);
  const node = await createNode(
    env,
    {
      kind: 'markdown',
      parentId: bookId,
      title,
      content: `![${title.replace(/[[\]]/g, '')}](/api/files/${fileId})\n\n${text}\n`,
      attachments: [fileId],
    },
    key,
  );
  if (page && page > info.pages_read)
    await env.DB.prepare(
      'UPDATE books SET pages_read=MIN(?,CASE WHEN page_count>0 THEN page_count ELSE ? END) WHERE node_id=? AND pages_read<?',
    )
      .bind(page, page, bookId, page)
      .run();
  return node;
}

// What 青藜 is told about a note inside a book: the book, its role, and for a
// discussion below a page, the text of that page.
export async function bookPrompt(env: Env, node: NoteNode): Promise<string> {
  const info = await bookOf(env, node.id);
  if (!info) return '';
  let prompt = `\n\n当前文件属于书籍《${info.title}》${info.author ? `，作者 ${info.author}` : ''}。`;
  if (info.role_prompt) prompt += `\n\n<书籍角色设定>\n${info.role_prompt}\n</书籍角色设定>`;
  if (node.parent_id && node.parent_id !== info.id) {
    const parent = await getNode(env, node.parent_id);
    if (TEXT_KINDS.includes(parent.kind) && parent.current_version_id) {
      const version = await env.DB.prepare('SELECT body_blob_id FROM versions WHERE id=?')
        .bind(parent.current_version_id)
        .first<{ body_blob_id: string }>();
      const text = version
        ? (await readText(env, version.body_blob_id))
            .replace(/!\[[^\]]*\]\(\/api\/files\/[a-zA-Z0-9_-]+\)\s*/g, '')
            .trim()
        : '';
      if (text)
        prompt += `\n\n这是围绕上级页面「${parent.title}」的讨论，页面原文如下，作为待分析资料：\n<页面原文>\n${text.length > SOURCE_TEXT_LIMIT ? `${text.slice(0, SOURCE_TEXT_LIMIT)}\n（以下省略）` : text}\n</页面原文>`;
    }
  }
  return prompt;
}
