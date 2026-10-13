import type { PdfSourceRect, SourceLocation, TextSourceLocation } from '../shared/translation';

const elementAt = (node: Node) => (node instanceof Element ? node : node.parentElement);

/** Capture rendered text offsets plus a quote, or scale-independent PDF page rectangles. */
export function captureSourceLocation(range: Range): SourceLocation | null {
  const start = elementAt(range.startContainer),
    end = elementAt(range.endContainer);
  const pdf = start?.closest<HTMLElement>('.pdf-view[data-pdf-file-id]');
  if (pdf && end?.closest('.pdf-view') === pdf) {
    let rects: PdfSourceRect[] = [];
    for (const page of pdf.querySelectorAll<HTMLElement>('.pdf-page')) {
      const layer = page.querySelector('.pdf-text-layer');
      if (!layer || !range.intersectsNode(layer)) continue;
      const bounds = page.getBoundingClientRect(),
        number = Number(page.dataset.page);
      if (!bounds.width || !bounds.height) continue;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!range.intersectsNode(node)) continue;
        const part = document.createRange();
        part.setStart(node, node === range.startContainer ? range.startOffset : 0);
        part.setEnd(
          node,
          node === range.endContainer ? range.endOffset : node.textContent?.length || 0,
        );
        for (const rect of part.getClientRects()) {
          const left = Math.max(rect.left, bounds.left),
            right = Math.min(rect.right, bounds.right);
          const top = Math.max(rect.top, bounds.top),
            bottom = Math.min(rect.bottom, bounds.bottom);
          if (right <= left || bottom <= top) continue;
          rects.push({
            page: number,
            x: (left - bounds.left) / bounds.width,
            y: (top - bounds.top) / bounds.height,
            width: (right - left) / bounds.width,
            height: (bottom - top) / bounds.height,
          });
        }
      }
    }
    if (!rects.length) return null;
    // Bound metadata for PDFs whose text layer contains one span per glyph.
    if (rects.length > 512) {
      const pages = new Map<number, PdfSourceRect>();
      for (const rect of rects) {
        const previous = pages.get(rect.page);
        if (!previous) pages.set(rect.page, { ...rect });
        else {
          const right = Math.max(previous.x + previous.width, rect.x + rect.width);
          const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
          previous.x = Math.min(previous.x, rect.x);
          previous.y = Math.min(previous.y, rect.y);
          previous.width = right - previous.x;
          previous.height = bottom - previous.y;
        }
      }
      rects = Array.from(pages.values());
    }
    return {
      kind: 'pdf',
      fileId: pdf.dataset.pdfFileId!,
      page: Math.min(...rects.map((r) => r.page)),
      endPage: Math.max(...rects.map((r) => r.page)),
      rects,
    };
  }
  const root = start?.closest('.read-content');
  if (!root || end?.closest('.read-content') !== root) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length,
    exact = range.toString(),
    text = root.textContent || '';
  if (!exact || exact.length > 100_000) return null;
  return {
    kind: 'text',
    versionId: root.getAttribute('data-version-id') || undefined,
    start: offset,
    end: offset + exact.length,
    exact,
    prefix: text.slice(Math.max(0, offset - 64), offset),
    suffix: text.slice(offset + exact.length, offset + exact.length + 64),
  };
}

function matchedOffset(
  text: string,
  location: TextSourceLocation,
  sameVersion: boolean,
): number | null {
  const { exact, prefix, suffix, start } = location;
  const contextMatches = (offset: number) =>
    text.slice(Math.max(0, offset - prefix.length), offset) === prefix &&
    text.slice(offset + exact.length, offset + exact.length + suffix.length) === suffix;
  if (sameVersion && text.slice(start, start + exact.length) === exact && contextMatches(start))
    return start;
  const candidates: number[] = [];
  for (let index = text.indexOf(exact); index >= 0; index = text.indexOf(exact, index + 1)) {
    candidates.push(index);
    // Avoid excessive work and guessing on highly repetitive content.
    if (candidates.length > 2000) return null;
  }
  if (candidates.length === 1) return candidates[0];
  const scores = candidates
    .map((offset) => {
      let score = 0;
      for (
        let i = 1;
        i <= prefix.length && offset >= i && text[offset - i] === prefix[prefix.length - i];
        i++
      )
        score++;
      for (let i = 0; i < suffix.length && text[offset + exact.length + i] === suffix[i]; i++)
        score++;
      return { offset, score };
    })
    .sort((a, b) => b.score - a.score);
  return scores[0]?.score > 0 && scores[0].score > (scores[1]?.score ?? -1)
    ? scores[0].offset
    : null;
}

export function clearSourceHighlight() {
  CSS.highlights?.delete('translation-source');
}

/**
 * The range a saved quote covers now, or an error instead of silently moving
 * to an ambiguous or missing occurrence. Pass `text` when locating many.
 */
export function textSourceRange(
  root: HTMLElement,
  location: TextSourceLocation,
  text = root.textContent || '',
): Range | string {
  const offset = matchedOffset(
    text,
    location,
    !!location.versionId && root.dataset.versionId === location.versionId,
  );
  if (offset === null) return '原文已修改或删除，无法准确定位。';
  return rangeAt(root, offset, location.exact.length) ?? '原文暂时无法定位，请等待正文加载完成后重试。';
}
// The range of `length` characters at `offset` in the root's text.
function rangeAt(root: HTMLElement, offset: number, size: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let position = 0,
    started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length || 0;
    if (!started && position + length > offset) {
      range.setStart(node, offset - position);
      started = true;
    }
    if (started && position + length >= offset + size) {
      range.setEnd(node, offset + size - position);
      return range;
    }
    position += length;
  }
  return null;
}

/** Highlights and scrolls to the first occurrence of a search word (ASCII case ignored). */
export function locateWord(root: HTMLElement, word: string): boolean {
  const text = (root.textContent || '').toLowerCase();
  const offset = text.indexOf(word.toLowerCase());
  const range = offset < 0 ? null : rangeAt(root, offset, word.length);
  if (!range) return false;
  clearSourceHighlight();
  if (typeof Highlight !== 'undefined' && CSS.highlights)
    CSS.highlights.set('translation-source', new Highlight(range));
  revealRange(root, range);
  return true;
}

/** Scrolls a range into the reading area, a little below its top edge. */
export function revealRange(root: HTMLElement, range: Range) {
  const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0);
  const area = root.closest<HTMLElement>('.note-scroll');
  if (rect && area) {
    area.scrollTop += rect.top - area.getBoundingClientRect().top - 48;
    area.focus({ preventScroll: true });
  }
}

/** Returns an error instead of silently moving to an ambiguous or missing occurrence. */
export function locateTextSource(
  root: HTMLElement,
  location: TextSourceLocation,
): string | undefined {
  const range = textSourceRange(root, location);
  if (typeof range === 'string')
    return range.startsWith('原文已修改') ? `${range}仍可在翻译记录中查看保存的原文。` : range;
  clearSourceHighlight();
  if (typeof Highlight !== 'undefined' && CSS.highlights)
    CSS.highlights.set('translation-source', new Highlight(range));
  else {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  revealRange(root, range);
}
