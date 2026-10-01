import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Languages, Quote } from 'lucide-react';
import { paperText } from '../paper';
import '../selection.css';

interface SelectedText {
  range: Range;
  text: string;
  first: DOMRect;
  last: DOMRect;
  host: HTMLElement;
  focusTarget: HTMLElement | null;
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
  };
}

export function SelectionToolbar({
  owner,
  onSelection,
  onQuote,
}: {
  owner: string;
  onSelection: (text: string) => void;
  onQuote: (text: string) => string | undefined;
}) {
  const [selected, setSelected] = useState<SelectedText | null>(null);
  const [status, setStatus] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0, arrow: 0, side: 'above' });
  const toolbar = useRef<HTMLDivElement>(null);
  const active = useRef(selected);
  const callbacks = useRef({ onSelection, onQuote });
  const dismiss = useRef(() => {});
  active.current = selected;
  callbacks.current = { onSelection, onQuote };

  useEffect(() => {
    let timer = 0,
      selecting = false;
    let dismissed: Range | null = null;
    const close = () => {
      window.clearTimeout(timer);
      const value = window.getSelection();
      dismissed = value?.rangeCount ? value.getRangeAt(0).cloneRange() : null;
      setSelected(null);
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
        setSelected(next);
      }
    };
    const schedule = () => {
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
      close();
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
  }, [owner]);

  useLayoutEffect(() => {
    if (!selected || !toolbar.current) return;
    const { width, height } = toolbar.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 10;
    const topEdge = (viewport?.offsetTop ?? 0) + 10;
    const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 20;
    const bottomEdge = topEdge + (viewport?.height ?? innerHeight) - 20;
    const above = selected.first.top - height - 12;
    const below = selected.last.bottom + 16;
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
  }, [selected, status]);

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
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(toolbar.current!.querySelectorAll('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
      }}
    >
      <div className="selection-actions">
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(selected.text);
              if (active.current === selected) setStatus('已复制');
            } catch {
              if (active.current === selected) setStatus('复制失败，请使用系统复制。');
            }
          }}
        >
          <Copy size={16} />
          复制
        </button>
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
          <Quote size={16} />
          加入助手
        </button>
        <button type="button" onClick={() => setStatus('翻译功能待接入')}>
          <Languages size={16} />
          翻译
        </button>
      </div>
      {status && (
        <p className="selection-status" role="status">
          {status}
        </p>
      )}
    </div>,
    selected.host,
  );
}
