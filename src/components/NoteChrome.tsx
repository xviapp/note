import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Link2,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  StickyNote,
} from 'lucide-react';
import { openClips } from '../clips';
import { formatDate } from '../api';
import { variantOf, type NoteDetail } from '../../shared/types';
import { NodeIcon } from './Primitives';
import { noteType, typeLabel } from '../note-types/registry';
import { LockBadge } from './LockBadge';
import { useEffect, useRef, useState, type ReactNode } from 'react';

// The parts of a note page around its body: location, heading, edit bar.

export function NoteLocation({
  note,
  showSidebar,
  sidebarOpen,
  onBack,
  onOpenSidebar,
  onNavigate,
}: {
  note: NoteDetail | null;
  showSidebar: boolean;
  sidebarOpen: boolean;
  onBack: () => void;
  onOpenSidebar: () => void;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="note-location">
      <button className="icon-button page-back" aria-label="返回" onClick={onBack}>
        <ChevronLeft size={22} />
      </button>
      {showSidebar && (
        <button
          className="icon-button mobile-menu"
          aria-label="打开笔记目录"
          aria-controls="notebook-sidebar"
          aria-expanded={sidebarOpen}
          onClick={onOpenSidebar}
        >
          <Menu size={21} />
        </button>
      )}
      <div className="breadcrumbs">
        <button onClick={() => onNavigate('')}>全部笔记</button>
        {note?.breadcrumbs.map((part, index) => filed(note, index) ? null : (
          <span key={part.id}>
            <ChevronRight size={13} />
            <button
              title={part.title}
              disabled={index === note.breadcrumbs.length - 1}
              onClick={() => onNavigate(part.id)}
            >
              {part.title}
            </button>
          </span>
        ))}
      </div>
      {note?.kind !== 'folder' && (
        <button
          className="icon-button location-clips"
          aria-label="随手记"
          title="随手记（Q）"
          onClick={openClips}
        >
          <StickyNote size={18} />
        </button>
      )}
    </div>
  );
}

// A journal entry's year and month folders say nothing its own title does not.
function filed(note: NoteDetail, index: number) {
  if (!note.journal_entry || index === note.breadcrumbs.length - 1) return false;
  const journal = note.breadcrumbs.findIndex((part) => part.id === note.journal_entry!.journal_id);
  return journal >= 0 && index > journal;
}

export function NoteHeading({
  note,
  editing,
  onNew,
  title,
  kind,
  actions,
}: {
  note: NoteDetail;
  editing: boolean;
  onNew: () => void;
  // Shown instead of the note's own title and kind (e.g. a journal day).
  title?: string;
  kind?: { icon: ReactNode; label: string };
  actions?: ReactNode;
}) {
  return (
    <header className="document-heading">
      <div className="document-title-row">
      <h1>
        {title ?? (note.project_category && note.metadata_title ? note.metadata_title : note.title)}
        <LockBadge keyId={note.key_id} size={18} />
      </h1>
      {actions}
      </div>
      {/* Kind, date and New share one ruled row to keep the page top short. */}
      <div className="document-meta">
        <span className="document-kind">
          {kind ? kind.icon : <NodeIcon node={note} size={14} />}
          {kind ? kind.label : typeLabel(note)}
        </span>
        {note.arxiv_id ? (
          <a className="paper-source" href={note.url!} target="_blank" rel="noopener noreferrer">
            arXiv:{note.arxiv_id}
            <ArrowUpRight size={13} />
          </a>
        ) : (
          <span>更新于 {formatDate(note.updated_at)}</span>
        )}
        {/* A project creates its items from its own panel. */}
        {noteType(note).newChild && variantOf(note) !== 'project' && !note.journal_entry && !editing && (
          <button className="text-button" onClick={onNew}>
            <Plus size={14} />
            新建
          </button>
        )}
      </div>
    </header>
  );
}

export function EditToolbar({
  kind,
  dirty,
  tab,
  busy,
  uploading,
  onTab,
  onFiles,
  onInsertLink,
  onCancel,
  onSave,
}: {
  kind: NoteDetail['kind'];
  dirty: boolean;
  tab: 'source' | 'preview';
  busy: boolean;
  uploading: boolean;
  onTab: (tab: 'source' | 'preview') => void;
  onFiles: (files: FileList | null) => void;
  onInsertLink: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const insertMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const change = () => setCompact(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const closeInsertMenu = () => {
    if (compact && insertMenu.current) insertMenu.current.open = false;
  };
  return (
    <div className="edit-toolbar">
      <span className="editing-label" role="status">
        {busy || uploading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Pencil size={14} />}
        {busy ? '正在保存…' : uploading ? '正在上传…' : dirty ? '未保存' : '已保存'}
      </span>
      <div className="edit-tabs">
        <button aria-pressed={tab === 'source'} className={tab === 'source' ? 'active' : ''} onClick={() => onTab('source')}>
          源码
        </button>
        <button aria-pressed={tab === 'preview'} className={tab === 'preview' ? 'active' : ''} onClick={() => onTab('preview')}>
          预览
        </button>
      </div>
      <details ref={insertMenu} className={`edit-insert-menu${compact ? ' node-menu' : ''}`} open={compact ? undefined : true}>
        <summary className="icon-button" role="button" aria-label="更多编辑操作" hidden={!compact}>
          <MoreHorizontal size={19} />
        </summary>
        <div className={compact ? 'menu-popup' : 'edit-insert-actions'}>
          <label className="button compact file-input-button">
            <Paperclip size={15} />
            <span>{uploading ? '上传中…' : '附件 / 图片'}</span>
            <input
              aria-label="上传附件"
              type="file"
              multiple
              disabled={busy || uploading}
              onChange={(e) => {
                closeInsertMenu();
                onFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          {kind === 'markdown' && (
            <button
              className={compact ? '' : 'icon-button'}
              aria-label="插入笔记链接"
              disabled={busy || uploading}
              onClick={() => { closeInsertMenu(); onInsertLink(); }}
            >
              <Link2 size={17} />
              {compact && '插入笔记链接'}
            </button>
          )}
          <button
            className={compact ? '' : 'icon-button'}
            aria-label="插入随手记"
            title="插入随手记"
            disabled={busy || uploading}
            onClick={() => { closeInsertMenu(); openClips(); }}
          >
            <StickyNote size={17} />
            {compact && '插入随手记'}
          </button>
        </div>
      </details>
      <span className="toolbar-spacer" />
      <button className="button compact" disabled={busy || uploading} onClick={onCancel}>
        取消
      </button>
      <button className="button primary compact" disabled={busy || uploading} onClick={onSave}>
        <Check size={15} />
        {busy ? '保存中…' : '保存'}
      </button>
    </div>
  );
}

// A failed save keeps the draft; it can be downloaded or the edit re-confirmed.
export function SaveErrorBar({
  message,
  note,
  content,
  onReconfirm,
}: {
  message: string;
  note: NoteDetail;
  content: string;
  onReconfirm: () => void;
}) {
  const download = () => {
    const markdown = note.kind === 'markdown';
    const href = URL.createObjectURL(
      new Blob([content], {
        type: `${markdown ? 'text/markdown' : 'text/plain'};charset=utf-8`,
      }),
    );
    const a = document.createElement('a');
    a.href = href;
    a.download = `${note.title}.${markdown ? 'md' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  return (
    <div className="save-error" role="alert">
      <span>{message}</span>
      <button className="text-button" onClick={download}>
        下载当前草稿
      </button>
      <button className="text-button" onClick={onReconfirm}>
        重新确认编辑
      </button>
    </div>
  );
}
