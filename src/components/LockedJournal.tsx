import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ImagePlus, LockKeyhole, Send, X } from 'lucide-react';
import { isUnlocked, keysVersion, subscribeKeys } from '../keyring';
import { loadOutboxDraft, queueOutboxRecord, saveOutboxDraft } from '../journal-outbox';
import { writeDraft } from '../note-drafts';
import { keepPhoto } from '../pending-photos';
import type { NoteNode } from '../../shared/types';
import { UnlockForm } from './Encryption';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

interface Photo {
  file: File;
  preview: string;
}

// 今日记 for an encrypted journal not unlocked on this device: the same
// composer, but the record waits on the device (see journal-outbox.ts) until
// the journal is unlocked. Unlocking here hands the input to the usual composer.
export function LockedJournalComposer({ journal, date, onQueued, onUnlocked }: {
  journal: NoteNode & { key_id: string };
  date: string;
  onQueued: () => void;
  onUnlocked: () => void;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const operation = useRef<string>(crypto.randomUUID());
  const shown = useRef<Photo[]>([]);
  shown.current = photos;
  useSyncExternalStore(subscribeKeys, keysVersion);
  const unlocked = isUnlocked(journal.key_id);
  useEffect(() => {
    let live = true;
    void loadOutboxDraft(journal.id, date).then((draft) => {
      if (!live) return;
      if (draft) {
        setTitle(draft.title);
        setText(draft.text);
        setPhotos(draft.photos.map((file) => ({ file, preview: URL.createObjectURL(file) })));
        operation.current = draft.operationKey;
      }
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [journal.id, date]);
  useEffect(() => () => shown.current.forEach((photo) => URL.revokeObjectURL(photo.preview)), []);
  const record = () => ({
    journalId: journal.id, keyId: journal.key_id, date, title, text, operationKey: operation.current,
    photos: photos.map((photo) => photo.file),
  });
  useEffect(() => {
    if (!ready || busy || unlocked) return;
    const timer = setTimeout(() => void saveOutboxDraft(record()).catch(() => {}), 300);
    return () => clearTimeout(timer);
    // record() reads the fields listed here.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, busy, unlocked, title, text, photos]);
  // Unlocked here: the input moves to the usual composer's draft, sealed with the journal key.
  useEffect(() => {
    if (!ready || !unlocked) return;
    void (async () => {
      const draft = `append:journal:${journal.id}:${date}`;
      if (title || text || photos.length) {
        await writeDraft(draft, {
          content: JSON.stringify({ title, text, attachments: [], operationKey: crypto.randomUUID(), retrying: false }),
          attachments: [], revision: 0, savedAt: Date.now(),
        }, journal.key_id);
        for (const photo of photos) await keepPhoto(draft, crypto.randomUUID(), photo.file, journal.key_id);
      }
      await saveOutboxDraft({ ...record(), title: '', text: '', photos: [] });
      onUnlocked();
    })();
    // Runs once when the key is unlocked, with the input as it is then.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, unlocked]);
  const save = async () => {
    if (busy || !ready || (!text.trim() && !photos.length)) return;
    setBusy(true);
    setError('');
    try {
      await queueOutboxRecord(record());
      onQueued();
    } catch {
      setError('未能暂存到本设备，请重试。');
      setBusy(false);
    }
  };
  if (unlocking && !unlocked)
    return (
      <div className="share-window-status">
        <p>输入「{journal.title}」的密码后，已写的内容会继续保留。</p>
        <UnlockForm keyId={journal.key_id} owner={journal.title} />
        <button type="button" className="text-button" onClick={() => setUnlocking(false)}>继续写，稍后解锁</button>
      </div>
    );
  return (
    <div className="quick-append-footer">
      <form className="quick-append is-active" aria-label="快捷记录" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="quick-append-heading">
          <input aria-label="记录标题" placeholder="标题（可选）" value={title} disabled={busy || !ready}
            onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div className="quick-append-body">
          {photos.length > 0 && (
            <div className="quick-append-images" aria-label="待追加照片">
              {photos.map((photo) => (
                <div className="quick-append-image" key={photo.preview}>
                  <img src={photo.preview} alt={photo.file.name} draggable={false} />
                  <button className="icon-button" type="button" aria-label={`移除 ${photo.file.name}`} disabled={busy}
                    onClick={() => {
                      URL.revokeObjectURL(photo.preview);
                      setPhotos((list) => list.filter((item) => item !== photo));
                    }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="quick-append-editor">
            <textarea aria-label="记录内容" placeholder="记下此刻…" rows={4} value={text} autoFocus
              disabled={busy || !ready} onChange={(event) => setText(event.target.value)} />
            <label className="icon-button quick-append-image-button" title="添加照片">
              <ImagePlus size={16} />
              <input type="file" aria-label="添加照片" accept={[...IMAGE_MIMES].join(',')} multiple disabled={busy || !ready}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  if (files.some((file) => !IMAGE_MIMES.has(file.type))) {
                    setError('只支持 PNG、JPEG、GIF、WebP 或 AVIF 图片。');
                    return;
                  }
                  setError('');
                  setPhotos((list) => [...list, ...files.map((file) => ({ file, preview: URL.createObjectURL(file) }))]);
                }} />
            </label>
          </div>
          <div className="quick-append-actions">
            <button className="button primary compact" type="submit" disabled={busy || !ready || (!text.trim() && !photos.length)}>
              <Send size={15} />保存
            </button>
          </div>
        </div>
        <small className="locked-journal-hint">
          <LockKeyhole size={13} aria-hidden="true" />
          日记本已加密：先存在本设备，解锁后自动记入。
          <button type="button" className="text-button" onClick={() => setUnlocking(true)}>现在解锁</button>
        </small>
        {error && <p className="inline-error" role="alert">{error}</p>}
      </form>
    </div>
  );
}
