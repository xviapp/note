import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import {
  Copy,
  Highlighter,
  Languages,
  MessageSquareQuote,
  MoreHorizontal,
  Share2,
  StickyNote,
  TextSelect,
} from 'lucide-react';
import { device } from '../mobile';
import { QingliIcon } from './QingliIcon';
import { addClip } from '../clips';
import { paperText } from '../paper';
import { captureSourceLocation } from '../source-location';
import type { TranslationLaunch } from '../translation';
import { TRANSLATION_LIMIT, type SourceLocation } from '../../shared/translation';
import '../selection.css';

interface SelectedText {
  range: Range;
  text: string;
  first: DOMRect;
  last: DOMRect;
  host: HTMLElement;
  focusTarget: HTMLElement | null;
  content: HTMLElement;
}

const controls = 'input, textarea, select, button, [contenteditable="true"], .cm-editor';
const elementAt = (node: Node) => (node instanceof Element ? node : node.parentElement);
const sameRange = (a: Range | undefined | null, b: Range) =>
  a?.startContainer === b.startContainer &&
  a.startOffset === b.startOffset &&
  a.endContainer === b.endContainer &&
  a.endOffset === b.endOffset;

function readSelection(owner: string): SelectedText | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const start = elementAt(range.startContainer),
    end = elementAt(range.endContainer);
  const scope = start?.closest<HTMLElement>('[data-selection-owner]');
  if (
    !scope ||
    scope.dataset.selectionOwner !== owner ||
    end?.closest('[data-selection-owner]') !== scope ||
    start?.closest(controls) ||
    end?.closest(controls)
  )
    return null;
  const dialog = scope.closest<HTMLDialogElement>('dialog[open]');
  if (!dialog && document.querySelector('dialog[open]')) return null;

  const fragment = range.cloneContents();
  let hasMath = false;
  // Keep one readable TeX source instead of copying KaTeX's visual and MathML layers twice.
  for (const math of fragment.querySelectorAll('.katex-mathml')) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) {
      hasMath = true;
      const delimiter =
        math.closest('.katex-display') || start?.closest('.katex-display') ? '$$' : '$';
      if (math.nextElementSibling?.matches('.katex-html')) math.nextElementSibling.remove();
      math.replaceWith(document.createTextNode(`${delimiter}${tex}${delimiter}`));
    }
  }
  const text = (
    hasMath || start?.closest('.paper-body') || fragment.querySelector('math')
      ? paperText(fragment)
      : selection.toString()
  ).trim();
  if (!text) return null;
  const viewport = window.visualViewport;
  const scroll =
    scope.closest<HTMLElement>('.note-scroll, .pdf-scroll, .assistant-messages') ||
    start?.closest<HTMLElement>('.note-scroll, .pdf-scroll, .assistant-messages');
  const bounds = scroll?.getBoundingClientRect();
  const top = Math.max(viewport?.offsetTop ?? 0, bounds?.top ?? 0);
  const bottom = Math.min(
    (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
    bounds?.bottom ?? Infinity,
  );
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom,
  );
  if (!rects.length) return null;
  return {
    range: range.cloneRange(),
    text,
    first: rects[0],
    last: rects[rects.length - 1],
    host: dialog || document.body,
    focusTarget: scroll || scope.closest<HTMLElement>('[tabindex]'),
    content:
      start!.closest<HTMLElement>(
        '.read-content, .plain-text, .paper-body, .pdf-text-layer, .markdown-body',
      ) || scope,
  };
}

