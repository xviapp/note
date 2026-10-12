import { useEffect, useState, type RefObject, type Dispatch, type SetStateAction } from 'react';
import { api, type ApiError } from './api';
import type { NoteDetail } from '../shared/types';
import { cachedNote } from './offline-cache';
import { reveal } from './encryption';
import { useKeys } from './components/Encryption';
import { isUnlocked } from './keyring';
import { readDraft } from './note-drafts';
import { pendingSave } from './save-outbox';

// While a save of this note is on its way, its draft is what the note now says.
async function withPendingSave(detail: NoteDetail): Promise<NoteDetail> {
  const save = pendingSave(detail.id);
  if (!save || save.error) return detail;
  const draft = await readDraft(detail.id);
  return draft ? { ...detail, content: draft.content, attachments: draft.attachments } : detail;
}

// Cached content may be read immediately; mutations wait for the fresh response.
export function useNoteLoading({
  id, refresh, editing, note, noteRef, setNote, reset, onLoaded,
}: {
  id: string;
  refresh: number;
  editing: boolean;
  note: NoteDetail | null;
  noteRef: RefObject<NoteDetail | null>;
  setNote: Dispatch<SetStateAction<NoteDetail | null>>;
  reset: (detail: NoteDetail) => void;
  onLoaded: (detail: NoteDetail) => void;
}) {
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null),
    [retry, setRetry] = useState(0);
  // Showing this device's copy while the server's answer is on its way. Editing
  // and other changes wait for the fresh copy, so they never start from old text.
  const [stale, setStale] = useState(false);
  const applyDetail = (detail: NoteDetail) => {
    noteRef.current = detail;
    setNote(detail);
    reset(detail);
    onLoaded(detail);
  };
  useEffect(() => {
    if (editing) return;
    let live = true,
      answered = false;
    setLoadError(null);
    // A note opened before shows at once from this device (a long paper takes
    // seconds to download); the server's copy then replaces it.
    if (noteRef.current?.id !== id)
      void cachedNote(id)
        .then((cached) => cached && reveal(cached))
        .then((cached) => cached && withPendingSave(cached))
        .then((cached) => {
          if (!live || answered || !cached) return;
          setStale(true);
          applyDetail(cached);
        });
    api<NoteDetail>(`/api/nodes/${id}`)
      .then(withPendingSave)
      .then((detail) => {
        answered = true;
        if (!live) return;
        setStale(false);
        applyDetail(detail);
      })
      .catch((e) => {
        answered = true;
        if (!live) return;
        // Deleted, trashed or signed out: never keep showing the old private copy.
        setStale(false);
        setLoadError(e);
      });
    return () => {
      live = false;
    };
    // Reload only for a new note or refresh; applyDetail is recreated each render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [id, refresh, editing, retry]);
  // A note opened while its key was locked loads again once it is unlocked.
  const keys = useKeys();
  useEffect(() => {
    if (note?.locked && isUnlocked(note.locked)) setRetry((count) => count + 1);
  }, [keys, note?.locked]);
  return { loadError, retry, setRetry, stale, applyDetail };
}
