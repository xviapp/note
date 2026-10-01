import type { FileInfo } from './types';

export const CHAT_FILE_LIMIT = 3;
// Byte bounds protect browser/Worker memory; model context is budgeted in tokens.
export const CHAT_SOURCE_TEXT_BYTE_LIMIT = 8 * 1_048_576;
export const CHAT_BODY_BYTE_LIMIT = 16 * 1_048_576;
// A start event echoes the saved attachment snapshots plus message metadata.
export const CHAT_EVENT_CHARACTER_LIMIT = CHAT_BODY_BYTE_LIMIT + 65_536;
export const CHAT_FILE_IMAGE_LIMIT = 6;
export const CHAT_PDF_PAGE_LIMIT = 200;
export const CHAT_CONTEXT_IMAGE_LIMIT = 8;
export type ChatFileKind = 'markdown' | 'text' | 'pdf' | 'image';
export interface ChatFileInput {
  name: string;
  kind: ChatFileKind;
  text: string;
  sourceId?: string;
  pages?: number[];
  pageCount?: number;
  mode?: 'auto' | 'images';
  images: { blobId: string; page?: number }[];
}
export interface ChatFile {
  name: string;
  kind: ChatFileKind;
  text: string;
  source?: FileInfo;
  pages?: number[];
  pageCount?: number;
  mode?: 'auto' | 'images';
  images: { file: FileInfo; page?: number }[];
}
export function parsePageRange(input: string, pageCount: number): number[] {
  const result = new Set<number>();
  for (const part of input.replaceAll('，', ',').split(',')) {
    const match = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!match) throw new Error('页码格式如 1-5,8,10-12。');
    const first = Number(match[1]),
      last = Number(match[2] || match[1]);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 1 ||
      last < first ||
      last > pageCount
    )
      throw new Error(`页码须在 1–${pageCount} 之间，范围从小到大填写。`);
    if (last - first + 1 > CHAT_PDF_PAGE_LIMIT)
      throw new Error(`每次最多处理 ${CHAT_PDF_PAGE_LIMIT} 页，请缩小页码范围。`);
    for (let page = first; page <= last; page++) result.add(page);
    if (result.size > CHAT_PDF_PAGE_LIMIT)
      throw new Error(`每次最多处理 ${CHAT_PDF_PAGE_LIMIT} 页，请缩小页码范围。`);
  }
  return [...result].sort((a, b) => a - b);
}
export function pageLabel(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const first = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    parts.push(first === pages[i] ? String(first) : `${first}–${pages[i]}`);
  }
  return parts.join('、');
}
