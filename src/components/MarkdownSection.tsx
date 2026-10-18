import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import type { MarkdownSection as Section } from '../markdown-sections';

export interface SectionControls {
  disabled: boolean;
  activeStart: number | null;
  editor: ReactNode;
  onEdit: (section: Section) => void;
  onDelete: (section: Section) => void;
}

// Menus live outside the reading text so opening one never changes annotation
// offsets or the text copied from a section. The in-body trigger is icon-only.
export function MarkdownSection({ section, controls, children }: {
  section: Section;
  controls: SectionControls;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    popup.current?.querySelector('button')?.focus();
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);
  const active = controls.activeStart === section.start;
  return (
    <section className={`markdown-section${active ? ' is-editing' : ''}`} data-section-start={section.start}>
      {active ? controls.editor : <>
        <button ref={trigger} className="icon-button section-trigger" aria-label={`管理章节 ${section.title}`}
          title={`管理章节 ${section.title}`} disabled={controls.disabled || controls.activeStart !== null}
          aria-expanded={!!menu} aria-haspopup="true"
          onClick={() => {
            const rect = trigger.current!.getBoundingClientRect();
            setMenu(menu ? null : {
              top: Math.min(rect.bottom + 4, window.innerHeight - 110),
              left: Math.max(8, Math.min(rect.right - 152, window.innerWidth - 160)),
            });
          }}><MoreHorizontal size={18} /></button>
        {children}
      </>}
      {menu && createPortal(
        <div ref={popup} className="menu-popup section-menu" style={menu} aria-label={`章节操作 ${section.title}`}>
          <button disabled={controls.disabled} onClick={() => { setMenu(null); controls.onEdit(section); }}>编辑本节</button>
          <button className="danger-text" disabled={controls.disabled} onClick={() => { setMenu(null); controls.onDelete(section); }}>删除本节</button>
        </div>, document.body,
      )}
    </section>
  );
}
