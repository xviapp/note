import { api, upload } from './api';
import { BOOK_PAGE_IMAGE_LIMIT, type NoteNode } from '../shared/types';

const PAGE_IMAGE_SIDE = 2400;

// A phone photo is shrunk to a JPEG the recognizer reads well and quickly.
export async function pagePhoto(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('请选择书页照片。');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`无法读取照片「${file.name}」。`);
  }
  const scale = Math.min(1, PAGE_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  try {
    for (const quality of [0.86, 0.72, 0.56]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      );
      if (blob && blob.size <= BOOK_PAGE_IMAGE_LIMIT)
        return new File([blob], `${file.name.replace(/\.[^.]*$/, '') || 'page'}.jpg`, {
          type: 'image/jpeg',
        });
    }
  } finally {
    canvas.width = canvas.height = 0;
  }
  throw new Error('照片压缩后仍超过 5 MiB。');
}

// Upload and recognize one photographed page into the book.
export async function addBookPage(bookId: string, file: File, page: number | null) {
  const uploaded = await upload(await pagePhoto(file));
  return api<NoteNode>(`/api/nodes/${bookId}/pages`, 'POST', {
    fileId: uploaded.id,
    ...(page ? { page } : {}),
  });
}
