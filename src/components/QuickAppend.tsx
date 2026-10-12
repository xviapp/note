import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, LoaderCircle, RotateCcw, Send, X } from 'lucide-react';
import { fileUrl, uncertainFailure, upload } from '../api';
import { createNoteAppender } from '../append-note';
import type { RecordKind } from '../../shared/records';
import type { FileInfo } from '../../shared/types';
import { readDraft, removeDraft, writeDraft } from '../note-drafts';
import { dropPhoto, dropPhotos, keepPhoto, pendingPhotos } from '../pending-photos';
import { markQuickRecord, quickRecordBody } from '../quick-journal';
import { CachedImage } from './CachedImage';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const IMAGE_ACCEPT = [...IMAGE_MIMES].join(',');

function isImageFile(value: unknown): value is FileInfo {
  return !!value && typeof value === 'object'
    && typeof (value as FileInfo).id === 'string'
    && typeof (value as FileInfo).name === 'string'
    && IMAGE_MIMES.has((value as FileInfo).mime)
    && typeof (value as FileInfo).size === 'number';
}

// A photo chosen but not uploaded yet: shown from the device, uploaded in turn.
interface Pending {
  id: string;
  file: File;
  preview: string;
  failed?: string;
}
const pendingOf = (id: string, file: File): Pending => ({ id, file, preview: URL.createObjectURL(file) });

