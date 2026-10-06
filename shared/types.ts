import type { PasswordParameters } from './password';

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  name: string;
  password?: PasswordParameters;
}

export type NodeKind = 'folder' | 'markdown' | 'text' | 'pdf' | 'image' | 'link';
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
  // A folder with book details.
  is_book?: number;
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
  content: string;
  attachments: FileInfo[];
  file?: FileInfo;
  breadcrumbs: { id: string; title: string }[];
  // The nearest book containing this note, or the note itself when it is a book.
  book?: BookInfo;
}
export type BookStatus = 'want' | 'reading' | 'finished';
export const BOOK_STATUS_LABELS: Record<BookStatus, string> = {
  want: '想读',
  reading: '在读',
  finished: '已读完',
};
export const BOOK_ROLE_LIMIT = 4000;
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
