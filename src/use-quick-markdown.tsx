import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, fileUrl, uncertainFailure, upload } from './api';
import { variantOf, type FileInfo, type NoteDetail } from '../shared/types';
import { createSectionWriter } from './edit-section';
import { replaceSection, toggleTaskAt, type MarkdownSection } from './markdown-sections';
import { removeDraft, sectionDraftId, writeDraft } from './note-drafts';
import { pendingSave, subscribeSaves } from './save-outbox';
import type { SectionControls } from './components/MarkdownSection';
import type { TypeContext } from './note-types/view';

interface Session {
  note: NoteDetail;
  section: MarkdownSection;
  original: string;
  write: ReturnType<typeof createSectionWriter>;
  deleting: boolean;
}

export function useQuickMarkdown({ id, note, editing, disabled, appending, projectContext, confirm, onActive, onBusy, onSaved, refresh, onNotice }: {
  id: string;
  note: NoteDetail | null;
  editing: boolean;
  disabled: boolean;
  appending: boolean;
  projectContext?: TypeContext['projectContext'];
  confirm: TypeContext['confirm'];
  onActive: (active: boolean) => void;
  onBusy: (busy: boolean) => void;
  onSaved: (detail: NoteDetail) => void;
  refresh: () => void;
  onNotice?: (message: string) => void;
}) {
  const preference = `note:quick-edit:${id}`;
  const draftId = sectionDraftId(id);
  const waitingForSave = !!useSyncExternalStore(subscribeSaves, () => pendingSave(id));
  const blocked = disabled || waitingForSave;
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(preference) !== 'false'; } catch { return true; }
  });
  const [session, setSession] = useState<Session | null>(null);
  const [text, setText] = useState('');
  const [extraAssets, setExtraAssets] = useState<FileInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const uploadingNow = useRef(false);
  const draftUploads = useRef(new Set<string>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [draftError, setDraftError] = useState(false);
  const available = !!note && variantOf(note) === 'markdown' && !note.journal_entry && !note.project_category && !projectContext;
  const active = available && enabled && !editing;
  const dirty = !!session && !session.deleting && (text !== session.original || extraAssets.length > 0);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(560, Math.max(180, el.scrollHeight + 2))}px`;
  }, [text, session]);

  useEffect(() => {
    if (!session || session.deleting) return;
    if (!dirty) { removeDraft(draftId); return; }
    let live = true;
    void Promise.resolve(writeDraft(draftId, {
      content: replaceSection(session.note.content, session.section, text),
      attachments: [...session.note.attachments, ...extraAssets], revision: session.note.revision, savedAt: Date.now(),
    }, session.note.key_id)).then((stored) => { if (live) setDraftError(!stored); });
    return () => { live = false; };
  }, [draftId, session, text, extraAssets, dirty]);
  useEffect(() => {
    if (!dirty && !busy && !uploading && !uncertain) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy, uploading, uncertain]);

  const close = (saved = false) => {
    if (!saved) {
      for (const fileId of draftUploads.current) void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
    }
    draftUploads.current.clear();
    setExtraAssets([]);
    removeDraft(draftId);
    setSession(null);
    setError('');
    setUncertain(false);
    setConflict(false);
    setDraftError(false);
    onActive(false);
  };
  const leave = async () => {
    if (running.current || uploadingNow.current || uncertain) {
      onNotice?.(uncertain ? '保存结果尚未确认，请先重试本节保存。' : '正在保存，请稍候再离开。');
      return false;
    }
    if (dirty && !await confirm('还有未保存的章节修改', '离开会放弃本节修改，是否继续？', '放弃修改', true)) return false;
    if (session) {
      close(false);
      if (conflict) refresh();
    }
    return true;
  };
  const save = async (current = session, replacement = text) => {
    if (!current || running.current || uploadingNow.current || blocked || conflict) return;
    running.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const saved = extraAssets.length
        ? await current.write(replacement, extraAssets.map((file) => file.id))
        : await current.write(replacement);
      close(true);
      onSaved(saved);
      onNotice?.(current.deleting ? '已删除本节，可在版本历史中恢复。' : '已保存本节');
    } catch (reason) {
      setUncertain(uncertainFailure(reason));
      if (reason instanceof ApiError && reason.code === 'VERSION_CONFLICT') {
        setConflict(true);
        setError(current.deleting
          ? '正文已在其他页面更新，本节未删除。请取消后重新打开。'
          : '正文已在其他页面更新，修改已保留。请复制本节内容，取消后重新打开。');
      } else setError((reason as Error).message || '保存失败，请重试。');
    } finally {
      running.current = false;
      setBusy(false);
      onBusy(false);
    }
  };
  const pasteFiles = async (files: FileList) => {
    if (!files.length || uploadingNow.current || busy || uncertain) return;
    uploadingNow.current = true;
    setUploading(true);
    setError('');
    try {
      const pieces: string[] = [];
      for (const selected of Array.from(files)) {
        const uploaded = await upload(selected, id);
        draftUploads.current.add(uploaded.id);
        setExtraAssets((previous) => [...previous, uploaded]);
        const safeName = uploaded.name.replace(/[[\]\\]/g, '');
        pieces.push(
          uploaded.mime.startsWith('image/')
            ? `![${safeName}](${fileUrl(uploaded.id)})`
            : `[${safeName}](${fileUrl(uploaded.id)})`,
        );
      }
      if (pieces.length) {
        const snippet = pieces.join('\n');
        const el = textareaRef.current;
        const from = el?.selectionStart ?? text.length;
        const to = el?.selectionEnd ?? from;
        setText((prev) => {
          const start = Math.min(from, prev.length);
          const end = Math.min(to, prev.length);
          return `${prev.slice(0, start)}${snippet}${prev.slice(end)}`;
        });
      }
    } catch (reason) {
      setError((reason as Error).message || '上传失败，请重试。');
    } finally {
      uploadingNow.current = false;
      setUploading(false);
    }
  };
  const open = (section: MarkdownSection, deleting = false) => {
    if (!note || blocked || pendingSave(id) || appending || session) return null;
    const current = { note, section, original: note.content.slice(section.start, section.end), write: createSectionWriter(note, section), deleting };
    setSession(current);
    setText(current.original);
    setExtraAssets([]);
    setError('');
    onActive(true);
    return current;
  };
  const controls: SectionControls | undefined = active ? {
    disabled: blocked || appending || busy || uploading,
    activeStart: session?.section.start ?? null,
    onEdit: (section) => { open(section); },
    onDelete: (section) => {
      const current = open(section, true);
      if (!current) return;
      void (async () => {
        const ok = await confirm('删除这一节？', `将删除「${section.title}」及其正文${section.children ? `，包含 ${section.children} 个子章节` : ''}。删除后可在版本历史中恢复。`, '删除本节', true);
        if (ok) await save(current, '');
        else close(false);
      })();
    },
    onToggleTask: (offset, checked) => {
      if (!note || running.current || blocked || appending || session) return;
      const next = toggleTaskAt(note.content, offset, checked);
      if (next === null) return;
      const writeTask = createSectionWriter(note);
      running.current = true;
      setBusy(true);
      onBusy(true);
      void writeTask(next)
        .then((saved) => {
          onSaved(saved);
        })
        .catch((reason) => {
          if (reason instanceof ApiError && reason.code === 'VERSION_CONFLICT') {
            onNotice?.('正文已在其他页面更新，请刷新后再勾选。');
            refresh();
          } else {
            onNotice?.((reason as Error).message || '待办状态保存失败，请重试。');
          }
        })
        .finally(() => {
          running.current = false;
          setBusy(false);
          onBusy(false);
        });
    },
    editor: session && (
      <form className="section-editor" aria-label={`${session.deleting ? '删除' : '编辑'}章节 ${session.section.title}`}
        onSubmit={(event) => { event.preventDefault(); void save(session, session.deleting ? '' : text); }}>
        <p className="section-editor-heading">{session.deleting ? '删除' : '编辑'}本节 · {session.section.title}</p>
        {!session.deleting && <>
          <label className="section-editor-hint" htmlFor={`section-source-${id}`}>
            章节 Markdown（含标题和子章节）{uploading ? ' · 正在上传图片…' : ''}
          </label>
          <textarea ref={textareaRef} id={`section-source-${id}`} autoFocus rows={8} value={text} disabled={busy || uploading || uncertain}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const files = event.clipboardData?.files;
              if (!files?.length) return;
              event.preventDefault();
              void pasteFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault(); void save();
              } else if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); void leave();
              }
            }} />
        </>}
        {draftError && <p className="inline-error" role="alert">草稿暂时无法保存在本机，请保持页面打开。</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="section-editor-actions">
          {conflict && !session.deleting && (
            <button
              type="button"
              className="button compact"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(text)
                  .then(() => onNotice?.('已复制本节修改'))
                  .catch(() => setError('复制失败，请手动全选复制。'));
              }}
            >
              复制本节修改
            </button>
          )}
          <button type="button" className="button compact" disabled={busy || uploading || uncertain} onClick={() => void leave()}>取消</button>
          <button type="submit" className="button primary compact" disabled={blocked || busy || uploading || conflict || (!session.deleting && !dirty && !uncertain)}>
            {busy ? '正在保存…' : uploading ? '上传中…' : uncertain ? '重试保存' : session.deleting ? '重试删除' : '保存本节'}
          </button>
        </div>
      </form>
    ),
  } : undefined;
  return {
    available, active, controls, leave, waitingForSave,
    menu: available && <button disabled={blocked || appending || busy} aria-pressed={enabled}
      onClick={() => { void (async () => {
        if (!await leave()) return;
        const next = !enabled;
        setEnabled(next);
        try { localStorage.setItem(preference, String(next)); } catch { /* Optional device preference. */ }
      })(); }}>{enabled ? '关闭快捷编辑' : '开启快捷编辑'}</button>,
  };
}
