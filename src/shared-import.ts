import { api, upload } from './api';
import type { FileInfo, NoteNode } from '../shared/types';
export interface IncomingShare {
  id: string;
  title?: string;
  text?: string;
  error?: string;
  files: { id: string; name: string; mime: string; size: number; path: string }[];
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
  options: { title: string; text: string; parent: string | null },
  onProgress: (text: string) => void,
) {
  const created: NoteNode[] = [];
  const entries = [...share.files];
  // Deterministic operation keys make retrying after a lost response safe.
  for (const [index, item] of entries.entries()) {
    onProgress(`正在导入 ${index + 1}/${entries.length}：${item.name}`);
    if (!/^\/__share\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(item.path))
      throw new Error('分享文件地址无效。');
    const response = await fetch(item.path);
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
    const url = sharedUrl(options.text);
    created.push(
      await api<NoteNode>(
        '/api/nodes',
        'POST',
        {
          kind: url ? 'link' : 'markdown',
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
