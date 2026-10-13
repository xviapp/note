import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiError, fileUrl, lockNote, unlockNote, upload } from './api';
import type { FileInfo, NoteDetail, NoteNode } from '../shared/types';
import type { useQuestion } from './components/Primitives';
import { readDraft, removeDraft, writeDraft } from './note-drafts';
import { cachedNote } from './offline-cache';
import { reveal } from './encryption';
import type { EditorHandle } from './components/Editor';
import { pendingSave, queueSave, waitForSave, type SaveFailure } from './save-outbox';

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
  const currentDraft = useRef({ content, assets });
  currentDraft.current = { content, assets };
  const savingNow = useRef(false), uploadingNow = useRef(false);
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
  }, [id, editing, dirty, content, assets, keyId, note?.revision]);

  // A background save of this note: its result replaces the shown copy, and a
  // refused one comes back into the editor with the draft and the reason.
  const editingNow = useRef(editing);
  editingNow.current = editing;
  useEffect(() => {
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<NoteDetail>).detail;
      if (detail.id !== id || editingNow.current) return;
      noteRef.current = detail;
      setNote(detail);
      reset(detail);
    };
    const failed = (event: Event) => {
      const failure = (event as CustomEvent<SaveFailure>).detail;
      if (failure.id !== id || editingNow.current) return;
      failure.handled = true;
      void (async () => {
        const draft = await readDraft(id);
        if (!draft) return;
        // The page showed the refused text as saved. Go back to what the
        // server has, so the editor's text counts as a change: it is kept as a
        // draft and leaving asks first.
        const server =
          (await api<NoteDetail>(`/api/nodes/${id}`).catch(() => null)) ??
          (await cachedNote(id).then((cached) => cached && reveal(cached)).catch(() => null));
        if (server) {
          noteRef.current = server;
          setNote(server);
        }
        try {
          await unlockNote(id);
          baseRevision.current = server?.revision ?? draft.revision;
          setContent(draft.content);
          setAssets(draft.attachments);
          setEditing(true);
          setTab('source');
          setSaveError(
            failure.code === 'VERSION_CONFLICT'
              ? '这篇笔记已在其他页面更新。你的内容还在，再次保存会以你的为准，之前的修改可在历史版本中找回。'
              : failure.message,
          );
        } catch (e) {
          onError(e);
        }
      })();
    };
    window.addEventListener('note:saved', saved);
    window.addEventListener('note:save-failed', failed);
    return () => {
      window.removeEventListener('note:saved', saved);
      window.removeEventListener('note:save-failed', failed);
    };
    // Handlers read the latest state through refs and stable setters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
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
  // The shortcut keeps editing; 保存 finishes only if no newer edits arrived.
  const save = async (finish = true): Promise<boolean> => {
    if (!noteRef.current || savingNow.current || uploadingNow.current) return false;
    // 保存 returns to the note at once and the body is sent in the background
    // (src/save-outbox.ts); Ctrl+S keeps editing, so it waits for the new revision.
    if (finish) {
      const current = noteRef.current;
      const shown = { ...current, content, attachments: assets };
      try {
        await queueSave(current, content, assets);
      } catch (error) {
        setSaveError((error as Error).message);
        return false;
      }
      for (const fileId of draftUploads.current)
        if (!assets.some((file) => file.id === fileId)) void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
      draftUploads.current.clear();
      noteRef.current = shown;
      setNote(shown);
      reset(shown);
      exitEdit();
      onChanged();
      return true;
    }
    savingNow.current = true;
    setBusy(true);
    setSaveError('');
    const payload = {
      content,
      attachments: assets.map((file) => file.id),
      revision: noteRef.current.revision,
    };
    const submittedUploads = new Set(draftUploads.current);
    // A retried save of the same draft reuses its key, so it cannot apply twice.
    const fingerprint = JSON.stringify(payload);
    if (saveRequest.current?.payload !== fingerprint)
      saveRequest.current = { payload: fingerprint, key: crypto.randomUUID() };
    try {
      const saved = await api<NoteNode>(`/api/nodes/${id}/content`, 'PUT', payload, saveRequest.current.key);
      // Commit the local baseline before any navigation guard can run again.
      const detail = await api<NoteDetail>(`/api/nodes/${id}`);
      if (detail.revision < saved.revision)
        throw new ApiError('正文已提交，但暂时无法确认最新版本。草稿已保留，请联网后再次保存。', 0);
      noteRef.current = detail;
      setNote(detail);
      // When editing continues, the saved note is only the new baseline: the
      // reader may have typed more while the save was in flight.
      const latest = currentDraft.current;
      const changed = latest.content !== payload.content || sortedIds(latest.assets) !== [...payload.attachments].sort().join();
      const finished = finish && !changed && !uploadingNow.current;
      if (finished) reset(detail);
      for (const fileId of submittedUploads) {
        if (detail.attachments.some((file) => file.id === fileId)) {
          draftUploads.current.delete(fileId);
        } else if (!latest.assets.some((file) => file.id === fileId)) {
          void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
          draftUploads.current.delete(fileId);
        }
      }
      baseRevision.current = detail.revision;
      if (changed) {
        void writeDraft(id, {
          content: latest.content, attachments: latest.assets,
          revision: detail.revision, savedAt: Date.now(),
        }, keyId);
      } else removeDraft(id);
      if (finished) exitEdit();
      onChanged();
      // A navigation guard must not leave behind edits made during this save.
      return !changed && !uploadingNow.current;
    } catch (error) {
      setSaveError((error as Error).message);
      return false;
    } finally {
      savingNow.current = false;
      setBusy(false);
    }
  };
  const leave = async (): Promise<boolean> => {
    if (savingNow.current || uploadingNow.current) return false;
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
  // Clicking 编辑正文 (or pressing E) is the confirmation; the server still
  // requires the edit token. Not requested while a save is on its way: that
  // save holds the note's token.
  const start = async () => {
    const unlocking = pendingSave(id) && !pendingSave(id)!.error ? null : unlockNote(id);
    unlocking?.catch(() => {});
    try {
      // A save still on its way sets the revision this edit starts from.
      await waitForSave(id);
      await (unlocking ?? unlockNote(id));
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
    // The draft is being saved in the background, not left behind.
    if (pendingSave(id) && !pendingSave(id)!.error) return;
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
    if (!files?.length || uploadingNow.current) return;
    uploadingNow.current = true;
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
      uploadingNow.current = false;
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
