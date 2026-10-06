// Recolor a rendered PDF page to the reading theme: white paper becomes the
// theme's page colour and black type its ink. In dark themes lightness is
// inverted first, keeping hues, so the page reads light-on-dark. Embedded images
// are painted back unchanged; a scanned page is one image and stays as printed.

type Rgb = [number, number, number];

function parseColor(value: string): Rgb | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb = value.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

export type PdfTint = { paper: Rgb; ink: Rgb; dark: boolean };

// The current theme's page and ink colours, read from the CSS tokens.
export function currentPdfTint(): PdfTint | null {
  const style = getComputedStyle(document.documentElement);
  const paper = parseColor(style.getPropertyValue('--surface'));
  const ink = parseColor(style.getPropertyValue('--ink'));
  if (!paper || !ink) return null;
  return { paper, ink, dark: document.documentElement.dataset.theme !== 'light' };
}

// `images` holds PDF.js image coordinates: three corners of each image's
// parallelogram (x0 y0 x1 y1 x2 y2), as fractions of the canvas size.
export function tintPdfCanvas(
  canvas: HTMLCanvasElement,
  tint: PdfTint,
  images?: ArrayLike<number> | null,
) {
  const { width, height } = canvas;
  if (!width || !height) return;
  const context = canvas.getContext('2d')!;
  let backup: HTMLCanvasElement | null = null;
  if (images?.length) {
    backup = document.createElement('canvas');
    backup.width = width;
    backup.height = height;
    backup.getContext('2d')!.drawImage(canvas, 0, 0);
  }
  const data = context.getImageData(0, 0, width, height);
  const pixels = data.data;
  const [pr, pg, pb] = tint.paper;
  const [ir, ig, ib] = tint.ink;
  // out = ink + w * (paper - ink), with w the source lightness (0 black, 1 white).
  const dr = (pr - ir) / 255,
    dg = (pg - ig) / 255,
    db = (pb - ib) / 255;
  for (let i = 0; i < pixels.length; i += 4) {
    let r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2];
    if (tint.dark) {
      // Dark paper and light ink already invert lightness, but channel by channel
      // that would also turn red into cyan. Invert lightness with hue kept
      // (c' = c + 255 - max - min) and map w = 255 - c' instead.
      const shift = Math.max(r, g, b) + Math.min(r, g, b) - 255;
      r = 255 - r + shift;
      g = 255 - g + shift;
      b = 255 - b + shift;
    }
    pixels[i] = ir + r * dr;
    pixels[i + 1] = ig + g * dg;
    pixels[i + 2] = ib + b * db;
  }
  context.putImageData(data, 0, 0);
  if (!backup || !images) return;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.beginPath();
  for (let i = 0; i + 5 < images.length; i += 6) {
    const x0 = images[i] * width,
      y0 = images[i + 1] * height,
      x1 = images[i + 2] * width,
      y1 = images[i + 3] * height,
      x2 = images[i + 4] * width,
      y2 = images[i + 5] * height;
    context.moveTo(x0, y0);
    context.lineTo(x1, y1);
    context.lineTo(x1 + x2 - x0, y1 + y2 - y0);
    context.lineTo(x2, y2);
    context.closePath();
  }
  context.clip();
  context.drawImage(backup, 0, 0);
  context.restore();
  backup.width = backup.height = 0;
}
