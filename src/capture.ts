import { AI_IMAGE_LIMIT } from '../shared/assistant';

async function mathImage(element: Element, scale: number): Promise<string> {
  const box = element.getBoundingClientRect(),
    style = getComputedStyle(element);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(Math.ceil(box.width * scale)));
  svg.setAttribute('height', String(Math.ceil(box.height * scale)));
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const foreign = document.createElementNS(svg.namespaceURI, 'foreignObject');
  foreign.setAttribute('width', '100%');
  foreign.setAttribute('height', '100%');
  const host = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  host.style.cssText = `margin:0;display:flex;align-items:center;width:${box.width}px;height:${box.height}px;color:${style.color};font-size:${style.fontSize};font-family:${style.fontFamily};line-height:normal;`;
  const math = element.cloneNode(true) as Element;
  math.setAttribute('style', 'margin:0;max-width:none;overflow:visible;');
  host.appendChild(math);
  foreign.appendChild(host);
  svg.appendChild(foreign);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(box.width * scale);
  canvas.height = Math.ceil(box.height * scale);
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

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
  // Rasterize only visible MathML with the browser before html2canvas paints
  // the surrounding document. Foreign-object rendering of the entire scroll
  // container loses clipping/scroll offsets in Chromium.
  const formulas = await Promise.all(
    Array.from(root.querySelectorAll('math')).map(async (math, index) => {
      const box = math.getBoundingClientRect();
      if (!visible(math) || !box.width || !box.height) return null;
      return {
        index,
        src: await mathImage(math, scale),
        width: box.width,
        height: box.height,
        block: math.getAttribute('display') === 'block',
      };
    }),
  );
  return html2canvas(root, {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
    scale,
    backgroundColor:
      getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#ffffff',
    logging: false,
    useCORS: false,
    allowTaint: false,
    onclone: (_document, clonedRoot) => {
      const math = clonedRoot.querySelectorAll('math');
      for (const formula of formulas) {
        if (!formula) continue;
        const image = _document.createElement('img');
        image.src = formula.src;
        image.style.cssText = `width:${formula.width}px;height:${formula.height}px;max-width:none;display:${formula.block ? 'block' : 'inline-block'};vertical-align:middle;background:transparent;`;
        math[formula.index]?.replaceWith(image);
      }
    },
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
