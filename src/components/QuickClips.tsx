import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from 'react';
import {
  ImagePlus,
  Lock,
  LockOpen,
  Search,
  X,
} from 'lucide-react';
import { api, cachedApi, fileUrl } from '../api';
import {
  addClip,
  discardPending,
  flushClips,
  onClipSaved,
  onClipsSent,
  rememberClipKey,
  revealPending,
  usePendingClips,
  type PendingClip,
} from '../clips';
import { CLIP_CHARS, CLIP_IMAGE_MIME, type Clip, type ClipList } from '../../shared/clips';
import type { NoteNode } from '../../shared/types';
import { isUnlocked } from '../keyring';
import { LockedError } from '../encryption';
import { clipFile, copyImage } from '../clip-image';
import { useOffline } from '../connectivity';
import { useInsertTarget, type InsertTarget } from '../note-insert';
import { useToast } from '../use-toast';
import { readDraft, removeDraft, writeDraft } from '../note-drafts';
import { Modal, Spinner } from './Primitives';
import { UnlockForm, useKeys } from './Encryption';
import { ClipRow } from './ClipRow';
import { ClipToNote } from './ClipToNote';
import { ClipEncryption } from './ClipEncryption';
import '../clips.css';

const ImageViewer = lazy(() => import('./ImageViewer'));
type Item = Clip & { pending?: PendingClip };
const COMPOSE_DRAFT = 'clips-compose';
// The server's order: newest first, then by ID.
const newestFirst = (a: Clip, b: Clip) =>
  b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

