import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
// Vite's ?url suffix turns the worker into an asset URL default export.
// oxlint-disable-next-line import/default
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
export function openPdf(source: string | Uint8Array<ArrayBuffer>) {
  return getDocument({
    ...(typeof source === 'string' ? { url: source, withCredentials: true } : { data: source }),
    cMapUrl: '/pdf/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdf/standard_fonts/',
    wasmUrl: '/pdf/wasm/',
  });
}
