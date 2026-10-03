import { memo, useEffect, useMemo, useRef } from 'react';
import type { NoteDetail } from '../../shared/types';
import type { Heading } from './MarkdownView';
import { paperFragment, paperText } from '../paper';
import '../paper.css';
import { fileBlob } from '../offline-cache';
import { imageUrl } from '../image-url';
import { internalFileId } from './CachedImage';

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
  const prepared = useMemo(() => {
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
  }, [note.id, note.content, note.url, note.attachments]);
  useEffect(() => {
    ref.current?.replaceChildren(prepared.fragment.cloneNode(true));
    onHeadings(prepared.headings);
    let active = true;
    const revokes: (() => void)[] = [];
    for (const image of ref.current?.querySelectorAll('img') ?? []) {
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
  }, [prepared, onHeadings]);
  const imageAction = (target: EventTarget | null) => {
    if (target instanceof HTMLImageElement) {
      onImage(target.dataset.fileSource || target.src, target.alt || '论文插图');
      return true;
    }
    return false;
  };
  return (
    <div
      className="paper-body"
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
