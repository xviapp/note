import { api, upload } from './api';
import type { FileInfo, NoteNode } from '../shared/types';
export interface IncomingShare {
  id: string;
  title?: string;
  text?: string;
  error?: string;
  files: { id: string; name: string; mime: string; size: number; path: string }[];
}
type IncomingFile = IncomingShare['files'][number];
// A shared .md or .txt file is read into the note body instead of being uploaded.
export const isTextFile = (file: Pick<IncomingFile, 'mime'>) =>
  /^text\/(plain|markdown)$/.test(file.mime);
export function incomingShareTitle(share: IncomingShare): string {
  const subject = share.title?.trim();
  const filename = share.files[0]?.name
    .replace(/\.(?:jpe?g|png|gif|webp|avif|svg|pdf|md|markdown|txt)$/i, '')
    .trim();
  const firstLine = share.text
    ?.split(/\r?\n/)
    .find((line) => line.trim())
    ?.replace(/^#{1,6}\s+/, '')
    .trim();
  return (subject || filename || firstLine || '分享内容').slice(0, 200);
}

export function incomingShareFilePath(
  share: IncomingShare,
  file: IncomingShare['files'][number],
): string {
  const uuid = /^[a-f0-9-]{36}$/;
  if (
    !uuid.test(share.id) ||
    !uuid.test(file.id) ||
    file.path !== `/__share/${share.id}/${file.id}`
  )
    throw new Error('分享文件地址无效。');
  if (
    !isTextFile(file) &&
    !/^(application\/pdf|image\/(png|jpeg|gif|webp|avif|svg\+xml))$/.test(file.mime)
  )
    throw new Error('分享文件仅支持 PDF、常用图片、Markdown 和纯文本格式。');
  const limit = isTextFile(file) ? 1024 * 1024 : 50_000_000;
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limit)
    throw new Error('分享文件大小无效。');
  return file.path;
}
export function sharedUrl(text: string) {
  try {
    const url = new URL(text.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export async function importShare(
  share: IncomingShare,
  options: {
    title: string;
    text: string;
    parent: string | null;
    // How the text is saved; by default a lone URL becomes a link, else Markdown.
    format?: 'markdown' | 'text' | 'link';
  },
  onProgress: (text: string) => void,
) {
  if (share.error) throw new Error(share.error);
  if (!options.title.trim()) throw new Error('请填写标题。');
  const uploads = share.files.filter((file) => !isTextFile(file));
  if (!options.text.trim() && !uploads.length) throw new Error('分享内容为空。');
  if (options.text.length > 1024 * 1024) throw new Error('分享文字超过 1 MiB。');
  if (
    share.files.length > 10 ||
    share.files.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024
  )
    throw new Error('一次最多分享 10 个文件，总计最多 100 MiB。');
  // Validate the entire batch before creating any notes or uploading files.
  share.files.forEach((file) => incomingShareFilePath(share, file));
  const url = options.format === 'link' || !options.format ? sharedUrl(options.text) : null;
  if (options.format === 'link' && !url) throw new Error('链接地址无效。');
  const paths = uploads.map((file) => file.path);
  const created: NoteNode[] = [];
  const entries = uploads;
  // Deterministic operation keys make retrying after a lost response safe.
  for (const [index, item] of entries.entries()) {
    onProgress(`正在导入 ${index + 1}/${entries.length}：${item.name}`);
    const response = await fetch(paths[index]!);
    if (!response.ok) throw new Error('分享文件已失效，请重新分享。');
    const blob = await response.blob();
    if (blob.size !== item.size) throw new Error('分享文件不完整，请重新分享。');
    const uploaded: FileInfo = await upload(new File([blob], item.name, { type: item.mime }));
    let node: NoteNode | undefined;
    try {
      node = await api<NoteNode>(
        '/api/nodes',
        'POST',
        {
          kind: uploaded.mime === 'application/pdf' ? 'pdf' : 'image',
          title: entries.length === 1 ? options.title : item.name,
          parentId: options.parent,
          fileId: uploaded.id,
        },
        `share-file-${item.id}`,
      );
      created.push(node);
    } finally {
      // If this was a retry, the idempotent node may reference an earlier upload.
      // The API also refuses to delete a file referenced by a successfully saved node.
      if (node?.file_blob_id !== uploaded.id)
        await api(`/api/files/${uploaded.id}`, 'DELETE').catch(() => {});
    }
  }
  if (options.text.trim()) {
    onProgress('正在保存文字…');
    created.push(
      await api<NoteNode>(
        '/api/nodes',
        'POST',
        {
          kind: url ? 'link' : options.format === 'text' ? 'text' : 'markdown',
          title: options.title,
          parentId: options.parent,
          ...(url ? { url } : { content: options.text }),
        },
        `share-text-${share.id}`,
      ),
    );
  }
  return created;
}
