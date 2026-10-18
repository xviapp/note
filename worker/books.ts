import type { Env } from './types';
import {
  BOOK_PAGE_IMAGE_LIMIT,
  BOOK_QUESTION_LIMIT,
  BOOK_ROLE_LIMIT,
  BOOK_STATUS_LABELS,
  BOOK_SUMMARY_LIMIT,
  TEXT_KINDS,
  type BookDiscussion,
  type BookInfo,
  type BookPageInfo,
  type BookPages,
  type BookStatus,
  type NoteNode,
} from '../shared/types';
import { AppError, idValue, integer, textValue } from './http';
import {
  createNode,
  getNode,
  NODE_COLUMNS,
  plainDetail,
  priorOperation,
  saveNote,
} from './library';
import { discardFile, getBlob, readBytes, readText } from './storage';
import { openFor, requireKey, sealFor } from './encryption';
import { deepseekReply, readApiKey, toBase64, type ProviderMessage } from './deepseek';
import { chatHistory } from './assistant';

const PAGE_OCR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
// A discussion carries its page's text; keep that well inside the context budget.
const SOURCE_TEXT_LIMIT = 30_000;
const TRANSCRIPT_LIMIT = 40_000;
const NOTE_HEADER = '> 由青藜整理本页的讨论，可自由修改；同一讨论再次整理会更新对应的一节。';

