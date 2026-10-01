import { AI_IMAGE_LIMIT } from '../shared/assistant';

export async function captureReading(root: HTMLElement): Promise<HTMLCanvasElement> {
  const rect = root.getBoundingClientRect();
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    return (
      box.bottom > rect.top &&
      box.top < rect.bottom &&
      box.right > rect.left &&
      box.left < rect.right
    );
  };
  const pdfBusy = () =>
    Array.from(root.querySelectorAll('.pdf-page[aria-busy="true"]')).some(visible);
  const deadline = Date.now() + 5000;
  while (pdfBusy() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (pdfBusy()) throw new Error('PDF 页面正在加载，请稍后截图。');
  const scale = Math.min(2, devicePixelRatio || 1, 2200 / Math.max(rect.width, rect.height));
  if (root.classList.contains('pdf-scroll')) {
    // Composite the actual rendered PDF pixels. DOM screenshot libraries can
    // mis-clip absolutely positioned canvases with a translateX transform.
    const result = document.createElement('canvas');
    result.width = Math.ceil(rect.width * scale);
    result.height = Math.ceil(rect.height * scale);
    const context = result.getContext('2d')!;
    context.scale(scale, scale);
    context.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--pdf-stage')
      .trim();
    context.fillRect(0, 0, rect.width, rect.height);
    const pages = Array.from(root.querySelectorAll<HTMLCanvasElement>('.pdf-page canvas')).filter(
      visible,
    );
    if (!pages.length || root.querySelector('.pdf-page-status.inline-error'))
      throw new Error('PDF 页面尚未显示，请稍后截图。');
    for (const canvas of pages) {
      const box = canvas.getBoundingClientRect();
      context.drawImage(canvas, box.left - rect.left, box.top - rect.top, box.width, box.height);
    }
    return result;
  }
  for (const img of root.querySelectorAll('img')) {
    if (!visible(img)) continue;
    if (!img.complete || !img.naturalWidth) throw new Error('图片尚未加载完成，请稍后截图。');
    // A canvas cannot safely read an image fetched without CORS permission.
    const url = new URL(img.currentSrc || img.src, location.href);
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== location.origin)
      throw new Error('当前区域含有外部图片，请先把图片上传到笔记中再截图，或引用文字提问。');
  }
  const { default: html2canvas } = await import('html2canvas');
  await document.fonts.ready;
  return html2canvas(root, {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
    scale,
    backgroundColor:
      getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#ffffff',
    logging: false,
    useCORS: false,
    allowTaint: false,
    ignoreElements: (element) => element.classList.contains('pdf-text-layer'),
  });
}

export function cropScreenshot(
  canvas: HTMLCanvasElement,
  area: { x: number; y: number; width: number; height: number },
  displayWidth: number,
  displayHeight: number,
): string {
  const source = {
    x: (area.x * canvas.width) / displayWidth,
    y: (area.y * canvas.height) / displayHeight,
    width: (area.width * canvas.width) / displayWidth,
    height: (area.height * canvas.height) / displayHeight,
  };
  const ratio = Math.min(1, 1800 / Math.max(source.width, source.height));
  const target = document.createElement('canvas');
  target.width = Math.max(1, Math.round(source.width * ratio));
  target.height = Math.max(1, Math.round(source.height * ratio));
  const context = target.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(
    canvas,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    target.width,
    target.height,
  );
  for (const quality of [0.9, 0.75, 0.6]) {
    const result = target.toDataURL('image/jpeg', quality);
    if ((result.length - result.indexOf(',') - 1) * 0.75 <= AI_IMAGE_LIMIT) return result;
  }
  throw new Error('截图过大，请缩小选区。');
}
