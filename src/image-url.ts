// Chromium taints a canvas that draws an SVG image containing foreignObject
// (e.g. a paper's text box) from a blob: URL, but not from a data: URL.
// Screenshots and AI attachments draw images onto a canvas, so SVG uses a
// data: URL; other images keep the cheaper blob: URL.
export async function imageUrl(blob: Blob): Promise<{ url: string; revoke: () => void }> {
  if (!blob.type.startsWith('image/svg+xml')) {
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  return { url: svgDataUrl(await blob.text()), revoke: () => {} };
}
export const svgDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
