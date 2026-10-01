import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronUp,
  Languages,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  X,
} from 'lucide-react';
import type { TranslationLaunch } from '../translation';
import '../translation.css';

function viewportBounds() {
  const viewport = window.visualViewport;
  return {
    x: viewport?.offsetLeft ?? 0,
    y: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? innerWidth,
    height: viewport?.height ?? innerHeight,
  };
}

export function TranslationWindow({
  launch,
  onClose,
  expanded,
  onExpandedChange,
  canCollapse = true,
  children,
}: {
  launch: TranslationLaunch;
  onClose: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  canCollapse?: boolean;
  children: ReactNode;
}) {
  const [viewport, setViewport] = useState(viewportBounds);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false),
    [maximized, setMaximized] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState(80);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number } | null>(
    null,
  );
  const fullscreen = expanded && maximized;
  const width = Math.max(1, Math.min(expanded ? 440 : 360, viewport.width - 24));
  const maxHeight = Math.max(
    1,
    Math.min(expanded ? 540 : 360, viewport.height - 24, viewport.height * (expanded ? 0.76 : 0.6)),
  );
  const height = expanded ? maxHeight : Math.min(measuredHeight, maxHeight);
  const clamp = (x: number, y: number) => ({
    x: Math.max(viewport.x + 12, Math.min(x, viewport.x + viewport.width - width - 12)),
    y: Math.max(viewport.y + 12, Math.min(y, viewport.y + viewport.height - height - 12)),
  });
  const anchor = launch.anchor;
  const initialY = anchor
    ? anchor.bottom + 12 + (expanded ? height : Math.min(160, maxHeight)) <=
      viewport.y + viewport.height - 12
      ? anchor.bottom + 12
      : anchor.top - height - 12
    : viewport.y + (viewport.height - height) / 2;
  const point = clamp(
    position?.x ?? anchor?.left ?? viewport.x + (viewport.width - width) / 2,
    position?.y ?? initialY,
  );
  const host = launch.host?.isConnected ? launch.host : document.body;

  useLayoutEffect(() => {
    const element = panel.current!;
    const measure = () => setMeasuredHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, width, maxHeight]);
  const toggleDetails = (next: boolean) => {
    if (!next) {
      setMaximized(false);
      setPinned(false);
    }
    onExpandedChange(next);
    requestAnimationFrame(() =>
      panel.current
        ?.querySelector<HTMLButtonElement>(next ? '.translation-collapse' : '.translation-expand')
        ?.focus({ preventScroll: true }),
    );
  };

  useEffect(() => {
    const update = () => setViewport(viewportBounds());
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [launch]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if ((expanded && pinned) || fullscreen || !(event.target instanceof Node)) return;
      if (panel.current?.contains(event.target)) return;
      // A confirmation dialog belongs to the translation panel even in the top layer.
      if (
        event.target instanceof Element &&
        event.target.closest('dialog') !== host &&
        event.target.closest('dialog')
      )
        return;
      close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== 'Escape') return;
      const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
      if (dialogs.length && dialogs.at(-1) !== host.closest('dialog')) return;
      event.preventDefault();
      event.stopPropagation();
      if (fullscreen) setMaximized(false);
      else close.current();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
    };
  }, [pinned, fullscreen, expanded, host]);
  const endDrag = () => {
    drag.current = null;
  };
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="翻译"
      aria-modal={fullscreen || undefined}
      tabIndex={-1}
      className={`translation-window${expanded ? '' : ' translation-compact'}${fullscreen ? ' translation-maximized' : ''}`}
      data-html2canvas-ignore="true"
      style={
        fullscreen
          ? { left: viewport.x, top: viewport.y, width: viewport.width, height: viewport.height }
          : { left: point.x, top: point.y, width, ...(expanded ? { height } : { maxHeight }) }
      }
      onKeyDown={(event) => {
        if (!fullscreen || event.key !== 'Tab') return;
        const buttons = Array.from(
          panel.current!.querySelectorAll<HTMLElement>('button,a[href],select,summary,[tabindex]'),
        ).filter(
          (element) =>
            !element.matches(':disabled') &&
            element.tabIndex >= 0 &&
            element.getClientRects().length,
        );
        if (
          event.shiftKey &&
          (document.activeElement === buttons[0] || document.activeElement === panel.current)
        ) {
          event.preventDefault();
          buttons.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
          event.preventDefault();
          buttons[0]?.focus();
        }
      }}
    >
      {expanded && (
        <header className="translation-heading">
          <div
            className="translation-drag"
            role="group"
            aria-label="移动翻译窗口"
            tabIndex={maximized ? -1 : 0}
            title={maximized ? undefined : '拖动移动，方向键微调'}
            onPointerDown={(event) => {
              if (maximized || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                id: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                ...point,
              };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (start?.id === event.pointerId)
                setPosition(
                  clamp(
                    start.x + event.clientX - start.startX,
                    start.y + event.clientY - start.startY,
                  ),
                );
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={(event) => {
              if (
                maximized ||
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
              )
                return;
              event.preventDefault();
              const step = event.shiftKey ? 40 : 10;
              setPosition(
                clamp(
                  point.x +
                    (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
                  point.y +
                    (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
                ),
              );
            }}
          >
            <Languages size={18} />
            <strong>翻译</strong>
          </div>
          {canCollapse && (
            <button
              className="icon-button translation-collapse"
              aria-label="收起翻译详情"
              aria-expanded="true"
              title="收起详情"
              onClick={() => toggleDetails(false)}
            >
              <ChevronUp size={16} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label={pinned ? '取消固定翻译窗口' : '固定翻译窗口'}
            aria-pressed={pinned}
            title={pinned ? '取消固定' : '固定窗口'}
            onClick={() => setPinned((value) => !value)}
          >
            {pinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
          <button
            className="icon-button"
            aria-label={maximized ? '还原翻译窗口' : '最大化翻译窗口'}
            title={maximized ? '还原' : '最大化'}
            onClick={() => setMaximized((value) => !value)}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button className="icon-button" aria-label="关闭翻译窗口" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
      )}
      {children}
      {!expanded && (
        <button
          className="icon-button translation-expand"
          aria-label="展开翻译详情"
          aria-expanded="false"
          title="展开详情"
          onClick={() => toggleDetails(true)}
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>,
    host,
  );
}
