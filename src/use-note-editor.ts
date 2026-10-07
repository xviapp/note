import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, fileUrl, lockNote, unlockNote, upload } from './api';
import type { FileInfo, NoteDetail, NoteNode } from '../shared/types';
import type { useQuestion } from './components/Primitives';
import { readDraft, removeDraft, writeDraft } from './note-drafts';
import type { EditorHandle } from './components/Editor';

// Editing a note's body and attachments: a draft, a confirmed start, a save that
// is safe to retry, and a guard that asks before unsaved changes are left.
export function useNoteEditor({
  id,
  note,
  noteRef,
  setNote,
  question,
  setLeaveGuard,
  onStart,
  onChanged,
  onError,
  editorRef,
}: {
  id: string;
  note: NoteDetail | null;
  noteRef: RefObject<NoteDetail | null>;
  setNote: (note: NoteDetail) => void;
  question: ReturnType<typeof useQuestion>;
  setLeaveGuard: (guard: () => Promise<boolean>) => void;
  onStart: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
  // The open editor, which owns the text while editing (see Editor).
  editorRef: RefObject<EditorHandle | null>;
}) {
  const [editing, setEditing] = useState(false),
    [content, setContent] = useState(''),
    [assets, setAssets] = useState<FileInfo[]>([]);
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [saveError, setSaveError] = useState('');
  const [tab, setTab] = useState<'source' | 'preview'>('source');
  const draftUploads = useRef(new Set<string>());
  const saveRequest = useRef<{ payload: string; key: string } | null>(null);
  const sortedIds = (files: FileInfo[]) =>
    files
      .map((f) => f.id)
      .sort()
      .join();
  const dirty =
    !!note && (content !== note.content || sortedIds(assets) !== sortedIds(note.attachments));

  // The saved note becomes the draft's baseline.
  const reset = (detail: Pick<NoteDetail, 'content' | 'attachments'> | null) => {
    setContent(detail?.content ?? '');
    setAssets(detail?.attachments ?? []);
  };
  useEffect(() => {
    if (!editing || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing, dirty]);
  // Keep unsaved edits on this device shortly after each change.
  const baseRevision = useRef(0);
  // An encrypted note's draft is sealed with its key.
  const keyId = note?.key_id ?? null;
  useEffect(() => {
    if (!editing) return;
    if (!dirty) {
      removeDraft(id);
      return;
    }
    const timer = setTimeout(
      () =>
        writeDraft(
          id,
          {
            content,
            attachments: assets,
            revision: baseRevision.current,
            savedAt: Date.now(),
          },
          keyId,
        ),
      600,
    );
    return () => clearTimeout(timer);
  }, [id, editing, dirty, content, assets, keyId]);

  const abandonUploads = () => {
    for (const fileId of draftUploads.current)
      void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
    draftUploads.current.clear();
  };
  const exitEdit = () => {
    setEditing(false);
    lockNote(id);
    setSaveError('');
  };
  const insert = (text: string) => {
    if (editorRef.current) editorRef.current.insert(text);
    else setContent((previous) => `${previous}\n\n${text}\n`);
  };
  // The shortcut saves and keeps editing; the toolbar's 保存 also finishes.
  const save = async (finish = true): Promise<boolean> => {
    if (!noteRef.current || busy || uploading) return false;
    setBusy(true);
    setSaveError('');
    const payload = {
      content,
      attachments: assets.map((file) => file.id),
      revision: noteRef.current.revision,
    };
    // A retried save of the same draft reuses its key, so it cannot apply twice.
    const fingerprint = JSON.stringify(payload);
    if (saveRequest.current?.payload !== fingerprint)
      saveRequest.current = { payload: fingerprint, key: crypto.randomUUID() };
    try {
      await api<NoteNode>(`/api/nodes/${id}/content`, 'PUT', payload, saveRequest.current.key);
      // Commit the local baseline before any navigation guard can run again.
      const detail = await api<NoteDetail>(`/api/nodes/${id}`);
      noteRef.current = detail;
      setNote(detail);
      // When editing continues, the saved note is only the new baseline: the
      // reader may have typed more while the save was in flight.
      if (finish) reset(detail);
      for (const fileId of draftUploads.current)
        if (!detail.attachments.some((file) => file.id === fileId))
          void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
      draftUploads.current.clear();
      removeDraft(id);
      baseRevision.current = detail.revision;
      if (finish) exitEdit();
      onChanged();
      return true;
    } catch (error) {
      setSaveError((error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const leave = async (): Promise<boolean> => {
    if (busy || uploading) return false;
    if (!editing) return true;
    if (dirty) {
      const answer = await question.ask('还有未保存的修改', '离开之前，如何处理这篇笔记的修改？', [
        { value: 'cancel', label: '继续编辑' },
        { value: 'discard', label: '放弃修改', danger: true },
        { value: 'save', label: '保存并离开' },
      ]);
      if (answer === 'save') return save();
      if (answer !== 'discard') return false;
    }
    abandonUploads();
    removeDraft(id);
    reset(noteRef.current);
    exitEdit();
    return true;
  };
  useEffect(() => {
    setLeaveGuard(leave);
    return () => setLeaveGuard(async () => true);
  });
  // A new, empty note opens for writing without asking.
  const start = async (confirm = true) => {
    if (
      confirm &&
      !(await question.confirm(
        '编辑这篇笔记？',
        '确认后可以修改正文和附件。按 Ctrl+S 保存后继续编辑，点「保存」后回到只读预览。',
        '开始编辑',
      ))
    )
      return;
    try {
      await unlockNote(id);
      onStart();
      baseRevision.current = noteRef.current?.revision ?? 0;
      setEditing(true);
      setTab('source');
      setSaveError('');
    } catch (e) {
      onError(e);
    }
  };
  // Offers a draft left by a closed tab or a reclaimed app when the note opens.
  const offerDraft = async () => {
    const draft = await readDraft(id),
      current = noteRef.current;
    if (!draft || !current || editing) return;
    if (
      draft.content === current.content &&
      sortedIds(draft.attachments) === sortedIds(current.attachments)
    ) {
      removeDraft(id);
      return;
    }
    const changed = draft.revision !== current.revision;
    const answer = await question.ask(
      '恢复未保存的草稿？',
      `${new Date(draft.savedAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })} 编辑这篇笔记时有内容没有保存。${changed ? '这篇笔记之后又被修改过，恢复并保存会替换之后的修改；之前的内容仍可在版本历史中找回。' : ''}`,
      [
        { value: 'discard', label: '丢弃草稿', danger: true },
        { value: 'later', label: '暂不处理' },
        { value: 'restore', label: '恢复草稿' },
      ],
    );
    if (answer === 'discard') removeDraft(id);
    if (answer !== 'restore') return;
    try {
      await unlockNote(id);
      onStart();
      baseRevision.current = current.revision;
      setContent(draft.content);
      setAssets(draft.attachments);
      setEditing(true);
      setTab('source');
      setSaveError('');
    } catch (e) {
      onError(e);
    }
  };
  const reconfirm = async () => {
    try {
      await unlockNote(id);
      setSaveError('编辑确认已更新，请再次保存。');
    } catch (e) {
      onError(e);
    }
  };
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setUploading(true);
    setSaveError('');
    try {
      for (const selected of Array.from(files)) {
        const file = await upload(selected, id);
        draftUploads.current.add(file.id);
        setAssets((previous) => [...previous, file]);
        if (note?.kind === 'markdown' && file.mime.startsWith('image/'))
          insert(`![${file.name.replace(/[[\]\\]/g, '')}](${fileUrl(file.id)})`);
      }
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  // Removing an attachment also removes its inline images from Markdown.
  const removeAsset = (fileId: string) => {
    setAssets((previous) => previous.filter((file) => file.id !== fileId));
    if (note?.kind !== 'markdown') return;
    const drop = (text: string) =>
      text.replace(new RegExp(`!\\[[^\\]]*\\]\\(/api/files/${fileId}\\)`, 'g'), '');
    if (editorRef.current) editorRef.current.transform(drop);
    else setContent(drop);
  };
  return {
    editing,
    content,
    setContent,
    assets,
    busy,
    uploading,
    saveError,
    tab,
    setTab,
    dirty,
    reset,
    save,
    leave,
    start,
    offerDraft,
    reconfirm,
    addFiles,
    insert,
    removeAsset,
  };
}
