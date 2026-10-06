import type { PasswordParameters } from './password';
import type { ProjectCategory } from './projects';

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  name: string;
  password?: PasswordParameters;
}

export type NodeKind = 'folder' | 'markdown' | 'text' | 'pdf' | 'image' | 'link';
// A stored kind, or the kind of page a side table makes of a node: an arXiv
// paper is a link, a book or project a folder, a book page or discussion a
// Markdown note, a reference a folder pointing elsewhere.
export type NoteVariant =
  NodeKind | 'paper' | 'book' | 'book-page' | 'discussion' | 'project' | 'reference';
type LegacyFlags = { is_book?: number; is_project?: number; is_reference?: number };
export function variantOf(
  node: Pick<NoteNode, 'kind' | 'variant' | 'arxiv_id'> & LegacyFlags,
): NoteVariant {
  if (node.variant) return node.variant;
  // Copies cached offline before the server reported variants.
  if (node.is_reference) return 'reference';
  if (node.is_book) return 'book';
  if (node.is_project) return 'project';
  return node.arxiv_id ? 'paper' : node.kind;
}
export const TEXT_KINDS: NodeKind[] = ['markdown', 'text'];
export const PARENT_KINDS: NodeKind[] = ['folder', 'markdown', 'text', 'pdf', 'image', 'link'];
export const UNTITLED_NAMES: Record<NodeKind, string> = {
  folder: '未命名文件夹',
  markdown: '未命名笔记',
  text: '未命名文本',
  pdf: '未命名 PDF',
  image: '未命名图片',
  link: '未命名链接',
};
export interface NoteNode {
  id: string;
  parent_id: string | null;
  kind: NodeKind;
  title: string;
  position: number;
  url: string | null;
  arxiv_id?: string | null;
  file_blob_id: string | null;
  icon_emoji?: string | null;
  icon_blob_id?: string | null;
  current_version_id: string | null;
  revision: number;
  trash_id: string | null;
  created_at: number;
  updated_at: number;
  child_count?: number;
  favorite?: number;
  // What the node is to the reader (worked out by the server; see variantOf).
  variant?: NoteVariant;
  reference_target_id?: string | null;
  reference_kind?: NodeKind | null;
  project_category?: ProjectCategory | null;
  metadata_title?: string | null;
  metadata_status?: string | null;
  metadata_excerpt?: string | null;
  metadata_version_id?: string | null;
}
export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
}
// A paper with many images imports over several requests. Until the note is
// created, the server answers with signed progress for the next request.
// What the share window shows before a paper is imported or linked.
export interface ArxivPreview {
  id: string;
  title: string;
  authors: string[];
  summary: string;
}
export interface ArxivImportProgress {
  continuation: string;
  done: number;
  total: number;
}
// A title match, with the titles of its ancestors from the root down.
export interface SearchResult extends NoteNode {
  path: string[];
  // Set when the match is in one of the file's highlights or notes.
  annotation?: { id: string; quote: string; note: string };
}
export const SEARCH_LIMIT = 30;
export interface ShareSettings {
  parentId: string | null;
  breadcrumbs: { id: string; title: string }[];
}
export interface NoteDetail extends NoteNode {
  reference?: { target: NoteNode | null };
  content: string;
  attachments: FileInfo[];
  file?: FileInfo;
  breadcrumbs: { id: string; title: string }[];
  // The nearest book containing this note, or the note itself when it is a book.
  book?: BookInfo;
  // A photographed page of the book: its summary, questions and discussions.
  book_page?: BookPageInfo;
  // A discussion below a page (its 青藜 thread is the conversation).
  discussion_page?: string;
}
export interface BookDiscussion {
  id: string;
  title: string;
  replies: number;
  // Summarized into the page's reading note.
  noted: boolean;
}
export interface BookPageInfo {
  page: number | null;
  summary: string;
  questions: string[];
  // No summary yet, or written from an older version of the page.
  stale: boolean;
  note_id: string | null;
  discussions: BookDiscussion[];
  prev: string | null;
  next: string | null;
}
export interface BookPageItem {
  id: string;
  title: string;
  page: number | null;
  summary: string;
  discussions: number;
  note_id: string | null;
}
export interface BookPages {
  pages: BookPageItem[];
  // Other notes kept directly in the book.
  others: NoteNode[];
}
export const BOOK_SUMMARY_LIMIT = 400;
export const BOOK_QUESTION_LIMIT = 120;
export type BookStatus = 'want' | 'reading' | 'finished';
export const BOOK_STATUS_LABELS: Record<BookStatus, string> = {
  want: '想读',
  reading: '在读',
  finished: '已读完',
};
export const BOOK_ROLE_LIMIT = 4000;
// Reading roles for 青藜, from 问天; picking one fills the book's role prompt.
export const BOOK_ROLE_PRESETS = [
  {
    id: 'general',
    name: '通用阅读伙伴',
    description: '类型不明确或跨学科书籍',
    prompt:
      '你是一位严谨、耐心的阅读伙伴。优先澄清作者实际表达的观点，区分事实、解释与推测；信息不足时明确说明。',
  },
  {
    id: 'literature',
    name: '文学细读者',
    description: '小说、诗歌、戏剧与散文',
    prompt:
      '你是一位文学细读者。关注叙事视角、人物动机、语言意象、结构节奏与多义性，并用原文证据支持解释。',
  },
  {
    id: 'philosophy',
    name: '哲学追问者',
    description: '哲学、思想与伦理著作',
    prompt:
      '你是一位哲学追问者。帮助读者界定概念、还原论证、识别隐含前提与反例，区分作者主张与你的重构。',
  },
  {
    id: 'history',
    name: '历史研究者',
    description: '历史、传记与纪实作品',
    prompt:
      '你是一位历史研究者。关注时代背景、因果链条、行动者处境与材料来源，警惕目的论和时代错置。',
  },
  {
    id: 'social-science',
    name: '社会科学分析者',
    description: '心理学、社会学、经济学与政治学',
    prompt:
      '你是一位社会科学分析者。检查概念、样本、测量和因果证据，把统计相关、机制解释和价值判断分开。',
  },
  {
    id: 'science',
    name: '科学解释者',
    description: '自然科学、医学与科普',
    prompt:
      '你是一位科学解释者。准确拆解概念、模型和公式，说明证据、适用边界与不确定性，不用类比替代关键推理。',
  },
  {
    id: 'technology',
    name: '技术导师',
    description: '计算机、工程与专业教材',
    prompt:
      '你是一位技术导师。连接原理、实现步骤、权衡与常见失败方式，并明确结论依赖的版本、环境或假设。',
  },
  {
    id: 'business',
    name: '商业案例顾问',
    description: '商业、管理、投资与组织',
    prompt:
      '你是一位商业案例顾问。分析市场条件、激励、资源约束和利益相关者，区分可迁移原则与幸存者偏差。',
  },
  {
    id: 'practical',
    name: '实践教练',
    description: '成长、方法、健康与生活指南',
    prompt:
      '你是一位实践教练。把建议转化为可检验的小步骤，识别条件、成本和风险，并对高风险内容保持审慎。',
  },
] as const;
export const BOOK_PAGE_IMAGE_LIMIT = 5 * 1_048_576;
export interface BookInfo {
  id: string;
  title: string;
  author: string;
  status: BookStatus;
  page_count: number;
  pages_read: number;
  // Steers 青藜 for every note inside the book.
  role_prompt: string;
  // The collected reading note of all pages.
  note_id: string | null;
  updated_at: number;
}
export interface ReadingPosition {
  ratio?: number;
  heading?: string;
  headingRatio?: number;
  page?: number;
  pageRatio?: number;
}
export interface ReadingState {
  position: ReadingPosition;
  version: number;
  updated_at: number;
}
export interface VersionInfo {
  id: string;
  sequence: number;
  created_at: number;
  current: boolean;
}
export interface TrashBatch {
  id: string;
  root_id: string;
  title: string;
  original_parent_id: string | null;
  deleted_at: number;
  expires_at: number;
  purging: number;
  node_count: number;
}
export interface StorageInfo {
  quotaBytes: number;
  allocatedBytes: number;
  reservedBytes: number;
  currentBytes: number;
  historyBytes: number;
  trashBytes: number;
  orphanBytes: number;
}
export const KIND_LABELS: Record<NodeKind, string> = {
  folder: '文件夹',
  markdown: 'Markdown 笔记',
  text: '纯文本',
  pdf: 'PDF',
  image: '图片',
  link: '网页链接',
};