// A reusable composer for adding a block to a text note without opening its editor.
// Photos upload in the background while typing continues; saving before they
// finish waits for them, and a save interrupted by closing resumes on reopening.
export function QuickAppend({ id, keyId, uploadScope, disabled, blocked = false, onSaved, onAppend, onSubmit, onSaveFailed, actions, onBusy, kind, label = '追加', placeholder = '记下此刻，追加到正文…', autoFocus = false, expanded = false }: {
  id: string;
  keyId?: string | null;
  // The note that owns an upload. A new journal entry uses its journal folder
  // as the scope until the entry itself exists.
  uploadScope?: string | null;
  disabled: boolean;
  blocked?: boolean;
  // `resumed`: a save requested before the composer was last closed.
  onSaved: (saved: { resumed: boolean }) => void;
  onAppend?: (title: string, text: string, operationKey: string, attachmentIds?: string[]) => Promise<void>;
  // Save was pressed; the record goes out once its photos are uploaded.
  onSubmit?: () => void;
  // A requested save did not go through (a photo or the append failed); the input is kept.
  onSaveFailed?: (message: string) => void;
  actions?: ReactNode;
  onBusy?: (busy: boolean) => void;
  kind?: RecordKind;
  label?: string;
  placeholder?: string;
  // Focus the body once a saved draft is restored.
  autoFocus?: boolean;
  // Always show the title and submit button (a window of its own, not a page footer).
  expanded?: boolean;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [focused, setFocused] = useState(false);
  const [images, setImages] = useState<FileInfo[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  // Save was requested and waits for the photos still uploading.
  const [queued, setQueued] = useState(false);
  const resumed = useRef(false);
  const current = useRef<Pending[]>([]);
  current.current = pending;
  const active = useRef<string | null>(null);
  const [uploadTurn, setUploadTurn] = useState(0);
  const running = useRef(false);
  const operation = useRef(crypto.randomUUID());
  const field = useRef<HTMLTextAreaElement>(null);
  const append = useMemo(() => createNoteAppender(id, kind), [id, kind]);
  const draftId = `append:${id}`;
  const scope = uploadScope ?? id;
  const uploading = pending.some((item) => !item.failed);
  useEffect(() => {
    let live = true;
    void Promise.all([readDraft(draftId), pendingPhotos(draftId)]).then(([draft, photos]) => {
      if (!live) return;
      if (draft) {
        try {
          const saved = JSON.parse(draft.content);
          if (typeof saved.title === 'string' && typeof saved.text === 'string') {
            setTitle(saved.title);
            setText(saved.text);
            const savedImages = Array.isArray(saved.attachments)
              ? saved.attachments.filter(isImageFile)
              : draft.attachments.filter(isImageFile);
            setImages(savedImages);
            if (typeof saved.operationKey === 'string') {
              operation.current = saved.operationKey;
              setRetrying(saved.retrying === true);
            }
            if (saved.queued === true) {
              resumed.current = true;
              setQueued(true);
            }
          }
        } catch { /* Ignore an invalid draft. */ }
      }
      setPending(photos.map((photo) => pendingOf(photo.id, photo.file)));
      setReady(true);
    });
    return () => { live = false; };
  }, [draftId]);
  useEffect(() => () => current.current.forEach((item) => URL.revokeObjectURL(item.preview)), []);
  useEffect(() => {
    if (ready && autoFocus) field.current?.focus();
  }, [ready, autoFocus]);
  useEffect(() => {
    if (!ready || busy) return;
    if (!title && !text && images.length === 0 && pending.length === 0) removeDraft(draftId);
    else {
      if (queued || retrying) markQuickRecord(draftId, keyId);
      writeDraft(draftId, {
        content: JSON.stringify({ title, text, attachments: images, operationKey: operation.current, retrying, queued }),
        attachments: images, revision: 0, savedAt: Date.now(),
      }, keyId);
    }
  }, [draftId, keyId, ready, busy, title, text, images, pending.length, retrying, queued]);
  const working = busy || uploading || queued;
  useEffect(() => { onBusy?.(working); }, [working, onBusy]);
  // `blocked` is another composer on the page at work; pages that pass this
  // composer's own onBusy back as `blocked` must not stop its uploads or save.
  const othersBusy = blocked && !working;
  // One photo at a time, while online; a failed one waits for 重试 or removal.
  useEffect(() => {
    if (!ready || disabled || othersBusy || active.current) return;
    const next = pending.find((item) => !item.failed);
    if (!next) return;
    active.current = next.id;
    void (async () => {
      try {
        const uploaded = await upload(next.file, scope);
        // Removed while uploading: the unused file is cleaned up on the server.
        if (current.current.some((item) => item.id === next.id)) setImages((list) => [...list, uploaded]);
        setPending((list) => list.filter((item) => item.id !== next.id));
        URL.revokeObjectURL(next.preview);
        void dropPhoto(draftId, next.id);
      } catch (reason) {
        const message = (reason as Error).message || '照片没传上去';
        setPending((list) => list.map((item) => (item.id === next.id ? { ...item, failed: message } : item)));
      } finally {
        active.current = null;
        setUploadTurn((turn) => turn + 1);
      }
    })();
  }, [pending, ready, disabled, othersBusy, scope, draftId, uploadTurn]);
  const addImages = async (files: File[]) => {
    if (files.length === 0 || othersBusy || busy || queued || !ready || retrying) return;
    const unsupported = files.find((file) => !IMAGE_MIMES.has(file.type));
    if (unsupported) {
      setError('只支持 PNG、JPEG、GIF、WebP 或 AVIF 图片。');
      return;
    }
    setError('');
    // Each photo is kept on the device before it can upload (and be dropped).
    for (const file of files) {
      const item = pendingOf(crypto.randomUUID(), file);
      await keepPhoto(draftId, item.id, file, keyId).catch(() => {});
      setPending((list) => [...list, item]);
    }
  };
  const removePending = (item: Pending) => {
    URL.revokeObjectURL(item.preview);
    setPending((list) => list.filter((entry) => entry.id !== item.id));
    void dropPhoto(draftId, item.id);
  };
  const failSave = (message: string) => {
    setQueued(false);
    resumed.current = false;
    setError(message);
    onSaveFailed?.(message);
  };
  // The record goes out once every photo is uploaded.
  const commit = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    const wasResumed = resumed.current;
    try {
      setRetrying(true);
      const bodyText = quickRecordBody(text, images);
      const attachmentIds = images.map((file) => file.id);
      // Every append, including an existing entry, keeps its operation across reloads.
      markQuickRecord(draftId, keyId);
      await writeDraft(draftId, {
        content: JSON.stringify({ title, text, attachments: images, operationKey: operation.current, retrying: true, queued: true }),
        attachments: images, revision: 0, savedAt: Date.now(),
      }, keyId);
      if (onAppend) {
        if (attachmentIds.length > 0) await onAppend(title, bodyText, operation.current, attachmentIds);
        else await onAppend(title, bodyText, operation.current);
      } else if (attachmentIds.length > 0) {
        await append(title, bodyText, operation.current, attachmentIds);
      } else {
        await append(title, bodyText, operation.current);
      }
      operation.current = crypto.randomUUID();
      setTitle('');
      setText('');
      setImages([]);
      setRetrying(false);
      setQueued(false);
      resumed.current = false;
      removeDraft(draftId);
      void dropPhotos(draftId);
      onSaved({ resumed: wasResumed });
      field.current?.focus();
    } catch (reason) {
      // Lock the input only while the request may have been applied; a definite
      // failure (locked, deleted, too large, conflict) leaves it editable.
      setRetrying(uncertainFailure(reason));
      failSave((reason as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!queued || !ready || running.current || disabled || othersBusy) return;
    const failed = pending.find((item) => item.failed);
    if (failed) failSave('有张照片没传上去，还没保存。点它重试或移除后再保存。');
    else if (pending.length === 0) void commit();
    // commit and failSave read this render's input; this runs when the uploads settle.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, ready, pending, disabled, othersBusy]);
  const save = () => {
    if (running.current || queued || disabled || othersBusy || !ready) return;
    if (!text.trim() && images.length === 0 && pending.length === 0) return;
    if (pending.some((item) => item.failed)) {
      setError('有张照片没传上去，点它重试或移除后再保存。');
      return;
    }
    resumed.current = false;
    onSubmit?.();
    setQueued(true);
  };
  const locked = busy || queued || !ready || retrying;
  const uploadCount = pending.filter((item) => !item.failed).length;
  const failedPhoto = pending.find((item) => item.failed);
  return (
    <div className="quick-append-footer">
    <form className={`quick-append${expanded || focused || title || text || images.length || pending.length || busy || queued || retrying || error ? ' is-active' : ''}`} aria-label="快捷记录"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="quick-append-heading">
      <input aria-label="记录标题" placeholder="标题（可选）" value={title}
        disabled={locked} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="quick-append-body">
        {(images.length > 0 || pending.length > 0) && <div className="quick-append-images" aria-label="待追加照片">
          {images.map((file) => (
            <div className="quick-append-image" key={file.id}>
              <CachedImage src={fileUrl(file.id)} alt={file.name} loading="lazy" draggable={false} />
              <button className="icon-button" type="button" aria-label={`移除 ${file.name}`} disabled={busy || queued || retrying}
                onClick={() => setImages((list) => list.filter((item) => item.id !== file.id))}>
                <X size={14} />
              </button>
            </div>
          ))}
          {pending.map((item) => (
            <div className={`quick-append-image is-pending${item.failed ? ' is-failed' : ''}`} key={item.id}>
              <img src={item.preview} alt={item.file.name} draggable={false} />
              {item.failed ? (
                <button className="quick-append-image-retry" type="button" aria-label={`重试上传 ${item.file.name}`} title={item.failed}
                  onClick={() => setPending((list) => list.map((entry) => (entry.id === item.id ? { ...entry, failed: undefined } : entry)))}>
                  <RotateCcw size={16} />
                </button>
              ) : (
                <span className="quick-append-image-progress" aria-hidden="true"><LoaderCircle size={18} className="spin" /></span>
              )}
              <button className="icon-button" type="button" aria-label={`移除 ${item.file.name}`} disabled={busy || queued}
                onClick={() => removePending(item)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>}
        <div className="quick-append-editor">
          <textarea ref={field} aria-label="记录内容" placeholder={placeholder} rows={4} value={text}
            disabled={locked} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault(); save();
              }
            }} />
          <label className="icon-button quick-append-image-button" title="添加照片">
            <ImagePlus size={16} />
            <input type="file" aria-label="添加照片" accept={IMAGE_ACCEPT} multiple
              disabled={othersBusy || locked}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void addImages(files);
              }} />
          </label>
        </div>
      {(expanded || focused || !!title || !!text || images.length > 0 || pending.length > 0 || busy || queued) && <div className="quick-append-actions">
        {actions}
        <button className="button primary compact" type="submit"
          disabled={disabled || othersBusy || busy || queued || !ready || (!text.trim() && images.length === 0 && pending.length === 0)}>
          <Send size={15} />{busy ? '正在追加…' : queued ? '保存中…' : retrying ? '重试追加' : label}
        </button>
      </div>}
      </div>
      {uploadCount > 0 && <small className="upload-status" role="status">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
        {queued ? '正在上传照片，传完自动保存…' : `正在上传 ${uploadCount} 张照片…`}
      </small>}
      {disabled && <small>{pending.length ? '联网后继续' : '联网后可追加内容'}</small>}
      {failedPhoto && !error && <p className="inline-error" role="alert">
        有张照片没传上去，点它重试或移除
      </p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </form>
    </div>
  );
}
