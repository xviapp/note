import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, fileUrl, lockNote, unlockNote, upload } from './api';
import type { FileInfo, NoteDetail, NoteNode } from '../shared/types';
import type { useQuestion } from './components/Primitives';

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
  const save = async (): Promise<boolean> => {
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
      reset(detail);
      for (const fileId of draftUploads.current)
        if (!detail.attachments.some((file) => file.id === fileId))
          void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
      draftUploads.current.clear();
      exitEdit();
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
    reset(noteRef.current);
    exitEdit();
    return true;
  };
  useEffect(() => {
    setLeaveGuard(leave);
    return () => setLeaveGuard(async () => true);
  });
  const start = async () => {
    if (
      !(await question.confirm(
        '编辑这篇笔记？',
        '确认后可以修改正文和附件。手动保存后回到只读预览。',
        '开始编辑',
      ))
    )
      return;
    try {
      await unlockNote(id);
      onStart();
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
  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setSaveError('');
    try {
      for (const selected of Array.from(files)) {
        const file = await upload(selected);
        draftUploads.current.add(file.id);
        setAssets((previous) => [...previous, file]);
        if (note?.kind === 'markdown' && file.mime.startsWith('image/'))
          setContent(
            (previous) =>
              `${previous}\n\n![${file.name.replace(/[[\]\\]/g, '')}](${fileUrl(file.id)})\n`,
          );
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
    if (note?.kind === 'markdown')
      setContent((previous) =>
        previous.replace(new RegExp(`!\\[[^\\]]*\\]\\(/api/files/${fileId}\\)`, 'g'), ''),
      );
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
    reconfirm,
    addFiles,
    removeAsset,
  };
}
