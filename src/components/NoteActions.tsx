import type { RefObject } from 'react';
import { History, Languages, List, Paperclip, Pencil, Star } from 'lucide-react';
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
  onAttachments: () => void;
  onEdit: () => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
}) {
  return (
    <div className="note-actions">
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
      {!editing && TEXT_KINDS.includes(note.kind) && note.attachments.length > 0 && (
        <button
          className="icon-button attachments-toggle toolbar-secondary"
          aria-label={`附件（${note.attachments.length}）`}
          title="附件"
          aria-haspopup="dialog"
          onClick={onAttachments}
        >
          <Paperclip size={18} />
          <span className="toolbar-badge" aria-hidden="true">
            {note.attachments.length}
          </span>
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
          {TEXT_KINDS.includes(note.kind) && note.attachments.length > 0 && (
            <button
              className="menu-compact-only"
              onClick={(event) => {
                closeMenu(event.currentTarget);
                onAttachments();
              }}
            >
              附件（{note.attachments.length}）
            </button>
          )}
          {/* Folders have none of the items above, so no divider either. */}
          {note.kind !== 'folder' && <hr className="menu-compact-only" />}
        </NodeMenu>
      )}
    </div>
  );
}