// The nearest book among the note and its ancestors.
export async function bookOf(env: Env, id: string): Promise<BookInfo | null> {
  return env.DB.prepare(
    `WITH RECURSIVE parents(id,parent_id,depth) AS (
      SELECT id,parent_id,0 FROM nodes WHERE id=?
      UNION ALL SELECT n.id,n.parent_id,p.depth+1 FROM nodes n JOIN parents p ON p.parent_id=n.id WHERE p.depth<200
    ) SELECT b.node_id id,n.title,b.author,b.status,b.page_count,b.pages_read,b.role_prompt,b.note_id,b.cover_blob_id,b.updated_at
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
  const [node, current] = await Promise.all([getNode(env, id), book(env, id)]);
  const fields = bookFields(data, current);
  const revision = data.revision === undefined ? node.revision : integer(data.revision, '版本号');
  const title = data.title === undefined ? node.title : textValue(data.title, '书名', 200).trim();
  if (!title) throw new AppError(400, '请输入书名。');
  const cover = data.coverId === undefined ? current.cover_blob_id : data.coverId === null ? null : idValue(data.coverId);
  if (cover) {
    const file = await getBlob(env, cover);
    if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.mime) || file.size > BOOK_PAGE_IMAGE_LIMIT)
      throw new AppError(400, '封面需要使用不超过 5 MiB 的图片。');
    if ((file.key_id ?? null) !== (node.key_id ?? null))
      throw new AppError(400, '封面的加密设置与书籍不同，请重新上传。');
  }
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE books SET author=?,status=?,page_count=?,pages_read=?,role_prompt=?,cover_blob_id=?,updated_at=? WHERE node_id=? AND EXISTS(SELECT 1 FROM nodes WHERE id=? AND revision=? AND trash_id IS NULL)',
    ).bind(
      fields.author,
      fields.status,
      fields.pageCount,
      fields.pagesRead,
      fields.role,
      cover,
      now,
      id,
      id,
      revision,
    ),
    env.DB.prepare('UPDATE nodes SET title=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND trash_id IS NULL RETURNING id')
      .bind(title, now, id, revision),
  ]);
  if (!results[1].results.length)
    throw new AppError(409, '书籍已在其他页面更新，请刷新后重试。', 'VERSION_CONFLICT');
  if (current.cover_blob_id && current.cover_blob_id !== cover)
    await discardFile(env, current.cover_blob_id).catch(() => {});
  return book(env, id);
}

// The text of a note's current version, without its photos.
async function noteText(env: Env, node: NoteNode): Promise<string> {
  if (!TEXT_KINDS.includes(node.kind) || !node.current_version_id) return '';
  const version = await env.DB.prepare('SELECT body_blob_id FROM versions WHERE id=?')
    .bind(node.current_version_id)
    .first<{ body_blob_id: string }>();
  if (!version) return '';
  return (await readText(env, version.body_blob_id))
    .replace(/!\[[^\]]*\]\(\/api\/files\/[a-zA-Z0-9_-]+\)\s*/g, '')
    .trim();
}
const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n（以下省略）` : text;

async function generate(
  env: Env,
  messages: ProviderMessage[],
  maxTokens: number,
  json = false,
): Promise<string> {
  const apiKey = await readApiKey(env);
  let text = '';
  for await (const delta of deepseekReply(
    apiKey,
    messages,
    AbortSignal.timeout(180_000),
    maxTokens,
    json,
  ))
    text += delta;
  return text.trim();
}
async function generateJson(env: Env, system: string, user: string) {
  const text = await generate(
    env,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    4096,
    true,
  );
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Reported below. */
  }
  throw new AppError(502, '青藜的回复格式不正确，请重试。', 'AI_PROVIDER_ERROR');
}
const plain = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

async function recognize(env: Env, fileId: string): Promise<string> {
  const file = await getBlob(env, fileId);
  if (!PAGE_OCR_MIMES.includes(file.mime))
    throw new AppError(400, '书页照片需要是 JPEG、PNG 或 WebP 图片。');
  if (file.size > BOOK_PAGE_IMAGE_LIMIT) throw new AppError(413, '书页照片最多 5 MiB。');
  // Read the key before the photo so an unconfigured service fails at once.
  await readApiKey(env);
  const url = `data:${file.mime};base64,${toBase64(await readBytes(env, file))}`;
  const text = await generate(
    env,
    [
      {
        role: 'system',
        content:
          '你是书页文字识别工具，必须保真。按阅读顺序输出照片中书页的全部正文，使用 Markdown 保留段落、标题、列表和脚注，公式写成 TeX。不翻译、不总结、不改写、不补写，不调换顺序；可以合并因换行断开的句子；看不清的字用 □ 代替。页眉、页脚和页码省略。只输出识别结果，不加任何说明。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '识别这张书页照片中的文字。' },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ],
    8192,
  );
  if (!text) throw new AppError(422, '没有识别到文字，请换一张更清晰的照片。');
  return text;
}
// Add a page to the book: a photo recognized by DeepSeek, or text typed in.
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
  requireKey(env, await getNode(env, bookId));
  const fileId = data.fileId == null ? null : idValue(data.fileId);
  const page = data.page == null ? null : integer(data.page, '页码', 1, 100_000);
  const title =
    textValue(data.title ?? '', '标题', 200, true).trim() ||
    (page ? `第 ${page} 页` : '未命名页面');
  if (!fileId)
    return createPage(env, bookId, info, key, title, page, null, textValue(data.content, '正文', 1_048_576).trim());
  // One recognition per operation: a request with the same key while it runs
  // (or after it ended without a page) does not pay again.
  const claim = `${key}:recognize`;
  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO idempotency(key,operation,created_at) VALUES(?,'recognize-page',?) RETURNING key",
  )
    .bind(claim, Date.now())
    .first();
  if (!claimed) {
    const done = await priorOperation(env, key, 'create');
    if (done) return done;
    throw new AppError(
      409,
      '这一页已在识别，或上次识别没有确认结果。请稍后到书中查看，需要时重新添加。',
      'OPERATION_PENDING',
    );
  }
  try {
    return await createPage(env, bookId, info, key, title, page, fileId, await recognize(env, fileId));
  } catch (error) {
    // It ended with an answer: the same operation may be tried again.
    await env.DB.prepare('DELETE FROM idempotency WHERE key=?').bind(claim).run();
    throw error;
  }
}
async function createPage(
  env: Env,
  bookId: string,
  info: Awaited<ReturnType<typeof book>>,
  key: string,
  title: string,
  page: number | null,
  fileId: string | null,
  text: string,
): Promise<NoteNode> {
  const node = await createNode(
    env,
    {
      kind: 'markdown',
      parentId: bookId,
      title,
      content: fileId
        ? `![${title.replace(/[[\]]/g, '')}](/api/files/${fileId})\n\n${text}\n`
        : `${text}\n`,
      attachments: fileId ? [fileId] : [],
    },
    key,
    undefined,
    (id, now) => [
      env.DB.prepare('INSERT INTO book_pages(node_id,page,updated_at) VALUES(?,?,?)').bind(
        id,
        page,
        now,
      ),
    ],
  );
  if (page && page > info.pages_read)
    await env.DB.prepare(
      'UPDATE books SET pages_read=MIN(?,CASE WHEN page_count>0 THEN page_count ELSE ? END) WHERE node_id=? AND pages_read<?',
    )
      .bind(page, page, bookId, page)
      .run();
  return node;
}

interface PageRow {
  node_id: string;
  page: number | null;
  summary: string;
  questions: string;
  source_version_id: string | null;
  note_id: string | null;
}
async function pageRow(env: Env, id: string): Promise<PageRow | null> {
  return env.DB.prepare(
    `SELECT p.* FROM book_pages p JOIN nodes n ON n.id=p.node_id JOIN books b ON b.node_id=n.parent_id
    WHERE p.node_id=?`,
  )
    .bind(id)
    .first<PageRow>();
}
async function bookPage(env: Env, id: string): Promise<{ node: NoteNode; row: PageRow }> {
  const node = await getNode(env, id);
  const row = await pageRow(env, id);
  if (!row) throw new AppError(404, '这篇笔记不是书页。', 'BOOK_PAGE_UNAVAILABLE');
  return { node, row };
}
// A live note, or null once it was trashed or removed.
async function liveNote(env: Env, id: string | null): Promise<NoteNode | null> {
  if (!id) return null;
  const node = await env.DB.prepare(`SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id=?`)
    .bind(id)
    .first<NoteNode>();
  return node && !node.trash_id ? node : null;
}
// Pages of a book in page order (unnumbered pages after, in tree order).
const PAGE_ORDER = `ORDER BY p.page IS NULL, p.page, n.position, n.id`;

export async function pageInfo(env: Env, node: NoteNode): Promise<BookPageInfo | undefined> {
  const row = await pageRow(env, node.id);
  if (!row) return undefined;
  const [siblings, discussions] = await env.DB.batch<{ id: string } & Record<string, unknown>>([
    env.DB.prepare(
      `SELECT n.id FROM book_pages p JOIN nodes n ON n.id=p.node_id
      WHERE n.parent_id=? AND n.trash_id IS NULL ${PAGE_ORDER}`,
    ).bind(node.parent_id),
    env.DB.prepare(
      `SELECT n.id,n.title,
        (SELECT COUNT(*) FROM assistant_messages m WHERE m.node_id=n.id AND m.role='assistant' AND m.body_blob_id IS NOT NULL) replies,
        EXISTS(SELECT 1 FROM book_note_sections s WHERE s.discussion_id=n.id) noted
      FROM book_discussions d JOIN nodes n ON n.id=d.node_id
      WHERE n.parent_id=? AND n.trash_id IS NULL ORDER BY d.created_at`,
    ).bind(node.id),
  ]);
  const order = siblings.results.map((item) => item.id);
  const index = order.indexOf(node.id);
  let questions: string[] = [];
  try {
    questions = JSON.parse(row.questions);
  } catch {
    /* Treated as none. */
  }
  return {
    page: row.page,
    summary: row.summary,
    questions,
    stale: !row.summary || row.source_version_id !== node.current_version_id,
    note_id: (await liveNote(env, row.note_id))?.id ?? null,
    discussions: discussions.results.map((item) => ({
      id: item.id,
      title: String(item.title),
      replies: Number(item.replies),
      noted: !!item.noted,
    })) satisfies BookDiscussion[],
    prev: index > 0 ? order[index - 1] : null,
    next: index >= 0 && index < order.length - 1 ? order[index + 1] : null,
  };
}

export async function bookPages(env: Env, bookId: string): Promise<BookPages> {
  const info = await book(env, bookId);
  const [pages, others] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT n.id,n.title,p.page,p.summary,p.note_id,
        (SELECT COUNT(*) FROM book_discussions d JOIN nodes c ON c.id=d.node_id WHERE c.parent_id=n.id AND c.trash_id IS NULL) discussions
      FROM book_pages p JOIN nodes n ON n.id=p.node_id
      WHERE n.parent_id=? AND n.trash_id IS NULL ${PAGE_ORDER}`,
    ).bind(bookId),
    env.DB.prepare(
      `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.parent_id=? AND n.trash_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM book_pages p WHERE p.node_id=n.id)
      AND NOT EXISTS(SELECT 1 FROM book_discussions d WHERE d.node_id=n.id)
      ORDER BY n.id=? DESC, n.position, n.id`,
    ).bind(bookId, info.note_id ?? ''),
  ]);
  const notes = new Set(
    (
      await env.DB.prepare(
        `SELECT p.note_id id FROM book_pages p JOIN nodes n ON n.id=p.note_id
        JOIN nodes page ON page.id=p.node_id WHERE page.parent_id=? AND n.trash_id IS NULL`,
      )
        .bind(bookId)
        .all<{ id: string }>()
    ).results.map((item) => item.id),
  );
  return {
    pages: pages.results.map((item) => ({
      id: String(item.id),
      title: String(item.title),
      page: item.page === null ? null : Number(item.page),
      summary: String(item.summary),
      discussions: Number(item.discussions),
      note_id: item.note_id && notes.has(String(item.note_id)) ? String(item.note_id) : null,
    })),
    others: others.results as unknown as NoteNode[],
  };
}

// 青藜's summary of a page and the questions worth asking about it.
export async function pageInsights(env: Env, id: string): Promise<BookPageInfo> {
  const { node } = await bookPage(env, id);
  requireKey(env, node);
  const info = (await bookOf(env, id))!;
  const text = await noteText(env, node);
  if (!text) throw new AppError(400, '这一页还没有文字。');
  const result = await generateJson(
    env,
    '你是一位严谨、平实的阅读伙伴。只根据提供的书籍信息和原文工作；不确定时明确说明。只输出 JSON。',
    `书籍：${info.title}\n作者：${info.author || '未知'}\n阅读角色：${info.role_prompt || '通用阅读伙伴'}\n\n原文（${node.title}）：\n${clip(text, SOURCE_TEXT_LIMIT)}\n\n请返回 {"summary":"不超过180字的纯文本摘要","questions":["3到5个值得追问的问题"]}。questions 必须采用读者向青藜提问的口吻，点击后可直接请青藜回答。围绕本页实际出现的概念、论证、依据或应用提出具体知识问题，不要根据书名猜测未提供的内容，不要询问读者的学习偏好、理解程度或想从哪个方向入手。例如使用“这一概念的物理含义是什么？”或“这里的数学推导与物理解释如何对应？”，不要使用“你更关心数学推导还是物理解释？”或“你希望先厘清哪个概念？”。摘要和问题都不要使用 Markdown、列表、标题或公式。`,
  );
  const summary = plain(result.summary, BOOK_SUMMARY_LIMIT);
  const questions = (Array.isArray(result.questions) ? result.questions : [])
    .map((value) => plain(value, BOOK_QUESTION_LIMIT))
    .filter(Boolean)
    .slice(0, 5);
  if (!summary) throw new AppError(502, '青藜没有给出摘要，请重试。', 'AI_PROVIDER_ERROR');
  await env.DB.prepare(
    'UPDATE book_pages SET summary=?,questions=?,source_version_id=?,updated_at=? WHERE node_id=?',
  )
    .bind(
      await sealFor(env, node.key_id, summary),
      JSON.stringify(await Promise.all(questions.map((text) => sealFor(env, node.key_id, text)))),
      node.current_version_id,
      Date.now(),
      id,
    )
    .run();
  return (await pageInfo(env, await getNode(env, id)))!;
}

// A new discussion below a page: a note whose 青藜 thread is the conversation,
// kept out of the tree.
export async function createDiscussion(
  env: Env,
  pageId: string,
  data: Record<string, unknown>,
  key: string,
): Promise<NoteNode> {
  const previous = await priorOperation(env, key, 'create');
  if (previous) return previous;
  await bookPage(env, pageId);
  const question = textValue(data.title, '问题', 8000).replace(/\s+/g, ' ').trim();
  const title = question.length > 60 ? `${question.slice(0, 60)}…` : question;
  return createNode(
    env,
    { kind: 'markdown', parentId: pageId, title, content: '', attachments: [] },
    key,
    undefined,
    (id, now) => [
      env.DB.prepare('INSERT INTO book_discussions(node_id,created_at) VALUES(?,?)').bind(id, now),
    ],
  );
}
export async function isDiscussion(env: Env, id: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM book_discussions WHERE node_id=?')
    .bind(id)
    .first());
}

const marker = (id: string) => `<!-- discussion:${id} -->`;
// A discussion's section: from its marker to the next one or the end.
function findSection(content: string, id: string) {
  const start = content.indexOf(marker(id));
  if (start < 0) return null;
  const after = content.indexOf('<!-- discussion:', start + marker(id).length);
  const end = after < 0 ? content.length : after;
  return { start, end, text: content.slice(start, end).trim() };
}
async function digest(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim()));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Summarize a discussion into the page's reading note: a new section, or the
// discussion's own section updated in place.
export async function organizeDiscussion(
  env: Env,
  id: string,
  data: Record<string, unknown>,
  key: string,
): Promise<{ note: NoteNode; updated: boolean }> {
  const discussion = await getNode(env, id);
  if (!(await isDiscussion(env, id))) throw new AppError(404, '这不是书页上的讨论。');
  const { node: page, row } = await bookPage(env, discussion.parent_id!);
  const info = (await bookOf(env, page.id))!;
  const history = await chatHistory(env, id, Number.MAX_SAFE_INTEGER);
  const transcript = history.messages
    .filter((message) => message.content.trim() && message.status !== 'pending')
    .map((message) => `${message.role === 'user' ? '读者' : '青藜'}：${message.content.trim()}`)
    .join('\n\n');
  if (!history.messages.some((message) => message.role === 'assistant' && message.content.trim()))
    throw new AppError(400, '讨论还没有回复，暂时无法整理。');
  // Refuse before the paid call when the section was edited by hand since.
  let note = await liveNote(env, row.note_id);
  const current = note ? await plainDetail(env, note.id) : null;
  const found = current ? findSection(current.content, id) : null;
  if (found && data.force !== true) {
    const saved = await env.DB.prepare('SELECT hash FROM book_note_sections WHERE discussion_id=?')
      .bind(id)
      .first<{ hash: string }>();
    if (saved && saved.hash !== (await digest(found.text)))
      throw new AppError(
        409,
        '这一节在读书笔记里修改过，再次整理会替换你的修改。',
        'BOOK_SECTION_EDITED',
      );
  }
  const result = await generateJson(
    env,
    '你负责把一段读书讨论整理成简洁的读书笔记。只根据提供的原文和讨论，不补充讨论中没有的观点。只输出 JSON。',
    `书籍：${info.title}\n页面：${page.title}\n\n页面原文：\n${clip(await noteText(env, page), SOURCE_TEXT_LIMIT)}\n\n讨论：\n${clip(transcript, TRANSCRIPT_LIMIT)}\n\n请返回 {"conclusion":"两三句结论","basis":"支撑结论的原文依据，引用时注明“${page.title}”","other":"另一种理解或仍存疑之处，没有则写“暂无”","next":"还值得追问的问题，没有则写“暂无”"}。每项都是纯文本，不使用 Markdown。`,
  );
  const field = (name: string) => plain(result[name], 1200) || '暂无';
  const section = [
    marker(id),
    `### ${discussion.title}`,
    '',
    `**结论**：${field('conclusion')}`,
    '',
    `**依据**：${field('basis')}`,
    '',
    `**另一种理解 / 存疑**：${field('other')}`,
    '',
    `**还想追问**：${field('next')}`,
  ].join('\n');
  const hash = await digest(section);
  const updated = !!found;
  if (!note || !current) {
    note = await createNode(
      env,
      {
        kind: 'markdown',
        parentId: page.id,
        title: `${page.title} · 读书笔记`,
        content: `${NOTE_HEADER}\n\n${section}\n`,
        attachments: [],
      },
      key,
      undefined,
      (noteId) => [
        env.DB.prepare('UPDATE book_pages SET note_id=?,updated_at=? WHERE node_id=?').bind(
          noteId,
          Date.now(),
          page.id,
        ),
      ],
    );
  } else {
    const detail = current;
    const content = found
      ? `${detail.content.slice(0, found.start)}${section}\n\n${detail.content.slice(found.end).trimStart()}`
      : `${detail.content.trimEnd()}\n\n${section}\n`;
    note = await saveNote(
      env,
      note.id,
      {
        revision: detail.revision,
        content: content.trimEnd() + '\n',
        attachments: detail.attachments.map((file) => file.id),
      },
      key,
    );
  }
  await env.DB.prepare(
    `INSERT INTO book_note_sections(discussion_id,note_id,hash,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(discussion_id) DO UPDATE SET note_id=excluded.note_id,hash=excluded.hash,updated_at=excluded.updated_at`,
  )
    .bind(id, note.id, hash, Date.now())
    .run();
  return { note, updated };
}

