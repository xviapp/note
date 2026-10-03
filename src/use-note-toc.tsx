import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { Heading } from './components/MarkdownView';

// A note's heading outline: a side panel on wide screens, a dialog on narrow ones.
export function useNoteToc({
  scroll,
  beforeSideToggle,
  onJump,
}: {
  scroll: RefObject<HTMLElement | null>;
  // Records the reading position, since the side panel reflows the article.
  beforeSideToggle: () => void;
  onJump: () => void;
}) {
  const [headings, setHeadings] = useState<Heading[]>([]),
    [active, setActive] = useState(''),
    [dialogOpen, setDialogOpen] = useState(false),
    [sideOpen, setSideOpen] = useState(true);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1150px)').matches);
  const id = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1150px)');
    const update = () => {
      setCompact(query.matches);
      setDialogOpen(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const onHeadings = useCallback((value: Heading[]) => setHeadings(value), []);
  const toggle = () => {
    if (compact) setDialogOpen((open) => !open);
    else {
      beforeSideToggle();
      setSideOpen((open) => !open);
      toggleRef.current?.focus({ preventScroll: true });
    }
  };
  const closeDialog = () => {
    setDialogOpen(false);
    requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
  };
  const jump = (heading: Heading) => {
    onJump();
    setActive(heading.id);
    setDialogOpen(false);
    // Close the modal before scrolling: native dialog focus restoration otherwise
    // competes with the requested reading position on mobile browsers.
    requestAnimationFrame(() =>
      scroll.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };
  const nav = (
    <nav id={id} className="toc" aria-label="标题目录">
      {headings.map((heading) => (
        <button
          key={heading.id}
          className={active === heading.id ? 'active' : ''}
          aria-current={active === heading.id ? 'location' : undefined}
          style={{ paddingLeft: 12 + (heading.level - 1) * 10 }}
          onClick={() => jump(heading)}
        >
          {heading.title || '无标题'}
        </button>
      ))}
    </nav>
  );
  return {
    headings,
    onHeadings,
    setActive,
    compact,
    dialogOpen,
    sideOpen,
    expanded: compact ? dialogOpen : sideOpen,
    id,
    toggleRef,
    toggle,
    closeDialog,
    nav,
  };
}