// 随手记: a persistent clipboard. Keeps text and images ready to insert into notes.
export function QuickClips({
  source,
  onClose,
  onNavigate,
  onCreated,
}: {
  // The page it was opened from, offered as the clip's source.
  source: { id: string; title: string } | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
  // A clip turned into a note.
  onCreated: (node: NoteNode) => void;
}) {
  const keys = useKeys();
  const offline = useOffline();
  const toast = useToast();
  const outbox = usePendingClips();
  const editor = useInsertTarget();
  const [list, setList] = useState<ClipList | null>(null);
  const [more, setMore] = useState<Clip[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [pending, setPending] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [withSource, setWithSource] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [locked, setLocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'list' | 'settings' | Item>('list');
  const [viewing, setViewing] = useState<NonNullable<Clip['file']> | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await api<ClipList>('/api/clips');
      rememberClipKey(fresh.keyId);
      setList(fresh);
      setMore([]);
      setNext(fresh.next);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);
  useEffect(() => {
    const unsaved = onClipSaved((clip) => {
      setList((current) => {
        if (!current) return current;
        const place = clip.pinned ? 'pinned' : 'items';
        const updated = {
          ...current,
          pinned: current.pinned.filter((item) => item.id !== clip.id),
          items: current.items.filter((item) => item.id !== clip.id),
        };
        updated[place] = [clip, ...updated[place]].sort(newestFirst);
        return updated;
      });
      setMore((current) => current.filter((item) => item.id !== clip.id));
    });
    const reload = () => void load();
    const unsubscribe = onClipsSent(reload);
    void flushClips();
    window.addEventListener('note:widget-clips-sent', reload);
    return () => {
      unsubscribe();
      unsaved();
      window.removeEventListener('note:widget-clips-sent', reload);
    };
  }, [load]);
  // The copy kept on this device shows first, then the server's answer.
  useEffect(() => {
    let live = true;
    void cachedApi<ClipList>('/api/clips').then((cached) => {
      if (live && cached) setList((current) => current ?? cached);
    });
    void load();
    return () => {
      live = false;
    };
  }, [load]);
  useEffect(() => {
    let live = true;
    void revealPending(outbox).then((items) => live && setPending(items));
    return () => {
      live = false;
    };
  }, [outbox, keys]);

  const keyId = list?.keyId ?? null;
  const keyLocked = !!keyId && !isUnlocked(keyId);
  const sourceId = source?.id ?? null;
  useEffect(() => {
    if (keyLocked) {
      setText('');
      setDraftReady(false);
      return;
    }
    if (!list || draftReady) return;
    let live = true;
    void readDraft(COMPOSE_DRAFT).then((draft) => {
      if (!live) return;
      if (draft) {
        try {
          const value = JSON.parse(draft.content);
          if (typeof value.text === 'string') {
            setText(value.text);
            setWithSource(!!sourceId && value.sourceId === sourceId);
          }
        } catch { /* Ignore an invalid draft. */ }
      }
      setDraftReady(true);
    });
    return () => { live = false; };
  }, [list, keyLocked, draftReady, sourceId]);
  useEffect(() => {
    if (!draftReady || keyLocked) return;
    if (!text) removeDraft(COMPOSE_DRAFT);
    else void writeDraft(COMPOSE_DRAFT, {
      content: JSON.stringify({ text, sourceId: withSource ? sourceId : null }),
      attachments: [], revision: 0, savedAt: Date.now(),
    }, keyId);
  }, [draftReady, keyLocked, keyId, text, withSource, sourceId]);
  // Text arrives opened only while its key is unlocked, so unlocking reads
  // the list again; locking just hides what is shown.
  const wasLocked = useRef(keyLocked);
  useEffect(() => {
    if (wasLocked.current && !keyLocked) void load();
    wasLocked.current = keyLocked;
  }, [keyLocked, load]);
  const saved = useMemo(() => {
    const waiting = new Set(outbox.map((item) => item.id));
    return [...(list?.items ?? []), ...more].filter((item) => !waiting.has(item.id));
  }, [list, more, outbox]);
  const query = filter.trim().toLowerCase();
  const match = (item: Item) =>
    !query ||
    (!(item.key_id && !isUnlocked(item.key_id)) && item.text.toLowerCase().includes(query));
  const pinned = (list?.pinned ?? []).filter(match);
  // Decryption finishes asynchronously; stop rendering a pending copy as soon
  // as it leaves the outbox, in the same render that shows its saved record.
  const waiting = pending.filter((item) => outbox.some((entry) => entry.id === item.id));
  const recent = [...waiting, ...saved].filter(match);
  const total = (list?.pinned.length ?? 0) + waiting.length + saved.length;

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !draftReady || keyLocked || (!text.trim() && !image)) return;
    setBusy(true);
    setError('');
    try {
      await addClip(text, withSource ? source : null, undefined, image ?? undefined);
      setText('');
      setImage(null);
      field.current?.focus();
    } catch (reason) {
      if (reason instanceof LockedError) setLocked(reason.keyId);
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!CLIP_IMAGE_MIME.test(file.type)) {
      setError('只支持 PNG、JPEG、GIF、WebP 或 AVIF 图片。');
      return;
    }
    setError('');
    setImage(file);
  };
  const paste = (event: ClipboardEvent) => {
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    pick(file);
  };
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (reason) {
      toast.show((reason as Error).message);
    }
  };
  const copy = (item: Item) =>
    run(async () => {
      if (!item.text) return;
      try {
        await navigator.clipboard.writeText(item.text);
        toast.show('已复制');
      } catch {
        toast.show('复制失败，请展开后手动选择文字。');
      }
    });
  // Pinning and deleting change the loaded lists in place rather than reading them again.
  const without = (id: string) => {
    setList((current) =>
      current && {
        ...current,
        pinned: current.pinned.filter((entry) => entry.id !== id),
        items: current.items.filter((entry) => entry.id !== id),
      },
    );
    setMore((current) => current.filter((entry) => entry.id !== id));
  };
  const pin = (item: Clip) =>
    run(async () => {
      const updated = await api<Clip>(`/api/clips/${item.id}`, 'PATCH', { pinned: !item.pinned });
      without(item.id);
      setList((current) => {
        if (!current) return current;
        const place = updated.pinned ? 'pinned' : 'items';
        return { ...current, [place]: [updated, ...current[place]].sort(newestFirst) };
      });
    });
  const remove = (item: Item) =>
    run(async () => {
      if (item.pending) {
        discardPending(item.id);
        return;
      }
      await api(`/api/clips/${item.id}`, 'DELETE');
      without(item.id);
      if (item.text || item.file)
        toast.show('已删除', async () => {
          await addClip(
            item.text,
            item.source_id ? { id: item.source_id, title: item.source_title ?? '' } : null,
            { id: item.id, createdAt: item.created_at, file: item.file },
          ).catch((reason) => toast.show((reason as Error).message));
        });
    });
  const insert = (item: Item, target: InsertTarget) =>
    run(async () => {
      if (item.file) await target.addFiles([await clipFile(item.file)]);
      if (item.text) target.insert(item.text);
      onClose();
    });
  const older = () =>
    run(async () => {
      if (!next) return;
      const page = await api<ClipList>(`/api/clips?before=${encodeURIComponent(next)}`);
      setMore((current) => [...current, ...page.items]);
      setNext(page.next);
    });

  const row = (item: Item) => (
    <ClipRow
      key={item.id}
      item={item}
      offline={offline}
      onCopy={() => void copy(item)}
      onCopyImage={() =>
        void run(async () => {
          try {
            await copyImage(item.file!);
            toast.show('已复制图片');
          } catch {
            toast.show('无法复制图片，请在大图里下载。');
          }
        })
      }
      onView={() => setViewing(item.file)}
      onPin={() => void pin(item)}
      onRemove={() => void remove(item)}
      onInsert={editor ? () => void insert(item, editor) : undefined}
      onConvert={() => setView(item)}
      onSource={() => {
        onClose();
        onNavigate(item.source_id!);
      }}
    />
  );

  let body;
  if (view === 'settings')
    body = (
      <ClipEncryption
        keyId={keyId}
        onDone={async () => {
          setView('list');
          await load();
        }}
      />
    );
  else if (view !== 'list')
    body = (
      <ClipToNote
        item={view}
        onCancel={() => setView('list')}
        onDone={(node) => {
          onClose();
          onCreated(node);
        }}
      />
    );
  else
    body = (
      <>
        {(keyLocked || locked) && (
          <div className="clips-locked">
            <p>
              <Lock size={14} aria-hidden="true" /> 随手记已加密，解锁后才能查看和新增。
            </p>
            <UnlockForm
              keyId={(keyLocked ? keyId : locked)!}
              onUnlocked={() => {
                setLocked(null);
                setError('');
              }}
            />
          </div>
        )}
        <form className="clips-compose" onSubmit={save}>
          <textarea
            ref={field}
            aria-label="随手记内容"
            placeholder="记下点什么，可粘贴图片… Ctrl+Enter 保存"
            rows={3}
            autoFocus
            maxLength={CLIP_CHARS}
            value={text}
            disabled={busy || keyLocked || !draftReady}
            onChange={(event) => setText(event.target.value)}
            onPaste={paste}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void save();
              }
            }}
          />
          {image && <ImageDraft file={image} onRemove={() => setImage(null)} />}
          <div className="clips-compose-actions">
            {source && (
              <label className="clips-source-toggle">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={withSource}
                  onChange={(event) => setWithSource(event.target.checked)}
                />
                <span>附上来源「{source.title}」</span>
              </label>
            )}
            <label
              className={`icon-button clips-image-button${keyLocked || offline ? ' is-disabled' : ''}`}
              title={offline ? '图片需要联网后才能存入' : '添加图片'}
            >
              <ImagePlus size={18} />
              <input
                type="file"
                aria-label="添加图片"
                accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                disabled={busy || keyLocked || offline || !draftReady}
                onChange={(event) => {
                  pick(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
            <button
              className="button primary compact"
              disabled={busy || keyLocked || !draftReady || (!text.trim() && !image)}
            >
              {busy && image ? '上传中…' : '保存'}
            </button>
          </div>
        </form>
        {error && !locked && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {editor && (
          <p className="clips-insert-hint">
            插入位置：「{editor.title}」的光标处
          </p>
        )}
        {total > 5 && (
          <label className="clips-filter">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="筛选随手记"
              placeholder="筛选"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
        )}
        {pinned.length > 0 && (
          <section aria-label="置顶">
            <h3 className="clips-group">置顶</h3>
            <ul className="clips-list">{pinned.map(row)}</ul>
          </section>
        )}
        {recent.length > 0 ? (
          <section aria-label="最近">
            {pinned.length > 0 && <h3 className="clips-group">最近</h3>}
            <ul className="clips-list">{recent.map(row)}</ul>
          </section>
        ) : (
          list &&
          !pinned.length && (
            <p className="clips-empty">{filter ? '没有匹配的随手记。' : '还没有随手记。'}</p>
          )
        )}
        {next && !filter && (
          <button
            className="text-button clips-more"
            disabled={offline}
            onClick={() => void older()}
          >
            加载更早的
          </button>
        )}
      </>
    );
  return (
    <Modal
      title="随手记"
      className="clips-modal"
      onClose={() => { if (!busy) onClose(); }}
      actions={
        // Whether clips are encrypted, and the way to their password.
        <button
          className={`icon-button clips-lock${keyId ? ' is-encrypted' : ''}${view === 'settings' ? ' is-active' : ''}`}
          aria-label={`加密设置（${keyId ? '已加密' : '未加密'}）`}
          title={keyId ? '已加密 · 加密设置' : '未加密 · 加密设置'}
          disabled={offline && view !== 'settings'}
          onClick={() => setView('settings')}
        >
          {keyId ? <Lock size={17} /> : <LockOpen size={17} />}
        </button>
      }
    >
      {body}
      {toast.element}
      {viewing && (
        <Suspense fallback={<Spinner />}>
          <ImageViewer
            src={fileUrl(viewing.id)}
            alt={viewing.name}
            onClose={() => setViewing(null)}
          />
        </Suspense>
      )}
    </Modal>
  );
}

function ImageDraft({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return (
    <div className="clips-image-draft">
      {url && <img src={url} alt={file.name} />}
      <button type="button" className="icon-button" aria-label="移除图片" onClick={onRemove}>
        <X size={15} />
      </button>
    </div>
  );
}