// The book's reading note: every page's reading note in page order. No AI.
export async function collectBookNote(
  env: Env,
  bookId: string,
  key: string,
): Promise<{ note: NoteNode; pages: number }> {
  const info = await book(env, bookId);
  const { pages } = await bookPages(env, bookId);
  const parts: string[] = [];
  for (const page of pages) {
    const note = await liveNote(env, page.note_id);
    if (!note) continue;
    const content = (await plainDetail(env, note.id)).content
      .replace(NOTE_HEADER, '')
      .replace(/<!-- discussion:[a-zA-Z0-9_-]+ -->\n?/g, '')
      .trim();
    if (content) parts.push(`## ${page.title}\n\n${content.replace(/^### /gm, '#### ')}`);
  }
  if (!parts.length) throw new AppError(400, '还没有页面读书笔记，先在讨论里点「整理到笔记」。');
  const content = `> 按页码汇总各页的读书笔记，再次汇总会更新这篇。\n\n${parts.join('\n\n')}\n`;
  const existing = await liveNote(env, info.note_id);
  if (existing) {
    const detail = await plainDetail(env, existing.id);
    const note = await saveNote(
      env,
      existing.id,
      { revision: detail.revision, content, attachments: [] },
      key,
    );
    return { note, pages: parts.length };
  }
  const note = await createNode(
    env,
    {
      kind: 'markdown',
      parentId: bookId,
      title: `《${info.title}》读书笔记`,
      content,
      attachments: [],
    },
    key,
    undefined,
    (id) => [env.DB.prepare('UPDATE books SET note_id=? WHERE node_id=?').bind(id, bookId)],
  );
  return { note, pages: parts.length };
}

