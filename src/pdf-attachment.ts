import type { PDFDocumentProxy } from 'pdfjs-dist';
import { CHAT_FILE_IMAGE_LIMIT, CHAT_FILE_TEXT_LIMIT } from '../shared/chat-files';
import { canvasImage, type PreparedChatFile } from './chat-files';

export async function preparePdf(
  pdf: PDFDocumentProxy,
  pages: number[],
  mode: 'auto' | 'images',
  signal: AbortSignal,
  onProgress: (page: number, done: number) => void,
): Promise<Pick<PreparedChatFile, 'text' | 'images' | 'pages' | 'pageCount' | 'mode'>> {
  if (mode === 'images' && pages.length > CHAT_FILE_IMAGE_LIMIT)
    throw new Error(`整页图片每次最多 ${CHAT_FILE_IMAGE_LIMIT} 页，请缩小页码范围。`);
  const result = {
    text: '',
    images: [] as PreparedChatFile['images'],
    pages,
    pageCount: pdf.numPages,
    mode,
  };
  for (const [index, number] of pages.entries()) {
    signal.throwIfAborted();
    onProgress(number, index);
    const page = await pdf.getPage(number);
    try {
      let text = '';
      if (mode === 'auto') {
        const content = await page.getTextContent();
        text = content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
          .join('')
          .trim();
      }
      if (mode === 'auto' && text.replace(/\s/g, '').length >= 24) {
        result.text += `\n\n[第 ${number} 页]\n${text}`;
        if (result.text.length > CHAT_FILE_TEXT_LIMIT)
          throw new Error('所选页面文字超过 60,000 字符，请缩小页码范围。');
      } else {
        if (result.images.length >= CHAT_FILE_IMAGE_LIMIT)
          throw new Error(`所选范围需要超过 ${CHAT_FILE_IMAGE_LIMIT} 张页面图片，请缩小页码范围。`);
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(2, 1800 / Math.max(original.width, original.height)),
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
        const cancel = () => task.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          signal.throwIfAborted();
          await task.promise;
          signal.throwIfAborted();
          result.images.push({ page: number, data: canvasImage(canvas) });
        } finally {
          signal.removeEventListener('abort', cancel);
          canvas.width = canvas.height = 0;
        }
      }
    } finally {
      page.cleanup();
    }
  }
  signal.throwIfAborted();
  onProgress(pages.at(-1)!, pages.length);
  return result;
}
