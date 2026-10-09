import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Send, X } from 'lucide-react';
import { fileUrl, uncertainFailure, upload } from '../api';
import { createNoteAppender } from '../append-note';
import type { RecordKind } from '../../shared/records';
import type { FileInfo } from '../../shared/types';
import { readDraft, removeDraft, writeDraft } from '../note-drafts';
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

// A reusable composer for adding a block to a text note without opening its editor.
export function QuickAppend({ id, keyId, uploadScope, disabled, blocked = false, onSaved, onAppend, actions, onBusy, kind, label = '追加', placeholder = '记下此刻，追加到正文…', autoFocus = false }: {
  id: string;
  keyId?: string | null;
  // The note that owns an upload. A new journal entry uses its journal folder
  // as the scope until the entry itself exists.
  uploadScope?: string | null;
  disabled: boolean;
  blocked?: boolean;
  onSaved: () => void;
  onAppend?: (title: string, text: string, operationKey: string, attachmentIds?: string[]) => Promise<void>;
  actions?: ReactNode;
  onBusy?: (busy: boolean) => void;
  kind?: RecordKind;
  label?: string;
  placeholder?: string;
  // Focus the body once a saved draft is restored.
  autoFocus?: boolean;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [focused, setFocused] = useState(false);
  const [images, setImages] = useState<FileInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const running = useRef(false);
  const operation = useRef(crypto.randomUUID());
  const field = useRef<HTMLTextAreaElement>(null);
  const append = useMemo(() => createNoteAppender(id, kind), [id, kind]);
  const draftId = `append:${id}`;
  const scope = uploadScope ?? id;
  useEffect(() => {
    let live = true;
    void readDraft(draftId).then((draft) => {
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
          }
        } catch { /* Ignore an invalid draft. */ }
      }
      setReady(true);
    });
    return () => { live = false; };
  }, [draftId]);
  useEffect(() => {
    if (ready && autoFocus) field.current?.focus();
  }, [ready, autoFocus]);
  useEffect(() => {
    if (!ready || busy || uploading) return;
    if (!title && !text && images.length === 0) removeDraft(draftId);
    else writeDraft(draftId, {
      content: JSON.stringify({ title, text, attachments: images, operationKey: operation.current, retrying }),
      attachments: images, revision: 0, savedAt: Date.now(),
    }, keyId);
  }, [draftId, keyId, ready, busy, uploading, title, text, images, retrying]);
  const addImages = async (files: File[]) => {
    if (files.length === 0 || disabled || blocked || busy || uploading || !ready || retrying) return;
    const unsupported = files.find((file) => !IMAGE_MIMES.has(file.type));
    if (unsupported) {
      setError('只支持 PNG、JPEG、GIF、WebP 或 AVIF 图片。');
      return;
    }
    setError('');
    setUploading(true);
    onBusy?.(true);
    try {
      for (const file of files) {
        const uploaded = await upload(file, scope);
        setImages((current) => [...current, uploaded]);
      }
    } catch (reason) {
      setError((reason as Error).message || '图片上传失败，请重试。');
    } finally {
      setUploading(false);
      onBusy?.(false);
    }
  };
  const save = async () => {
    if (running.current || disabled || blocked || !ready || (!text.trim() && images.length === 0)) return;
    running.current = true;
    onBusy?.(true);
    setBusy(true);
    setError('');
    try {
      setRetrying(true);
      const imageText = images
        .map((file) => `![${file.name.replace(/[[\]\\]/g, '')}](${fileUrl(file.id)})`)
        .join('\n\n');
      const bodyText = [text.trim(), imageText].filter(Boolean).join('\n\n');
      const attachmentIds = images.map((file) => file.id);
      // Every append, including an existing entry, keeps its operation across reloads.
      await writeDraft(draftId, {
        content: JSON.stringify({ title, text, attachments: images, operationKey: operation.current, retrying: true }),
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
      removeDraft(draftId);
      onSaved();
      field.current?.focus();
    } catch (reason) {
      setError((reason as Error).message);
      // Lock the input only while the request may have been applied; a definite
      // failure (locked, deleted, too large, conflict) leaves it editable.
      setRetrying(uncertainFailure(reason));
    } finally {
      running.current = false;
      onBusy?.(false);
      setBusy(false);
    }
  };
  return (
    <div className="quick-append-footer">
    <form className={`quick-append${focused || title || text || images.length || busy || uploading || retrying || error ? ' is-active' : ''}`} aria-label="快捷记录"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="quick-append-heading">
      <input aria-label="记录标题" placeholder="标题（可选）" value={title}
        disabled={busy || uploading || !ready || retrying} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="quick-append-body">
        {images.length > 0 && <div className="quick-append-images" aria-label="待追加照片">
          {images.map((file) => (
            <div className="quick-append-image" key={file.id}>
              <CachedImage src={fileUrl(file.id)} alt={file.name} loading="lazy" draggable={false} />
              <button className="icon-button" type="button" aria-label={`移除 ${file.name}`} disabled={busy || uploading || retrying}
                onClick={() => setImages((current) => current.filter((item) => item.id !== file.id))}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>}
        <div className="quick-append-editor">
          <textarea ref={field} aria-label="记录内容" placeholder={placeholder} rows={4} value={text}
            disabled={busy || uploading || !ready || retrying} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault(); void save();
              }
            }} />
          <label className="icon-button quick-append-image-button" title={uploading ? '正在上传照片…' : '添加照片'}>
            <ImagePlus size={16} />
            <input type="file" aria-label="添加照片" accept={IMAGE_ACCEPT} multiple
              disabled={disabled || blocked || busy || uploading || !ready || retrying}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void addImages(files);
              }} />
          </label>
        </div>
      {(focused || !!title || !!text || images.length > 0 || busy || uploading) && <div className="quick-append-actions">
        {actions}
        <button className="button primary compact" type="submit" disabled={disabled || blocked || busy || uploading || !ready || (!text.trim() && images.length === 0)}>
          <Send size={15} />{busy ? '正在追加…' : retrying ? '重试追加' : label}
        </button>
      </div>}
      </div>
      {disabled && <small>联网后可追加内容</small>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </form>
    </div>
  );
}