// A reading guide for one book, written by 青藜 to serve as its role prompt.
export async function generateRolePrompt(env: Env, data: Record<string, unknown>) {
  const title = textValue(data.title, '书名', 200).trim();
  const author = textValue(data.author ?? '', '作者', 200, true).trim();
  const role = textValue(data.role ?? '', '阅读角色', BOOK_ROLE_LIMIT, true).trim();
  const text = await generate(
    env,
    [
      {
        role: 'system',
        content: [
          '你是一位资深的阅读引导专家，专门为一本具体的书写一段“本书专属阅读指引”。这段指引会原样作为 AI 阅读伙伴讨论这本书时的角色设定。',
          '请只输出一段中文指引，并严格遵守：',
          '1. 直接给出指引本身，不要标题、标签、引号、Markdown 或代码块。',
          '2. 用对阅读伙伴说话的口吻（“你是……”“你应……”），而不是对书的客观介绍。',
          '3. 按题材确定阅读角度：文学作品侧重人物、叙事、主题、风格与时代背景；非虚构或学术著作侧重核心论点、论证结构、证据与上下文。',
          '4. 指出这本书值得重点关注的 2 到 3 个方面，并说明回应应有的分寸（如先证据后观点、鼓励批判性追问）。',
          '5. 只使用给出的信息，不编造作者、年代、事件或书评；信息不足时保持通用但贴近已知事实。',
          '6. 控制在 80 到 160 个汉字。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `书名：${title}\n作者：${author || '未知'}\n已选阅读角色：${role || '通用阅读伙伴'}`,
      },
    ],
    1024,
  );
  const prompt = text
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```$/, '')
    .replace(/^["“「]|["”」]$/g, '')
    .trim()
    .slice(0, BOOK_ROLE_LIMIT);
  if (!prompt) throw new AppError(502, '青藜没有给出指引，请重试。', 'AI_PROVIDER_ERROR');
  return { prompt };
}

// What 青藜 is told about a note inside a book: the book, its role, how to
// discuss, and for a discussion below a page, that page's text and summary.
// What 青藜 knows on a book's own page: its pages with their summaries and
// the reading note. Text under a locked key is left out.
async function bookOverview(env: Env, info: BookInfo): Promise<string> {
  const rows = await env.DB.prepare(
    `SELECT n.title,p.page,p.summary FROM book_pages p JOIN nodes n ON n.id=p.node_id
    WHERE n.parent_id=? AND n.trash_id IS NULL ${PAGE_ORDER}`,
  )
    .bind(info.id)
    .all<{ title: string; page: number | null; summary: string }>();
  const pages: string[] = [];
  for (const row of rows.results) {
    const summary = row.summary ? await openFor(env, row.summary).catch(() => '') : '';
    pages.push(`- ${row.title}${row.page === null ? '' : `（第 ${row.page} 页）`}${summary ? `：${summary}` : ''}`);
  }
  let prompt = `\n\n这是书籍的首页，用户可能询问全书的内容、结构或阅读进度。已录入 ${pages.length} 页${info.page_count ? `（全书 ${info.page_count} 页）` : ''}，只有摘要，没有原文；需要细节时请用户打开对应书页提问。`;
  if (pages.length)
    prompt += `\n<已录入的书页>\n${clip(pages.join('\n'), SOURCE_TEXT_LIMIT)}\n</已录入的书页>`;
  if (info.note_id) {
    const note = await getNode(env, info.note_id).catch(() => null);
    const text = note && !note.trash_id
      ? await noteText(env, note).catch((error) => {
          if (error instanceof AppError && error.code === 'ENCRYPTION_LOCKED') return '';
          throw error;
        })
      : '';
    if (text) prompt += `\n\n读书笔记「${note!.title}」如下，作为待分析资料：\n<读书笔记>\n${clip(text, SOURCE_TEXT_LIMIT)}\n</读书笔记>`;
  }
  return prompt;
}

export async function bookPrompt(env: Env, node: NoteNode): Promise<string> {
  const info = await bookOf(env, node.id);
  if (!info) return '';
  let prompt = `\n\n当前文件属于书籍《${info.title}》${info.author ? `，作者 ${info.author}` : ''}。作为重视文本证据的阅读讨论伙伴：先回应问题，再说明依据和可能的另一种理解；区分文本事实、解释与推测；引用原文时注明页面（如“第 12 页”）。`;
  if (info.role_prompt) prompt += `\n\n<书籍角色设定>\n${info.role_prompt}\n</书籍角色设定>`;
  if (node.id === info.id) return prompt + (await bookOverview(env, info));
  if (node.parent_id && node.parent_id !== info.id) {
    const parent = await getNode(env, node.parent_id);
    // A page under another, locked key is left out of the prompt.
    const text = await noteText(env, parent).catch((error) => {
      if (error instanceof AppError && error.code === 'ENCRYPTION_LOCKED') return '';
      throw error;
    });
    const row = await pageRow(env, parent.id);
    const summary = row?.summary ? await openFor(env, row.summary).catch(() => '') : '';
    if (summary) prompt += `\n\n「${parent.title}」的摘要：${summary}`;
    if (text)
      prompt += `\n\n这是围绕上级页面「${parent.title}」的讨论，页面原文如下，作为待分析资料：\n<页面原文>\n${clip(text, SOURCE_TEXT_LIMIT)}\n</页面原文>`;
  }
  return prompt;
}
