import { AI_IMAGE_LIMIT } from '../shared/assistant';
import {
  CHAT_FILE_LIMIT,
  CHAT_FILE_TEXT_LIMIT,
  CHAT_FILE_IMAGE_LIMIT,
  CHAT_PDF_PAGE_LIMIT,
  pageLabel,
  type ChatFile,
  type ChatFileKind,
} from '../shared/chat-files';
import type { FileInfo } from '../shared/types';
import { AppError, idValue, integer, textValue } from './http';
import { discardFile, getBlob, uploadFile } from './storage';
import type { BlobRow, Env } from './types';

const info = (file: BlobRow): FileInfo => ({
  id: file.id,
  name: file.name,
  mime: file.mime,
  size: file.size,
});
function supportsSource(file: BlobRow): boolean {
  return (
    file.mime === 'application/pdf' ||
    /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(file.mime) ||
    (['application/octet-stream', 'text/plain; charset=utf-8'].includes(file.mime) &&
      /\.(md|markdown|txt)$/i.test(file.name) &&
      file.size <= 1_048_576)
  );
}
export async function uploadChatFile(env: Env, request: Request): Promise<FileInfo> {
  const file = await uploadFile(env, request);
  if (!supportsSource(file)) {
    await discardFile(env, file.id);
    throw new AppError(400, '支持 PDF、图片，以及不超过 1 MiB 的 Markdown / TXT 文件。');
  }
  return info(file);
}
export async function validateChatFiles(
  env: Env,
  value: unknown,
): Promise<{ files: ChatFile[]; blobIds: string[] }> {
  if (value === undefined) return { files: [], blobIds: [] };
  if (!Array.isArray(value) || value.length > CHAT_FILE_LIMIT)
    throw new AppError(400, `每次最多附上 ${CHAT_FILE_LIMIT} 个文件。`);
  let characters = 0,
    images = 0;
  const files: ChatFile[] = [],
    blobIds = new Set<string>();
  for (const input of value) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new AppError(400, '文件内容格式不正确。');
    const name = textValue(input.name, '文件名', 200).trim();
    const kind = input.kind as ChatFileKind;
    if (!['markdown', 'text', 'pdf', 'image'].includes(kind))
      throw new AppError(400, '不支持这种文件类型。');
    const text = textValue(input.text, '文件文字', CHAT_FILE_TEXT_LIMIT, true);
    characters += text.length;
    if (characters > CHAT_FILE_TEXT_LIMIT)
      throw new AppError(413, '文件文字合计最多 60,000 字符，请减少文件或缩小 PDF 页码范围。');
    const file: ChatFile = { name, kind, text, images: [] };
    if (kind === 'pdf') {
      file.pageCount = integer(input.pageCount, 'PDF 总页数', 1, 1_000_000);
      if (
        !Array.isArray(input.pages) ||
        !input.pages.length ||
        input.pages.length > CHAT_PDF_PAGE_LIMIT
      )
        throw new AppError(400, '请选择有效的 PDF 页码范围。');
      const pages: number[] = input.pages.map((page: unknown) =>
        integer(page, 'PDF 页码', 1, file.pageCount),
      );
      file.pages = pages;
      if (
        new Set(pages).size !== pages.length ||
        pages.some((page, index) => index > 0 && page <= pages[index - 1])
      )
        throw new AppError(400, 'PDF 页码必须递增且不能重复。');
      if (!['auto', 'images'].includes(input.mode)) throw new AppError(400, 'PDF 处理方式不正确。');
      file.mode = input.mode;
    }
    if (input.sourceId !== undefined) {
      const source = await getBlob(env, idValue(input.sourceId));
      if (
        !supportsSource(source) ||
        (kind === 'pdf' && source.mime !== 'application/pdf') ||
        (kind === 'image' && !source.mime.startsWith('image/')) ||
        (['text', 'markdown'].includes(kind) &&
          (!/\.(txt|md|markdown)$/i.test(source.name) ||
            !['application/octet-stream', 'text/plain; charset=utf-8'].includes(source.mime)))
      )
        throw new AppError(400, '附件原文件与内容类型不符。');
      file.source = info(source);
      blobIds.add(source.id);
    }
    if (!Array.isArray(input.images)) throw new AppError(400, '文件图片格式不正确。');
    images += input.images.length;
    if (images > CHAT_FILE_IMAGE_LIMIT)
      throw new AppError(
        413,
        `每次最多附上 ${CHAT_FILE_IMAGE_LIMIT} 张文件图片，请缩小 PDF 页码范围。`,
      );
    if (input.images.length && !['pdf', 'image'].includes(kind))
      throw new AppError(400, '文本文件不能包含页面图片。');
    const imagePages = new Set<number>();
    for (const image of input.images) {
      if (!image || typeof image !== 'object') throw new AppError(400, '页面图片格式不正确。');
      const blob = await getBlob(env, idValue(image.blobId));
      if (!['image/png', 'image/jpeg'].includes(blob.mime) || blob.size > AI_IMAGE_LIMIT)
        throw new AppError(400, '页面图片须为不超过 1 MiB 的 PNG 或 JPEG。');
      let page: number | undefined;
      if (kind === 'pdf') {
        page = integer(image.page, '图片页码', 1, file.pageCount);
        if (!file.pages!.includes(page) || imagePages.has(page))
          throw new AppError(400, '页面图片必须对应所选页码且不能重复。');
        imagePages.add(page);
      }
      file.images.push({ file: info(blob), ...(page ? { page } : {}) });
      blobIds.add(blob.id);
    }
    if (kind === 'pdf' && file.mode === 'images' && imagePages.size !== file.pages!.length)
      throw new AppError(400, '所选 PDF 页面图片不完整，请重新处理。');
    if (!text.trim() && !file.images.length)
      throw new AppError(400, '附件没有可读取的文字或图片。');
    if (kind === 'image' && file.images.length !== 1)
      throw new AppError(400, '图片附件须包含一张处理后的图片。');
    files.push(file);
  }
  return { files, blobIds: [...blobIds] };
}
export function fileContext(file: ChatFile): string {
  const scope =
    file.kind === 'pdf'
      ? `PDF 共 ${file.pageCount} 页；本次仅提供第 ${pageLabel(file.pages!)} 页；${file.mode === 'images' ? '整页图片' : '提取文字，无法提取文字的页转为图片'}`
      : file.kind === 'image'
        ? '图片'
        : '文件文字';
  return `\n\n<附件 ${JSON.stringify(file.name)}>\n${scope}\n${file.text}\n</附件>`;
}
