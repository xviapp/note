import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { BookOpenText, Languages, List, RotateCcw, X } from 'lucide-react';
import type { NoteDetail } from '../../shared/types';
import {
  isTranslationLanguage,
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from '../../shared/translation';
import { GLOSSARY_SOURCE_CHARS, type PaperBlockSource } from '../../shared/paper-translation';
import { applyTranslation, blockHash, paperBlocks, type PaperBlock } from '../paper-blocks';
import { usePaperTranslation } from '../use-paper-translation';
import { hydratePaperImages, preparePaper } from './PaperView';
import '../paper.css';
import { GlossaryDialog } from './GlossaryDialog';

const LANGUAGE_KEY = 'paper-translation-language',
  TOC_KEY = 'paper-compare-toc';
type Anchor = { index: number; ratio: number; offset: number };
type Block = PaperBlock & { hash: string };

// Where the reader is in a pane: the first paragraph reaching the top edge,
// and how far into it. Pairing by paragraph keeps both sides on the same text
// even though a translation is shorter or longer than its source.
function anchorOf(pane: HTMLElement): Anchor | null {
  const top = pane.getBoundingClientRect().top;
  for (const element of pane.querySelectorAll<HTMLElement>('[data-block]')) {
    const box = element.getBoundingClientRect();
    if (box.bottom <= top + 1) continue;
    return {
      index: Number(element.dataset.block),
      ratio: box.top >= top ? 0 : (top - box.top) / Math.max(1, box.height),
      offset: Math.max(0, box.top - top),
    };
  }
  return null;
}
// Scrolls a pane so the same paragraph sits at the same place; true if it moved.
function align(pane: HTMLElement, anchor: Anchor) {
  const element = pane.querySelector<HTMLElement>(`[data-block="${anchor.index}"]`);
  if (!element) return false;
  const box = element.getBoundingClientRect(),
    top = pane.getBoundingClientRect().top;
  const before = pane.scrollTop;
  pane.scrollTop += box.top + anchor.ratio * box.height - anchor.offset - top;
  return pane.scrollTop !== before;
}

// Full-screen comparison of a paper and its saved translation: source on the
// left, translation on the right, scrolled together paragraph by paragraph.
// Phones show one side at a time and keep the place when switching.
export default function CompareView({ note, onClose }: { note: NoteDetail; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panes = { source: useRef<HTMLDivElement>(null), translation: useRef<HTMLDivElement>(null) };
  const [language, setLanguage] = useState<TranslationLanguage>(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY);
      return isTranslationLanguage(saved) ? saved : 'zh-CN';
    } catch {
      return 'zh-CN';
    }
  });
  const [side, setSide] = useState<'source' | 'translation'>('translation');
  // The outline is remembered on computers; phones open it as an overlay.
  const narrow = () => matchMedia('(max-width: 760px)').matches;
  const [tocOpen, setTocOpen] = useState(() => {
    try {
      return !narrow() && localStorage.getItem(TOC_KEY) === 'open';
    } catch {
      return false;
    }
  });
  const [headingLabels, setHeadingLabels] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<PaperBlockSource[] | null>(null);
  const [active, setActive] = useState<{ index: number; top: number } | null>(null),
    [glossaryOpen, setGlossaryOpen] = useState(false),
    // Bumped by scrolling, so the current section is recomputed.
    [, setScrolled] = useState(0);
  const blocks = useRef<Block[]>([]);
  const prepared = useMemo(
    () => preparePaper(note),
    // Only these fields of the note shape the article.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [note.id, note.content, note.url, note.attachments],
  );
  const translation = usePaperTranslation(note.id, language, sources);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  // Both sides are clones of the same article, so their paragraphs pair up by order.
  useEffect(() => {
    const source = panes.source.current?.firstElementChild,
      target = panes.translation.current?.firstElementChild;
    if (!source || !target) return;
    source.replaceChildren(prepared.fragment.cloneNode(true));
    target.replaceChildren(prepared.fragment.cloneNode(true));
    const left = paperBlocks(source),
      right = paperBlocks(target);
    left.forEach((block, index) =>
      (block.element as HTMLElement).setAttribute('data-block', String(index)),
    );
    right.forEach((block, index) => {
      block.element.setAttribute('data-block', String(index));
      block.element.classList.add('is-pending');
    });
    let live = true;
    void Promise.all(right.map((block) => blockHash(block.text))).then((hashes) => {
      if (!live) return;
      blocks.current = right.map((block, index) => ({ ...block, hash: hashes[index] }));
      setSources(blocks.current.map(({ hash, text }) => ({ hash, text })));
    });
    const releaseSource = hydratePaperImages(source),
      releaseTarget = hydratePaperImages(target);
    return () => {
      live = false;
      releaseSource();
      releaseTarget();
    };
    // The panes' refs are stable; the article is what changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared]);
  // Saved translations replace the paragraphs they belong to; the rest wait.
  useEffect(() => {
    if (!sources) return;
    for (const block of blocks.current) {
      const text = translation.blocks[block.hash];
      const element = block.element as HTMLElement;
      if (text && element.dataset.applied !== text) {
        applyTranslation(block, text);
        element.dataset.applied = text;
        element.classList.remove('is-pending');
      }
    }
    // Translated headings name the outline's entries.
    const target = panes.translation.current;
    const labels: Record<string, string> = {};
    for (const heading of prepared.headings) {
      const element = target?.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`);
      if (element?.dataset.applied) labels[heading.id] = element.textContent?.trim() ?? '';
    }
    setHeadingLabels(labels);
    // The panes' refs are stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [translation.blocks, sources, prepared]);
  const toggleToc = () => {
    const next = !tocOpen;
    setTocOpen(next);
    if (narrow()) return;
    try {
      localStorage.setItem(TOC_KEY, next ? 'open' : 'closed');
    } catch {
      /* Storage can be unavailable; the outline still toggles. */
    }
  };
  // Jumps the side being read; the other follows by paragraph.
  const jumpTo = (id: string) => {
    const pane = narrow() ? panes[side].current : panes.source.current;
    const element = pane?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (pane && element)
      pane.scrollTop += element.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    if (narrow()) setTocOpen(false);
  };

  // Scrolling either side brings the other along. A side moved by code
  // ignores its own next scroll event so the two never pull at each other.
  useEffect(() => {
    const source = panes.source.current,
      target = panes.translation.current;
    if (!source || !target) return;
    let ignore: HTMLElement | null = null,
      frame = 0;
    const follow = (from: HTMLElement, to: HTMLElement) => () => {
      // Either way the outline's current section may have changed.
      setScrolled((count) => count + 1);
      if (ignore === from) {
        ignore = null;
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // A hidden side (one at a time on phones) catches up when shown.
        if (!to.offsetParent) return;
        const anchor = anchorOf(from);
        if (anchor && align(to, anchor)) ignore = to;
      });
      setActive(null);
      setScrolled((count) => count + 1);
    };
    const fromSource = follow(source, target),
      fromTarget = follow(target, source);
    source.addEventListener('scroll', fromSource, { passive: true });
    target.addEventListener('scroll', fromTarget, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      source.removeEventListener('scroll', fromSource);
      target.removeEventListener('scroll', fromTarget);
    };
    // The panes' refs are stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const switchSide = (next: 'source' | 'translation') => {
    if (next === side) return;
    const from = panes[side].current,
      anchor = from && anchorOf(from);
    setSide(next);
    requestAnimationFrame(() => {
      const to = panes[next].current;
      if (to && anchor) align(to, anchor);
    });
  };
  const chooseLanguage = (value: string) => {
    if (!isTranslationLanguage(value)) return;
    setLanguage(value);
    try {
      localStorage.setItem(LANGUAGE_KEY, value);
    } catch {
      /* Storage can be unavailable; the choice still applies now. */
    }
  };
  // In-article links move within their own side.
  const followLink = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest('a');
    const href = anchor?.getAttribute('href');
    if (!href?.startsWith('#')) return;
    event.preventDefault();
    event.currentTarget
      .querySelector(`#${CSS.escape(href.slice(1))}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const total = sources ? new Set(sources.map((block) => block.hash)).size : 0;
  const done = sources
    ? new Set(sources.filter((block) => block.hash in translation.blocks).map((b) => b.hash)).size
    : 0;
  const characters = sources?.reduce((sum, block) => sum + block.text.length, 0) ?? 0;
  const running = translation.state === 'running';
  const activeBlock = active ? blocks.current[active.index] : null;
  // The glossary is drawn from the title, abstract and headings.
  const glossaryText = () =>
    [
      note.title,
      ...blocks.current
        .filter(
          (block) =>
            block.element.matches('h1,h2,h3,h4,h5,h6') || block.element.closest('.ltx_abstract'),
        )
        .map((block) => block.text),
    ]
      .join('\n')
      .slice(0, GLOSSARY_SOURCE_CHARS);
  // The section the reader is in: the innermost one around the top paragraph.
  const section = (() => {
    const pane = panes[side].current;
    const anchor = pane && sources ? anchorOf(pane) : null;
    const element = anchor ? blocks.current[anchor.index]?.element : null;
    const container = element?.closest('section, .ltx_abstract');
    if (!container) return [];
    return blocks.current.filter((block) => container.contains(block.element));
  })();
  const sectionPending = section.filter((block) => !(block.hash in translation.blocks)).length;
  const sourceOf = (block: Block) => ({ hash: block.hash, text: block.text });
  // The section being read: the last heading at or above the top of the pane.
  const activeHeading = (() => {
    const pane = panes[side].current;
    if (!pane || !tocOpen) return null;
    const box = pane.getBoundingClientRect();
    // At the end, the last sections can no longer reach the top edge: the
    // last heading in view counts as the one being read.
    const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
    const edge = atEnd ? box.bottom - 40 : box.top + 8;
    let current: string | null = null;
    for (const heading of prepared.headings) {
      const element = pane.querySelector(`#${CSS.escape(heading.id)}`);
      if (element && element.getBoundingClientRect().top <= edge) current = heading.id;
    }
    return current;
  })();
  return (
    <dialog
      ref={dialog}
      className={`compare-view show-${side}`}
      aria-label={`对照阅读：${note.title}`}
      onCancel={(event) => {
        event.preventDefault();
        if (running) translation.stop();
        onClose();
      }}
    >
      <header className="compare-header">
        <h2>对照阅读</h2>
        <div className="compare-sides" role="group" aria-label="显示">
          <button
            className={side === 'source' ? 'active' : ''}
            onClick={() => switchSide('source')}
          >
            原文
          </button>
          <button
            className={side === 'translation' ? 'active' : ''}
            onClick={() => switchSide('translation')}
          >
            译文
          </button>
        </div>
        <div className="compare-tools">
          <label className="compare-language">
            <span className="sr-only">译为</span>
            <select
              aria-label="译为"
              value={language}
              disabled={running}
              onChange={(event) => chooseLanguage(event.target.value)}
            >
              {Object.entries(TRANSLATION_LANGUAGES).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span className="compare-progress" role="status">
            {translation.state === 'loading' || !sources
              ? '正在读取…'
              : done === total
                ? `已全部翻译 · ${total} 段`
                : `已翻译 ${done}/${total} 段${done ? '' : ` · 约 ${Math.ceil(characters / 1000)} 千字符`}`}
          </span>
          {running ? (
            <button className="button compact" onClick={translation.stop}>
              停止
            </button>
          ) : (
            sources &&
            translation.state !== 'loading' &&
            done < total && (
              <>
                {sectionPending > 0 && sectionPending < total - done && (
                  <button
                    className="button compact"
                    aria-label={`只翻译本节（${sectionPending} 段）`}
                    onClick={() =>
                      void translation.run(section.map(sourceOf), { glossaryText: glossaryText() })
                    }
                  >
                    {/* One span, so the button's flex gap does not split the words. */}
                    <span>
                      <span className="compare-long">只翻译</span>本节（{sectionPending} 段）
                    </span>
                  </button>
                )}
                <button
                  className="button compact primary"
                  onClick={() => void translation.run(sources, { glossaryText: glossaryText() })}
                >
                  <Languages size={15} />
                  {done ? '继续翻译' : '翻译全文'}
                </button>
              </>
            )
          )}
        </div>
        <button
          className="icon-button toc-toggle compare-outline"
          aria-label="目录"
          title={tocOpen ? '隐藏目录' : '显示目录'}
          aria-expanded={tocOpen}
          aria-controls="compare-outline"
          disabled={!prepared.headings.length}
          onClick={toggleToc}
        >
          <List size={18} />
        </button>
        <button
          className="icon-button compare-glossary"
          aria-label="术语表"
          title="术语表"
          disabled={translation.state === 'loading'}
          onClick={() => setGlossaryOpen(true)}
        >
          <BookOpenText size={18} />
        </button>
        <button className="icon-button compare-close" aria-label="关闭对照阅读" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {translation.error && (
        <p className="compare-error" role="alert">
          {translation.error}
        </p>
      )}
      {translation.notice && <p className="compare-notice">{translation.notice}</p>}
      {glossaryOpen && (
        <GlossaryDialog
          glossary={translation.glossary}
          busy={running}
          onSave={translation.saveGlossary}
          // Translated paragraphs that use a changed term, to translate again.
          affected={(changed) =>
            blocks.current
              .filter(
                (block) =>
                  block.hash in translation.blocks &&
                  changed.some((term) => block.text.toLowerCase().includes(term.toLowerCase())),
              )
              .map(sourceOf)
          }
          onRetranslate={(list) => {
            setGlossaryOpen(false);
            void translation.run(list, { refresh: true });
          }}
          onClose={() => setGlossaryOpen(false)}
        />
      )}
      <div className="compare-body">
        {tocOpen && (
          <nav id="compare-outline" className="toc compare-toc" aria-label="目录">
            {prepared.headings.map((heading) => (
              <button
                key={heading.id}
                className={activeHeading === heading.id ? 'active' : ''}
                aria-current={activeHeading === heading.id ? 'location' : undefined}
                style={{ paddingLeft: 12 + (heading.level - 1) * 10 }}
                onClick={() => jumpTo(heading.id)}
              >
                {(side === 'translation' && headingLabels[heading.id]) || heading.title || '无标题'}
              </button>
            ))}
          </nav>
        )}
        <div ref={panes.source} className="compare-pane is-source" role="region" aria-label="原文">
          <div className="paper-body" onClick={followLink} />
        </div>
        <div
          ref={panes.translation}
          className="compare-pane is-translation"
          role="region"
          aria-label="译文"
          onClick={(event) => {
            const element = (event.target as Element).closest<HTMLElement>('[data-block]');
            if (element?.dataset.applied)
              setActive({ index: Number(element.dataset.block), top: element.offsetTop });
          }}
        >
          <div className="paper-body" onClick={followLink} />
          {activeBlock && !running && (
            <button
              className="button compact compare-redo"
              style={{ top: active!.top }}
              onClick={(event) => {
                event.stopPropagation();
                setActive(null);
                void translation.run([sourceOf(activeBlock)], { refresh: true });
              }}
            >
              <RotateCcw size={14} />
              重译这一段
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