export function SelectionToolbar({
  owner,
  onSelection,
  onQuote,
  onTranslate,
  onAnnotate,
  clipSource,
}: {
  owner: string;
  // The page a clip of the selection names as its source.
  clipSource?: { id: string; title: string } | null;
  onSelection: (text: string) => void;
  onQuote: (text: string) => string | undefined;
  onTranslate: (launch: TranslationLaunch) => void;
  // Highlights the selection, opening a note for it when `withNote` is set.
  // Returns an error to show, or a promise of one while it saves.
  onAnnotate?: (
    selection: { quote: string; location: SourceLocation | null },
    withNote: boolean,
  ) => string | undefined | Promise<string | undefined>;
}) {
  const [selected, setSelected] = useState<SelectedText | null>(null);
  const [status, setStatus] = useState('');
  const [more, setMore] = useState(false);
  const menuId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, arrow: 0, side: 'above' });
  const toolbar = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreOpen = useRef(more);
  const focusMenu = useRef(false);
  const active = useRef(selected);
  const callbacks = useRef({ onSelection, onQuote, onTranslate, onAnnotate });
  const dismiss = useRef(() => {});
  active.current = selected;
  moreOpen.current = more;
  callbacks.current = { onSelection, onQuote, onTranslate, onAnnotate };

  useEffect(() => {
    let timer = 0,
      selecting = false;
    let nativeSelection = false;
    const syncNative = (enabled: boolean) => {
      if (nativeSelection === enabled || Capacitor.getPlatform() !== 'android') return;
      nativeSelection = enabled;
      void device.setSelectionToolbar({ owner: menuId, enabled }).catch(() => {});
    };
    let dismissed: Range | null = null;
    const hide = () => {
      window.clearTimeout(timer);
      const value = window.getSelection();
      dismissed = value?.rangeCount ? value.getRangeAt(0).cloneRange() : null;
      setSelected(null);
      setMore(false);
    };
    // A selection left without our toolbar gets the system menu back.
    const close = () => {
      hide();
      syncNative(false);
    };
    dismiss.current = close;
    const refresh = () => {
      if (selecting) return;
      const next = readSelection(owner);
      if (next) callbacks.current.onSelection(next.text);
      if (!next || sameRange(dismissed, next.range)) {
        setSelected(null);
      } else if (
        !sameRange(active.current?.range, next.range) ||
        active.current?.text !== next.text
      ) {
        setStatus('');
        setMore(false);
        setSelected(next);
      }
    };
    const schedule = () => {
      // Keep the native menu hidden during handle drags, but not for a dismissed selection.
      const value = readSelection(owner);
      syncNative(!!value && !sameRange(dismissed, value.range));
      if (window.getSelection()?.isCollapsed) dismissed = null;
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 120);
    };
    const inside = (target: EventTarget | null) =>
      target instanceof Node && toolbar.current?.contains(target);
    const down = (event: PointerEvent) => {
      if (inside(event.target)) return;
      // Remember the selection before focus moves (e.g. opening the assistant).
      const value = readSelection(owner);
      if (value) callbacks.current.onSelection(value.text);
      // A new selection may start here; keep the native menu hidden meanwhile.
      hide();
      selecting = true;
    };
    const up = () => {
      selecting = false;
      schedule();
    };
    const focus = (event: FocusEvent) => {
      if (!inside(event.target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (!active.current || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (moreOpen.current) {
          setMore(false);
          if (inside(document.activeElement)) moreButton.current?.focus({ preventScroll: true });
          return;
        }
        if (inside(document.activeElement))
          active.current.focusTarget?.focus({ preventScroll: true });
        close();
      } else if (event.key === 'Tab' && !event.shiftKey && !inside(document.activeElement)) {
        event.preventDefault();
        toolbar.current?.querySelector('button')?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('focusin', focus);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.visualViewport?.addEventListener('resize', close);
    window.visualViewport?.addEventListener('scroll', close);
    return () => {
      syncNative(false);
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.visualViewport?.removeEventListener('resize', close);
      window.visualViewport?.removeEventListener('scroll', close);
    };
  }, [owner, menuId]);

  useLayoutEffect(() => {
    if (!selected || !toolbar.current) return;
    const { width, height } = toolbar.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 10;
    const topEdge = (viewport?.offsetTop ?? 0) + 10;
    const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 20;
    const bottomEdge = topEdge + (viewport?.height ?? innerHeight) - 20;
    const above = selected.first.top - height - 12;
    const below = selected.last.bottom + (matchMedia('(pointer: coarse)').matches ? 28 : 16);
    const useBelow = matchMedia('(pointer: coarse)').matches
      ? below + height <= bottomEdge || above < topEdge
      : above < topEdge && below + height <= bottomEdge;
    const anchor = useBelow ? selected.last : selected.first;
    const middle = (anchor.left + anchor.right) / 2;
    const left = Math.max(leftEdge, Math.min(middle - width / 2, rightEdge - width));
    setPosition({
      left,
      top: Math.max(topEdge, Math.min(useBelow ? below : above, bottomEdge - height)),
      arrow: Math.max(16, Math.min(width - 16, middle - left)),
      side: useBelow ? 'below' : 'above',
    });
    if (more && focusMenu.current) {
      toolbar.current
        .querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
      focusMenu.current = false;
    }
  }, [selected, status, more]);

  if (!selected) return null;
  return createPortal(
    <div
      ref={toolbar}
      className="selection-toolbar"
      role="toolbar"
      aria-label="选中文字操作"
      data-side={position.side}
      data-html2canvas-ignore="true"
      style={
        {
          left: position.left,
          top: position.top,
          '--selection-arrow': `${position.arrow}px`,
        } as CSSProperties
      }
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const inMenu = (event.target as HTMLElement).closest('[role="menu"]');
        if (event.target === moreButton.current && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          focusMenu.current = true;
          setMore(true);
          return;
        }
        if (inMenu && event.key === 'ArrowLeft') {
          event.preventDefault();
          setMore(false);
          moreButton.current?.focus({ preventScroll: true });
          return;
        }
        const forward = inMenu ? 'ArrowDown' : 'ArrowRight';
        const backward = inMenu ? 'ArrowUp' : 'ArrowLeft';
        if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(
          toolbar.current!.querySelectorAll<HTMLButtonElement>(
            inMenu ? '[role="menuitem"]' : '.selection-actions button',
          ),
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === forward ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
      }}
    >
      <div className="selection-bar">
        <div className="selection-actions">
          <button
            type="button"
            onClick={() => {
              const error = callbacks.current.onQuote(selected.text);
              if (error) {
                setStatus(error);
                return;
              }
              dismiss.current();
              window.getSelection()?.removeAllRanges();
            }}
          >
            <QingliIcon size={19} />
            问青藜
          </button>
          <button
            type="button"
            onClick={() => {
              if (selected.text.length > TRANSLATION_LIMIT) {
                setStatus(
                  `每次最多翻译 ${TRANSLATION_LIMIT.toLocaleString()} 个字符，请缩小选择范围。`,
                );
                return;
              }
              callbacks.current.onTranslate({
                source: selected.text,
                location: captureSourceLocation(selected.range),
                host: selected.host,
                anchor: {
                  left: selected.first.left,
                  top: selected.first.top,
                  bottom: selected.last.bottom,
                },
              });
              dismiss.current();
              window.getSelection()?.removeAllRanges();
            }}
          >
            <Languages size={16} />
            翻译
          </button>
          {onAnnotate && (
            <button type="button" onClick={() => void annotate(false)}>
              <Highlighter size={16} />
              高亮
            </button>
          )}
          <button
            ref={moreButton}
            type="button"
            aria-haspopup="menu"
            aria-expanded={more}
            aria-controls={more ? menuId : undefined}
            onClick={(event) => {
              focusMenu.current = event.detail === 0;
              setMore(!more);
            }}
          >
            <MoreHorizontal size={16} />
            更多
          </button>
        </div>
        {status && (
          <p className="selection-status" role="status">
            {status}
          </p>
        )}
      </div>
      {more && (
        <div className="selection-more" role="menu" aria-label="更多选文操作" id={menuId}>
          {onAnnotate && (
            <button type="button" role="menuitem" onClick={() => void annotate(true)}>
              <MessageSquareQuote size={16} />
              添加批注
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              try {
                await addClip(selected.text, clipSource ?? null);
                if (active.current === selected) {
                  setMore(false);
                  setStatus('已存入随手记');
                }
              } catch (error) {
                if (active.current === selected) {
                  setMore(false);
                  setStatus((error as Error).message);
                }
              }
            }}
          >
            <StickyNote size={16} />
            记一下
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(selected.text);
                if (active.current === selected) {
                  setMore(false);
                  setStatus('已复制');
                }
              } catch {
                if (active.current === selected) {
                  setMore(false);
                  setStatus('复制失败，请重试。');
                }
              }
            }}
          >
            <Copy size={16} />
            复制
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMore(false);
              const selection = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(selected.content);
              selection?.removeAllRanges();
              selection?.addRange(range);
            }}
          >
            <TextSelect size={16} />
            全选
          </button>
          {(Capacitor.getPlatform() === 'android' || typeof navigator.share === 'function') && (
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                try {
                  if (Capacitor.getPlatform() === 'android')
                    await device.shareText({ text: selected.text });
                  else await navigator.share({ text: selected.text });
                  if (active.current === selected) dismiss.current();
                } catch (error) {
                  if (active.current !== selected) return;
                  setMore(false);
                  // APKs older than the site have no native share; copy instead.
                  if ((error as { code?: string }).code === 'UNIMPLEMENTED') {
                    try {
                      await navigator.clipboard.writeText(selected.text);
                      if (active.current === selected) setStatus('已复制。当前应用版本不支持分享，更新后可用。');
                    } catch {
                      if (active.current === selected) setStatus('分享失败，请重试。');
                    }
                  } else if (!(error instanceof Error && error.name === 'AbortError'))
                    setStatus('分享失败，请重试。');
                }
              }}
            >
              <Share2 size={16} />
              分享
            </button>
          )}
        </div>
      )}
    </div>,
    selected.host,
  );

  async function annotate(withNote: boolean) {
    if (!selected) return;
    const error = await callbacks.current.onAnnotate?.(
      { quote: selected.text, location: captureSourceLocation(selected.range) },
      withNote,
    );
    if (active.current !== selected) return;
    if (error) {
      setMore(false);
      setStatus(error);
      return;
    }
    dismiss.current();
    window.getSelection()?.removeAllRanges();
  }
}
