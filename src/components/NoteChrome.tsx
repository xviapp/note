import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Link2,
  Menu,
  Paperclip,
  Pencil,
  Plus,
} from 'lucide-react';
import { formatDate } from '../api';
import type { NoteDetail } from '../../shared/types';
import { NodeIcon } from './Primitives';
import { noteType, typeLabel } from '../note-types/registry';
import { LockBadge } from './LockBadge';
import type { ReactNode } from 'react';

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
        {noteType(note).newChild && !note.journal_entry && !editing && (
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
  return (
    <div className="edit-toolbar">
      <span className="editing-label">
        <Pencil size={14} />
        正在编辑{dirty ? ' · 未保存' : ''}
      </span>
      <div className="edit-tabs">
        <button className={tab === 'source' ? 'active' : ''} onClick={() => onTab('source')}>
          源码
        </button>
        <button className={tab === 'preview' ? 'active' : ''} onClick={() => onTab('preview')}>
          预览
        </button>
      </div>
      <label className="button compact file-input-button">
        <Paperclip size={15} />
        <span>{uploading ? '上传中…' : '附件 / 图片'}</span>
        <input
          aria-label="上传附件"
          type="file"
          multiple
          disabled={busy || uploading}
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {kind === 'markdown' && (
        <button
          className="icon-button"
          aria-label="插入笔记链接"
          disabled={busy || uploading}
          onClick={onInsertLink}
        >
          <Link2 size={17} />
        </button>
      )}
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
