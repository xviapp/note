import type { RefObject } from 'react';
import { FolderTree, History, Languages, List, Pencil, Star } from 'lucide-react';
import { TEXT_KINDS, type NoteDetail, type NoteNode } from '../../shared/types';
import { ReadingSettingsButton } from './ReadingSettings';
import { NodeMenu, type NodeAction } from './Tree';

const closeMenu = (element: Element) => {
  const menu = element.closest('details');
  if (menu) menu.open = false;
};

// The note page's toolbar. On phones, secondary actions move into the ⋯ menu.
export function NoteActions({
  note,
  editing,
  offline,
  translating,
  toc,
  onReadingChange,
  onTranslate,
  onFavorite,
  onHistory,
  onChildren,
  onAttachments,
  onEdit,
  onAction,
}: {
  note: NoteDetail;
  editing: boolean;
  offline: boolean;
  translating: boolean;
  toc: {
    available: boolean;
    expanded: boolean;
    dialog: boolean;
    id: string;
    toggleRef: RefObject<HTMLButtonElement | null>;
    onToggle: () => void;
  };
  onReadingChange: () => void;
  onTranslate: () => void;
  onFavorite: () => void;
  onHistory: () => void;
  onChildren: () => void;
  onAttachments: () => void;
  onEdit: () => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
}) {
  const hasChildren = note.kind !== 'folder' && !!note.child_count;
  const attachments = TEXT_KINDS.includes(note.kind) ? note.attachments.length : 0;
  return (
    // A folder, a plain link or an open editor leaves only a couple of buttons; they
    // then share the location row instead of taking one of their own.
    <div
      className={`note-actions${editing || note.kind === 'folder' || (note.kind === 'link' && !note.arxiv_id) ? ' is-short' : ''}`}
    >
      {!editing && (TEXT_KINDS.includes(note.kind) || note.arxiv_id) && (
        <ReadingSettingsButton beforeChange={onReadingChange} />
      )}
      {note.kind !== 'folder' && !editing && (
        <button
          className="icon-button toolbar-secondary"
          aria-label="翻译记录"
          disabled={offline}
          title="翻译记录"
          aria-expanded={translating}
          onClick={onTranslate}
        >
          <Languages size={18} />
        </button>
      )}
      <button
        className={`icon-button ${note.favorite ? 'is-favorite' : ''}`}
        aria-label={note.favorite ? '取消收藏' : '收藏笔记'}
        disabled={offline}
        title={note.favorite ? '取消收藏' : '收藏'}
        onClick={onFavorite}
      >
        <Star size={18} fill={note.favorite ? 'currentColor' : 'none'} />
      </button>
      {TEXT_KINDS.includes(note.kind) && (
        <button
          className="icon-button toolbar-secondary"
          aria-label="版本历史"
          disabled={offline}
          title="版本历史"
          onClick={onHistory}
        >
          <History size={18} />
        </button>
      )}
      {/* A folder lists its children on the page; other notes open them here,
          before the outline. */}
      {!editing && hasChildren && (
        <button
          className="icon-button has-badge"
          aria-label={`下级笔记（${note.child_count}）`}
          title="下级笔记"
          aria-haspopup="dialog"
          onClick={onChildren}
        >
          <FolderTree size={18} />
          <span className="toolbar-badge" aria-hidden="true">
            {note.child_count}
          </span>
        </button>
      )}
      {!editing && (note.kind === 'markdown' || note.arxiv_id) && toc.available && (
        <button
          ref={toc.toggleRef}
          className="icon-button toc-toggle"
          aria-label="标题目录"
          title={toc.expanded ? '隐藏目录' : '显示目录'}
          aria-expanded={toc.expanded}
          aria-controls={toc.id}
          aria-haspopup={toc.dialog ? 'dialog' : undefined}
          onClick={toc.onToggle}
        >
          <List size={18} />
        </button>
      )}
      {!editing && TEXT_KINDS.includes(note.kind) && (
        <button
          className="button compact edit-note-button"
          aria-label="编辑正文"
          disabled={offline}
          title="编辑正文"
          onClick={onEdit}
        >
          <Pencil size={15} />
          <span>编辑正文</span>
        </button>
      )}
      {!editing && (
        <NodeMenu node={note} onAction={onAction}>
          {/* On phones these leave the toolbar so it stays on one row. */}
          {note.kind !== 'folder' && (
            <button
              className="menu-compact-only"
              disabled={offline}
              onClick={(event) => {
                closeMenu(event.currentTarget);
                onTranslate();
              }}
            >
              翻译记录
            </button>
          )}
          {TEXT_KINDS.includes(note.kind) && (
            <button
              className="menu-compact-only"
              disabled={offline}
              onClick={(event) => {
                closeMenu(event.currentTarget);
                onHistory();
              }}
            >
              版本历史
            </button>
          )}
          {/* Attachments also list under the body; this opens them without scrolling there. */}
          {attachments > 0 && (
            <button
              onClick={(event) => {
                closeMenu(event.currentTarget);
                onAttachments();
              }}
            >
              所有附件（{attachments}）
            </button>
          )}
          {/* Folders have none of the items above, so no divider either. */}
          {(attachments > 0 || note.kind !== 'folder') && (
            <hr className={attachments > 0 ? undefined : 'menu-compact-only'} />
          )}
        </NodeMenu>
      )}
    </div>
  );
}
