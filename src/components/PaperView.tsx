import { memo, useEffect, useMemo, useRef } from 'react';
import type { NoteDetail } from '../../shared/types';
import type { Heading } from './MarkdownView';
import { paperFragment, paperText } from '../paper';
import '../paper.css';
import { fileBlob } from '../offline-cache';
import { imageUrl } from '../image-url';
import { internalFileId } from './CachedImage';

type PreparedPaper = { fragment: DocumentFragment; headings: Heading[] };
// Sanitizing a long paper takes about a second on a phone, and the reader, the
// translation session and the comparison view all need it. Keep the last few
// results; every caller gets its own copy of the fragment to change freely.
const prepared = new Map<string, PreparedPaper>();
const PREPARED_LIMIT = 3;

// The paper's article as a fragment: local anchors, private images only, and
// heading IDs for the outline. Shared by the reader and the comparison view.
export function preparePaper(note: NoteDetail): PreparedPaper {
  const key = [
    note.id,
    note.url,
    note.attachments.map((file) => file.id).join(','),
    note.content,
  ].join('\n');
  let paper = prepared.get(key);
  if (paper) prepared.delete(key);
  else paper = buildPaper(note);
  prepared.set(key, paper);
  if (prepared.size > PREPARED_LIMIT) prepared.delete(prepared.keys().next().value!);
  return { fragment: paper.fragment.cloneNode(true) as DocumentFragment, headings: paper.headings };
}
function buildPaper(note: NoteDetail): PreparedPaper {
  const fragment = paperFragment(note.content),
    prefix = `paper-${note.id}-`;
  fragment.querySelector('.ltx_title_document')?.remove();
  const files = new Set(
    note.attachments
      .filter((file) => file.mime.startsWith('image/'))
      .map((file) => `/api/files/${file.id}`),
  );
  for (const element of fragment.querySelectorAll('[id]')) element.id = prefix + element.id;
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>('a')) {
    const value = anchor.getAttribute('href') || '';
    try {
      const url = new URL(value, note.url!);
      if (value.startsWith('#') || (url.origin + url.pathname === note.url && url.hash)) {
        anchor.setAttribute('href', `#${prefix}${decodeURIComponent(url.hash.slice(1))}`);
      } else if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
        anchor.href = url.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      } else anchor.removeAttribute('href');
    } catch {
      anchor.removeAttribute('href');
    }
  }
  for (const image of fragment.querySelectorAll<HTMLImageElement>('img')) {
    if (!files.has(image.getAttribute('src') || '')) {
      image.remove();
      continue;
    }
    image.loading = 'lazy';
    image.decoding = 'async';
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', `放大图片：${image.alt || '论文插图'}`);
  }
  const headings = Array.from(fragment.querySelectorAll('h2,h3,h4,h5,h6'))
    .filter((heading) => !heading.closest('.ltx_theorem, .ltx_proof'))
    .map((heading, index) => {
      // Source section IDs remain intact for equation/citation links.
      heading.id ||= `heading-${prefix}${index}`;
      heading.setAttribute('data-paper-heading', '');
      return {
        id: heading.id,
        title: paperText(heading).replace(/^#+\s*/, ''),
        level: heading.matches('.ltx_title_abstract, .ltx_title_bibliography')
          ? 1
          : Math.max(1, Number(heading.tagName[1]) - 1),
      };
    });
  return { fragment, headings };
}

// Private images load as blob (or SVG data) URLs; the cleanup releases them.
export function hydratePaperImages(root: Element | DocumentFragment | null) {
  let active = true;
  const revokes: (() => void)[] = [];
  for (const image of root?.querySelectorAll('img') ?? []) {
    const source = image.getAttribute('src') || '';
    const id = internalFileId(source);
    if (!id) continue;
    image.removeAttribute('src');
    image.dataset.fileSource = source;
    void fileBlob(id)
      .then(imageUrl)
      .then(({ url, revoke }) => {
        if (!active) return revoke();
        revokes.push(revoke);
        image.src = url;
      })
      .catch(() => {});
  }
  return () => {
    active = false;
    revokes.forEach((revoke) => revoke());
  };
}

export const PaperView = memo(function PaperView({
  note,
  onHeadings,
  onImage,
}: {
  note: NoteDetail;
  onHeadings: (headings: Heading[]) => void;
  onImage: (src: string, alt: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A refreshed copy of the same note (from the server after the cached one)
  // keeps the article as it is.
  const files = note.attachments.map((file) => file.id).join(',');
  const paper = useMemo(
    () => preparePaper(note),
    // Only these fields of the note shape the article.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [note.id, note.content, note.url, files],
  );
  useEffect(() => {
    ref.current?.replaceChildren(paper.fragment.cloneNode(true));
    onHeadings(paper.headings);
    return hydratePaperImages(ref.current);
  }, [paper, onHeadings]);
  const imageAction = (target: EventTarget | null) => {
    if (target instanceof HTMLImageElement) {
      onImage(target.dataset.fileSource || target.src, target.alt || '论文插图');
      return true;
    }
    return false;
  };
  return (
    <div
      className="paper-body paper-reader"
      ref={ref}
      onClick={(event) => {
        if (imageAction(event.target)) {
          event.preventDefault();
          return;
        }
        const anchor = (event.target as Element).closest('a');
        const href = anchor?.getAttribute('href');
        if (href?.startsWith('#')) {
          event.preventDefault();
          ref.current
            ?.querySelector(`#${CSS.escape(href.slice(1))}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }}
      onKeyDown={(event) => {
        if (['Enter', ' '].includes(event.key) && imageAction(event.target)) event.preventDefault();
      }}
    />
  );
});
