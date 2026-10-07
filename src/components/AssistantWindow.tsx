import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { assistantHost } from '../assistant-host';
import { Maximize2, Minimize2, PanelRight, PanelsTopLeft, X } from 'lucide-react';
import { QingliIcon } from './QingliIcon';

export type AssistantMode = 'floating' | 'docked' | 'maximized';
// On phones 青藜 is a bottom sheet: most of the screen with the page still
// showing above it, or full screen.
type SheetSize = 'half' | 'full';
const SHEET_KEY = 'assistant-sheet';
const HALF = 0.7;
const tallest = { width: 0, height: 0 };
function savedSheet(): SheetSize {
  try {
    return localStorage.getItem(SHEET_KEY) === 'full' ? 'full' : 'half';
  } catch {
    return 'half';
  }
}

function viewportBounds() {
  const viewport = window.visualViewport;
  return {
    x: viewport?.offsetLeft ?? 0,
    y: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

// While reading on a phone, the launcher steps aside as the page scrolls down
// and returns when scrolling up or pausing (the CSS applies it on phones only).
function useScrollAway() {
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    const last = new WeakMap<EventTarget, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scrolled = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.assistant-panel')) return;
      const top = target.scrollTop,
        previous = last.get(target) ?? top;
      last.set(target, top);
      if (top - previous > 6) setTucked(true);
      else if (previous - top > 6) setTucked(false);
      clearTimeout(timer);
      timer = setTimeout(() => setTucked(false), 900);
    };
    document.addEventListener('scroll', scrolled, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('scroll', scrolled, { capture: true });
    };
  }, []);
  return tucked;
}
export function AssistantWindow({
  title,
  label = '青藜',
  showLauncher = true,
  visible,
  hidden,
  busy,
  mode,
  onModeChange,
  readingRoot,
  onOpen,
  onClose,
  actions,
  children,
}: {
  title: string;
  label?: string;
  showLauncher?: boolean;
  visible: boolean;
  hidden: boolean;
  busy: boolean;
  mode: AssistantMode;
  onModeChange: (mode: AssistantMode) => void;
  readingRoot: RefObject<HTMLDivElement | null>;
  onOpen: () => void;
  onClose: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const restoreMode = useRef<AssistantMode>('floating');
  const [viewport, setViewport] = useState(viewportBounds);
  const compact = viewport.width <= 760;
  const sheet = compact;
  const [sheetSize, setSheetSizeState] = useState<SheetSize>(savedSheet);
  // Only switching size animates; resizing the window or the keyboard does not.
  const [animating, setAnimating] = useState(false);
  const animation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setSheetSize = (size: SheetSize) => {
    setSheetSizeState(size);
    setAnimating(true);
    clearTimeout(animation.current);
    animation.current = setTimeout(() => setAnimating(false), 250);
    try {
      localStorage.setItem(SHEET_KEY, size);
    } catch {
      /* Optional preference. */
    }
  };
  const [pull, setPull] = useState<{ id: number; startY: number; offset: number } | null>(null);
  // The keyboard leaves too little of a part-height sheet, so while it shows
  // the sheet fills the screen, and returns to its size once it is put away.
  // The keyboard shrinks the visual viewport below the tallest height seen.
  // (Kept for the page, not the panel: the layout can remount it meanwhile.)
  if (tallest.width !== Math.round(viewport.width)) {
    tallest.width = Math.round(viewport.width);
    tallest.height = 0;
  }
  tallest.height = Math.max(tallest.height, viewport.height);
  const keyboard = sheet && tallest.height - viewport.height > 120;
  const keyboardSeen = useRef(0);
  useEffect(() => {
    if (keyboard) return () => void (keyboardSeen.current = Date.now());
  }, [keyboard]);
  const fullscreen = compact ? !sheet || sheetSize === 'full' || keyboard : mode === 'maximized';
  const [dockBounds, setDockBounds] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const panel = useRef<HTMLElement>(null),
    launcher = useRef<HTMLButtonElement>(null);
  const tucked = useScrollAway();
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number } | null>(
    null,
  );
  const margin = compact ? 12 : 24;
  const [appendTop, setAppendTop] = useState<number | null>(null);
  // The reading element can be replaced on navigation while its ref stays the same.
  useLayoutEffect(() => {
    const root = readingRoot.current;
    if (!root) return;
    let footer: Element | null = null;
    const measure = () => {
      const next = root.querySelector('.quick-append-footer');
      if (footer !== next) {
        if (footer) resize.unobserve(footer);
        footer = next;
        if (footer) resize.observe(footer);
      }
      setAppendTop(footer?.getClientRects().length ? footer.getBoundingClientRect().top : null);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    const mutations = new MutationObserver(measure);
    mutations.observe(root, { childList: true, subtree: true });
    measure();
    return () => { resize.disconnect(); mutations.disconnect(); };
  });
  const width = Math.max(1, Math.min(440, viewport.width - margin * 2));
  const height = Math.max(
    1,
    Math.min(
      680,
      viewport.height - margin * 2,
      viewport.height < 520 ? viewport.height : viewport.height * (compact ? 0.74 : 0.8),
    ),
  );
  const clamp = (x: number, y: number) => ({
    x: Math.max(viewport.x + margin, Math.min(x, viewport.x + viewport.width - width - margin)),
    y: Math.max(viewport.y + margin, Math.min(y, viewport.y + viewport.height - height - margin)),
  });
  const point = clamp(
    position?.x ?? viewport.x + viewport.width,
    position?.y ?? viewport.y + viewport.height,
  );
  let geometry: CSSProperties = { left: point.x, top: point.y, width, height };
  if (sheet) {
    const base = viewport.y + (fullscreen ? 0 : viewport.height * (1 - HALF));
    const top = Math.max(viewport.y, base + (pull?.offset ?? 0));
    geometry = {
      left: viewport.x,
      top,
      width: viewport.width,
      height: viewport.y + viewport.height - top,
    };
  } else if (fullscreen)
    geometry = {
      left: viewport.x,
      top: viewport.y,
      width: viewport.width,
      height: viewport.height,
    };
  else if (mode === 'docked' && dockBounds) {
    const top = Math.max(viewport.y, dockBounds.top),
      right = Math.min(viewport.x + viewport.width, dockBounds.right);
    const dockWidth = Math.max(1, Math.min(400, right - Math.max(viewport.x, dockBounds.left)));
    geometry = {
      left: right - dockWidth,
      top,
      width: dockWidth,
      height: Math.max(1, Math.min(viewport.y + viewport.height, dockBounds.bottom) - top),
    };
  }

  useEffect(() => {
    // The visual viewport also follows the mobile keyboard and browser zoom.
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
  useLayoutEffect(() => {
    const anchor = readingRoot.current?.parentElement;
    if (!anchor || mode !== 'docked' || !visible || hidden) return;
    const measure = () => setDockBounds(anchor.getBoundingClientRect());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [readingRoot, mode, visible, hidden, viewport]);
  useEffect(() => {
    if (visible && !hidden) panel.current?.focus({ preventScroll: true });
  }, [visible, hidden]);
  const close = () => {
    onClose();
    requestAnimationFrame(() => launcher.current?.focus({ preventScroll: true }));
  };
  const toggleMaximized = () => {
    if (fullscreen) onModeChange(restoreMode.current);
    else {
      restoreMode.current = mode;
      onModeChange('maximized');
    }
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };
  // Dragging the handle: up for full screen, down for half, down again to close.
  const endPull = () => {
    if (!pull) return;
    const { offset } = pull;
    setPull(null);
    if (Math.abs(offset) < 6) setSheetSize(fullscreen ? 'half' : 'full');
    else if (offset < -60) setSheetSize('full');
    else if (offset > 60) {
      if (fullscreen && !(offset > viewport.height * (1 - HALF) + 60)) {
        (document.activeElement as HTMLElement | null)?.blur();
        setSheetSize('half');
      } else close();
    }
  };

  return createPortal(
    <>
      {sheet && visible && !hidden && !fullscreen && (
        <div className="assistant-sheet-backdrop" aria-hidden="true" onClick={close} />
      )}
      <button
        ref={launcher}
        className={`assistant-launcher${label === '全局青藜' ? ' global-assistant-launcher' : ''}${tucked ? ' is-tucked' : ''}`}
        hidden={!showLauncher || visible || hidden}
        style={{
          left: viewport.x + viewport.width - margin,
          top: Math.max(viewport.y + margin + 52, Math.min(viewport.y + viewport.height - margin, appendTop === null ? Infinity : appendTop - 12)),
        }}
        aria-label={`打开${label}`}
        title={busy ? `${title} · 正在回复` : title}
        onClick={onOpen}
      >
        <QingliIcon size={24} />
        <span className="assistant-launcher-label">青藜</span>
        {busy && <span className="assistant-busy-dot" aria-label="正在回复" />}
      </button>
      <aside
        ref={panel}
        className={`assistant-panel ${
          !compact ? `assistant-${mode}` : fullscreen ? 'assistant-maximized' : ''
        }${sheet ? ' assistant-sheet' : ''}${animating ? ' is-animating' : ''}${dragging || pull ? ' is-dragging' : ''}`}
        style={geometry}
        aria-label={label}
        hidden={!visible || hidden}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (fullscreen && !compact) toggleMaximized();
            // Android also hands Back to the page when it puts the keyboard
            // away: that Back only ends typing.
            else if (sheet && (keyboard || Date.now() - keyboardSeen.current < 800))
              (document.activeElement as HTMLElement | null)?.blur();
            else if (sheet && fullscreen) {
              (document.activeElement as HTMLElement | null)?.blur();
              setSheetSize('half');
            } else close();
          } else if (fullscreen && event.key === 'Tab') {
            const focusable = [
              ...panel.current!.querySelectorAll<HTMLElement>(
                'button, a[href], input, textarea, select, summary, [tabindex]',
              ),
            ].filter(
              (element) =>
                !element.matches(':disabled') &&
                element.tabIndex >= 0 &&
                element.getClientRects().length > 0,
            );
            const first = focusable[0],
              last = focusable.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === panel.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        {sheet && (
          <div
            className="assistant-sheet-handle"
            role="button"
            // Touch and screen readers use it; Tab stays on the panel's controls.
            tabIndex={-1}
            aria-label="调整青藜高度"
            onClick={(event) => {
              // Pointer taps are handled on release; this is assistive technology.
              if (event.detail === 0) setSheetSize(fullscreen ? 'half' : 'full');
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setPull({ id: event.pointerId, startY: event.clientY, offset: 0 });
            }}
            onPointerMove={(event) => {
              if (pull?.id === event.pointerId)
                setPull({ ...pull, offset: event.clientY - pull.startY });
            }}
            onPointerUp={endPull}
            onPointerCancel={() => setPull(null)}
          />
        )}
        <header className="assistant-heading">
          <div
            className="assistant-drag-handle"
            role="group"
            aria-label="移动青藜窗口"
            tabIndex={!compact && mode === 'floating' ? 0 : -1}
            title={!compact && mode === 'floating' ? '拖动移动，方向键微调' : undefined}
            onPointerDown={(event) => {
              if (compact || mode !== 'floating' || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                id: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                ...point,
              };
              setDragging(true);
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
                compact ||
                mode !== 'floating' ||
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
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
            <strong>
              <QingliIcon size={22} />
              青藜
            </strong>
            <span className="assistant-note-title" title={title}>
              {title}
            </span>
          </div>
          {actions}
          <button
            className="icon-button"
            hidden={compact}
            aria-label={mode === 'docked' ? '悬浮青藜' : '贴边青藜'}
            title={mode === 'docked' ? '悬浮' : '贴边'}
            onClick={() => onModeChange(mode === 'docked' ? 'floating' : 'docked')}
          >
            {mode === 'docked' ? <PanelsTopLeft size={16} /> : <PanelRight size={16} />}
          </button>
          <button
            className="icon-button"
            hidden={!sheet}
            aria-label={fullscreen ? '青藜半屏' : '青藜全屏'}
            title={fullscreen ? '半屏' : '全屏'}
            onClick={() => {
              if (fullscreen) (document.activeElement as HTMLElement | null)?.blur();
              setSheetSize(fullscreen ? 'half' : 'full');
            }}
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            className="icon-button"
            hidden={compact}
            aria-label={fullscreen ? '还原青藜' : '最大化青藜'}
            title={fullscreen ? '还原' : '最大化'}
            onClick={toggleMaximized}
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button className="icon-button" aria-label="关闭青藜" title="收起青藜" onClick={close}>
            <X size={18} />
          </button>
        </header>
        {children}
      </aside>
    </>,
    assistantHost(),
  );
}
