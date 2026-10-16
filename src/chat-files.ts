import { AI_IMAGE_LIMIT, GLOBAL_ASSISTANT_ID } from '../shared/assistant';
import {
  CHAT_FILE_IMAGE_LIMIT,
  CHAT_FILE_LIMIT,
  CHAT_SOURCE_TEXT_BYTE_LIMIT,
  type ChatFileInput,
  type ChatFileKind,
  type ChatSource,
} from '../shared/chat-files';
import type { FileInfo, NoteDetail } from '../shared/types';
import { fileUrl, parse, scopeOf, uploadRequest } from './api';
import { openBlob, plainUpload, sealData } from './encryption';
import { paperParts } from './paper';
import { svgDataUrl } from './image-url';

export type AttachmentSource =
  | { type: 'note'; note: NoteDetail }
  | { type: 'stored'; file: FileInfo }
  | { type: 'local'; file: File };
export interface PreparedChatFile {
  origin?: ChatSource;
  id: string;
  name: string;
  kind: ChatFileKind;
  text: string;
  pages?: number[];
  pageCount?: number;
  mode?: 'auto' | 'images';
  images: { data: string; page?: number }[];
  sourceId?: string;
  localSource?: File;
  uploaded?: ChatFileInput;
}
export function sourceDescription(source: AttachmentSource): {
  origin?: ChatSource;
  name: string;
  kind: ChatFileKind;
  sourceId?: string;
  localSource?: File;
} {
  if (source.type === 'note') {
    const note = source.note;
    if (note.kind === 'folder') throw new Error('请打开一个文件。');
    return {
      origin: { nodeId: note.id, title: note.title.slice(0, 200) },
      name: note.title.slice(0, 200),
      kind: note.kind === 'link' ? 'text' : note.kind,
      ...(note.file ? { sourceId: note.file.id } : {}),
    };
  }
  const file = source.file;
  if (file.size > 50_000_000) throw new Error('单文件最多 50 MB。');
  const mime = source.type === 'local' ? source.file.type : source.file.mime;
  const kind =
    mime === 'application/pdf' || /\.pdf$/i.test(file.name)
      ? 'pdf'
      : /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mime) ||
          /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.name)
        ? 'image'
        : /\.(md|markdown)$/i.test(file.name)
          ? 'markdown'
          : /\.txt$/i.test(file.name)
            ? 'text'
            : null;
  if (!kind) throw new Error('支持 Markdown、TXT、PDF 和图片文件。');
  if (['text', 'markdown'].includes(kind) && file.size > CHAT_SOURCE_TEXT_BYTE_LIMIT)
    throw new Error('文本附件最多 8 MiB，请拆分后附上。');
  return {
    name: file.name.slice(0, 200),
    kind,
    ...(source.type === 'local' ? { localSource: source.file } : { sourceId: source.file.id }),
  };
}
export async function sourceBlob(source: AttachmentSource, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (source.type === 'local') return source.file;
  const id = source.type === 'stored' ? source.file.id : source.note.file?.id;
  if (!id) throw new Error('文件尚未加载。');
  const response = await fetch(fileUrl(id), { credentials: 'same-origin', signal });
  if (!response.ok) {
    await parse(response);
    throw new Error('文件暂时无法读取。');
  }
  return openBlob(await response.blob());
}
export function canvasImage(canvas: HTMLCanvasElement): string {
  for (const quality of [0.9, 0.75, 0.6]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if ((data.length - data.indexOf(',') - 1) * 0.75 <= AI_IMAGE_LIMIT) return data;
  }
  throw new Error('页面图片压缩后仍超过 1 MiB，请使用框选截图。');
}
export async function prepareBasicFile(
  source: AttachmentSource,
  signal: AbortSignal,
): Promise<PreparedChatFile> {
  const meta = sourceDescription(source);
  const result: PreparedChatFile = { ...meta, id: crypto.randomUUID(), text: '', images: [] };
  if (meta.kind === 'pdf') throw new Error('请先选择 PDF 页码。');
  if (meta.kind === 'image') {
    const blob = await sourceBlob(source, signal);
    let bitmap: ImageBitmap | HTMLImageElement;
    if (blob.type.split(';')[0] === 'image/svg+xml' || /\.svg$/i.test(meta.name)) {
      const { sanitizeSvg, SVG_LIMIT } = await import('../shared/svg');
      if (blob.size > SVG_LIMIT) throw new Error('SVG 图片最多 10 MiB。');
      const clean = sanitizeSvg(new Uint8Array(await blob.arrayBuffer()));
      const image = new Image();
      // A data: URL keeps the canvas readable when the SVG has foreignObject.
      image.src = svgDataUrl(clean);
      try {
        await image.decode();
      } catch {
        throw new Error('SVG 图片无法绘制，请检查文件内容。');
      }
      bitmap = image;
    } else bitmap = await createImageBitmap(blob);
    try {
      signal.throwIfAborted();
      const ratio = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      result.images.push({ data: canvasImage(canvas) });
      canvas.width = canvas.height = 0;
    } finally {
      if (bitmap instanceof ImageBitmap) bitmap.close();
    }
  } else {
    if (source.type === 'note')
      result.text = source.note.arxiv_id
        ? paperParts(source.note)[0].text
        : source.note.kind === 'link'
          ? `${source.note.title}\n${source.note.url ?? ''}`
          : source.note.content;
    else {
      const bytes = new Uint8Array(await (await sourceBlob(source, signal)).arrayBuffer());
      const encoding =
        bytes[0] === 255 && bytes[1] === 254
          ? 'utf-16le'
          : bytes[0] === 254 && bytes[1] === 255
            ? 'utf-16be'
            : 'utf-8';
      try {
        result.text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        throw new Error('文本编码无法识别，请保存为 UTF-8 后再附上。');
      }
    }
    if (result.text.includes('\0')) throw new Error('文件包含二进制内容，请选择文本文件。');
    if (!result.text.trim()) throw new Error('文件没有可读取的文字。');
  }
  signal.throwIfAborted();
  return result;
}
export function validatePreparedFiles(files: PreparedChatFile[]): void {
  if (files.length > CHAT_FILE_LIMIT) throw new Error(`每次最多附上 ${CHAT_FILE_LIMIT} 个文件。`);
  if (files.reduce((sum, file) => sum + file.images.length, 0) > CHAT_FILE_IMAGE_LIMIT)
    throw new Error(
      `文件图片合计最多 ${CHAT_FILE_IMAGE_LIMIT} 张，请减少文件或缩小 PDF 页码范围。`,
    );
}
async function upload(nodeId: string, file: File, signal: AbortSignal): Promise<FileInfo> {
  // Attachments to an encrypted note's chat are sealed with its key.
  const keyId = nodeId === GLOBAL_ASSISTANT_ID ? null : await scopeOf(nodeId);
  let body: Blob | Uint8Array<ArrayBuffer> = file,
    query = '';
  if (keyId) {
    const plain = await plainUpload(file);
    body = await sealData(keyId, plain.bytes);
    query = `&key=${keyId}&mime=${encodeURIComponent(plain.mime)}`;
  }
  signal.throwIfAborted();
  const size = body instanceof Blob ? body.size : body.length;
  const response = await uploadRequest(
    `/api/nodes/${nodeId}/assistant/files?name=${encodeURIComponent(file.name)}&size=${size}${query}`,
    body,
    signal,
  );
  return parse<FileInfo>(response);
}
export async function uploadPreparedFile(
  nodeId: string,
  file: PreparedChatFile,
  signal: AbortSignal,
): Promise<ChatFileInput> {
  if (file.uploaded) return file.uploaded;
  if (file.localSource && !file.sourceId)
    file.sourceId = (await upload(nodeId, file.localSource, signal)).id;
  const images: ChatFileInput['images'] = [];
  for (const image of file.images) {
    signal.throwIfAborted();
    const encoded = image.data.slice(image.data.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const stored = await upload(
      nodeId,
      new File([bytes], `page-${image.page || 1}.jpg`, { type: 'image/jpeg' }),
      signal,
    );
    images.push({ blobId: stored.id, ...(image.page ? { page: image.page } : {}) });
  }
  file.uploaded = {
    ...(file.origin ? { origin: file.origin } : {}),
    name: file.name,
    kind: file.kind,
    text: file.text,
    images,
    ...(file.sourceId ? { sourceId: file.sourceId } : {}),
    ...(file.pages ? { pages: file.pages, pageCount: file.pageCount, mode: file.mode } : {}),
  };
  return file.uploaded;
}
