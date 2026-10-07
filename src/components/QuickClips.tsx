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
  Copy,
  FilePlus2,
  ImagePlus,
  Lock,
  LockOpen,
  Pin,
  PinOff,
  Search,
  TextCursorInput,
  Trash2,
  X,
} from 'lucide-react';
import { api, cachedApi, fileUrl, formatDate, scopeOf, upload } from '../api';
import {
  addClip,
  discardPending,
  flushClips,
  onClipsSent,
  rememberClipKey,
  revealPending,
  setClipEncryption,
  usePendingClips,
  type PendingClip,
} from '../clips';
import { CLIP_CHARS, CLIP_IMAGE_MIME, type Clip, type ClipList } from '../../shared/clips';
import { MIN_ENCRYPTION_PASSWORD } from '../../shared/encryption';
import type { NoteNode, ShareSettings } from '../../shared/types';
import { createKey, defaultPolicy, isUnlocked, rewrap } from '../keyring';
import { LockedError } from '../encryption';
import { fileBlob } from '../offline-cache';
import { useOffline } from '../connectivity';
import { useInsertTarget, type InsertTarget } from '../note-insert';
import { useToast } from '../use-toast';
import { Modal, Spinner } from './Primitives';
import { CachedImage } from './CachedImage';
import { UnlockForm, useKeys } from './Encryption';
import { NodePicker } from './Tree';
import { markdownLink } from './LinkDialog';
import { shareDestinationLabel } from './ShareSettings';
import '../clips.css';

const ImageViewer = lazy(() => import('./ImageViewer'));
type Item = Clip & { pending?: PendingClip };
const LONG = 280;
// The server's order: newest first, then by ID.
const newestFirst = (a: Clip, b: Clip) =>
  b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

// The image of a clip as a file of its own, decrypted here when sealed.
async function clipFile(file: NonNullable<Clip['file']>) {
  const blob = await fileBlob(file.id);
  return new File([blob], file.name, { type: file.mime });
}
// The clipboard takes PNG everywhere, so other types are drawn into one first.
async function copyImage(file: NonNullable<Clip['file']>) {
  let blob: Blob = await fileBlob(file.id);
  if (file.mime !== 'image/png') {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error())), 'image/png'),
    );
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// 随手记: a persistent clipboard. Type to keep something, click one to copy it.
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
    void flushClips();
    return onClipsSent(() => void load());
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
  const recent = [...pending, ...saved].filter(match);
  const total = (list?.pinned.length ?? 0) + pending.length + saved.length;

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || (!text.trim() && !image)) return;
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
            disabled={keyLocked}
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
                disabled={keyLocked || offline}
                onChange={(event) => {
                  pick(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
            <button
              className="button primary compact"
              disabled={busy || keyLocked || (!text.trim() && !image)}
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
            正在编辑「{editor.title}」，可把随手记插入到光标处。
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
      onClose={onClose}
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

function ClipRow({
  item,
  offline,
  onCopy,
  onCopyImage,
  onView,
  onPin,
  onRemove,
  onInsert,
  onConvert,
  onSource,
}: {
  item: Item;
  offline: boolean;
  onCopy: () => void;
  onCopyImage: () => void;
  onView: () => void;
  onPin: () => void;
  onRemove: () => void;
  onInsert?: () => void;
  onConvert: () => void;
  onSource: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sealed = !!item.key_id && !isUnlocked(item.key_id);
  return (
    <li className={`clip-item${item.pending ? ' is-pending' : ''}`}>
      {sealed ? (
        <p className="clip-text clip-sealed">
          <Lock size={13} aria-hidden="true" />
          已加密，解锁后显示
        </p>
      ) : (
        // The image is a small thumbnail beside the text.
        <div className="clip-body">
          {item.text && (
            <button
              className={`clip-text${open ? ' is-open' : ''}`}
              title="点击复制"
              onClick={onCopy}
            >
              {item.text}
            </button>
          )}
          {item.file && (
            <button className="clip-image" title="查看大图" onClick={onView}>
              <CachedImage src={fileUrl(item.file.id)} alt={item.file.name} />
            </button>
          )}
        </div>
      )}
      <div className="clip-meta">
        <span>{formatDate(item.created_at)}</span>
        {item.source_id && item.source_title && (
          <button className="text-button clip-source" onClick={onSource}>
            {item.source_title}
          </button>
        )}
        {item.pending &&
          (item.pending.error ? (
            <span className="clip-error" role="alert">
              {item.pending.error}
            </span>
          ) : (
            <span className="clip-waiting">{offline ? '联网后保存' : '正在保存'}</span>
          ))}
        <span className="clip-actions">
          {item.text.length > LONG && !sealed && (
            <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '收起' : '展开'}
            </button>
          )}
          {item.file && !sealed && (
            <button className="icon-button" aria-label="复制图片" title="复制图片" onClick={onCopyImage}>
              <Copy size={15} />
            </button>
          )}
          {onInsert && !sealed && (
            <button
              className="icon-button"
              aria-label="插入到正文"
              title="插入到正文"
              disabled={offline && !!item.file}
              onClick={onInsert}
            >
              <TextCursorInput size={15} />
            </button>
          )}
          {!item.pending && !sealed && (
            <button
              className="icon-button"
              aria-label="转为笔记"
              title="转为笔记"
              disabled={offline}
              onClick={onConvert}
            >
              <FilePlus2 size={15} />
            </button>
          )}
          {!item.pending && (
            <button
              className="icon-button"
              aria-label={item.pinned ? '取消置顶' : '置顶'}
              title={item.pinned ? '取消置顶' : '置顶'}
              disabled={offline}
              onClick={onPin}
            >
              {item.pinned ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="删除"
            title="删除"
            disabled={offline && !item.pending}
            onClick={onRemove}
          >
            <Trash2 size={15} />
          </button>
        </span>
      </div>
    </li>
  );
}

// Moves a clip into the library as a Markdown note, then removes the clip.
function ClipToNote({
  item,
  onCancel,
  onDone,
}: {
  item: Item;
  onCancel: () => void;
  onDone: (node: NoteNode) => void;
}) {
  const firstLine = item.text.split('\n').find((line) => line.trim())?.trim() ?? '';
  const [title, setTitle] = useState(
    firstLine.slice(0, 60) || `随手记 ${new Date(item.created_at).toLocaleDateString('zh-CN')}`,
  );
  const [parent, setParent] = useState<string | null>(null);
  const [destination, setDestination] = useState<{
    title: string;
    path: ShareSettings['breadcrumbs'];
  } | null>(null);
  const [plainTarget, setPlainTarget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<ShareSettings>('/api/share/settings')
      .then((settings) => {
        if (!live) return;
        setParent(settings.parentId);
        setDestination({ title: shareDestinationLabel(settings), path: settings.breadcrumbs });
      })
      .catch(() => live && setDestination({ title: '根目录', path: [] }));
    return () => {
      live = false;
    };
  }, []);
  // An encrypted clip put in a plain place is no longer encrypted.
  useEffect(() => {
    let live = true;
    if (!item.key_id) return;
    void scopeOf(parent)
      .then((key) => live && setPlainTarget(!key))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [item.key_id, parent]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      const parts: string[] = [];
      const attachments: string[] = [];
      // The image is uploaded again into the note's place, sealed as it requires.
      if (item.file) {
        const file = await upload(await clipFile(item.file), parent);
        attachments.push(file.id);
        parts.push(`![${file.name.replace(/[[\]\\]/g, '')}](${fileUrl(file.id)})`);
      }
      if (item.text) parts.push(item.text);
      if (item.source_id && item.source_title)
        parts.push(`来源：${markdownLink({ id: item.source_id, title: item.source_title })}`);
      const node = await api<NoteNode>('/api/nodes', 'POST', {
        kind: 'markdown',
        title: title.trim(),
        parentId: parent,
        content: `${parts.join('\n\n')}\n`,
        attachments,
      });
      await api(`/api/clips/${item.id}`, 'DELETE').catch(() => {});
      onDone(node);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form-stack clips-convert" onSubmit={(event) => void submit(event)}>
      <p>转为 Markdown 笔记后，这条随手记会被移除。</p>
      <label>
        标题
        <input
          value={title}
          maxLength={200}
          required
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <fieldset disabled={busy}>
        <legend>保存位置</legend>
        {destination ? (
          <>
            <p className="destination-summary">保存到：{destination.title}</p>
            <NodePicker
              value={parent}
              parentsOnly
              initialPath={destination.path}
              onSelect={(id, label) => {
                setParent(id);
                setDestination({ ...destination, title: label });
              }}
            />
          </>
        ) : (
          <p role="status">正在读取默认保存目录…</p>
        )}
      </fieldset>
      {plainTarget && (
        <p className="field-hint">这条随手记已加密，目标位置未加密，转为笔记后将以明文保存。</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          返回
        </button>
        <button className="button primary" disabled={busy || !destination || !title.trim()}>
          {busy ? '正在保存…' : '转为笔记'}
        </button>
      </div>
    </form>
  );
}

// Sets, changes or removes the password of all clips. Existing clips are
// re-sealed here.
function ClipEncryption({ keyId, onDone }: { keyId: string | null; onDone: () => void }) {
  useKeys();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>, done = true) => {
    setBusy('正在处理…');
    setError('');
    try {
      await action();
      if (done) onDone();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };
  const progress = (count: number) => setBusy(`已处理 ${count} 项…`);
  const valid = password.length >= MIN_ENCRYPTION_PASSWORD && password === repeat;
  const passwordFields = (
    <>
      <label>
        {changing ? '新密码' : '密码'}
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={!!busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <label>
        再次输入
        <input
          type="password"
          autoComplete="new-password"
          value={repeat}
          disabled={!!busy}
          onChange={(event) => setRepeat(event.target.value)}
        />
      </label>
      <p className="field-hint">至少 {MIN_ENCRYPTION_PASSWORD} 位。</p>
    </>
  );
  let content;
  if (!keyId)
    content = (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          void run(async () => {
            const created = await createKey(password, defaultPolicy());
            await api('/api/encryption/keys', 'POST', created.record);
            created.commit();
            await setClipEncryption(created.record.id, progress);
          });
        }}
      >
        <p>设置密码后，随手记在本设备上加密再上传，密码不会上传。忘记密码将无法恢复内容。</p>
        {passwordFields}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={!!busy} onClick={onDone}>
            返回
          </button>
          <button className="button primary" disabled={!!busy || !valid}>
            {busy || '设置密码'}
          </button>
        </div>
      </form>
    );
  else if (!isUnlocked(keyId))
    content = (
      <>
        <p>请先解锁随手记的密码。</p>
        <UnlockForm keyId={keyId} />
        <button className="text-button" onClick={onDone}>
          返回
        </button>
      </>
    );
  else if (changing)
    content = (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          // The same content key under a new password: nothing is re-encrypted.
          void run(async () => {
            const next = await rewrap(keyId, null, password);
            await api(`/api/encryption/keys/${keyId}`, 'PUT', next.fields);
            next.commit();
          });
        }}
      >
        <p>修改密码不需要重新加密内容。其他设备上记住的密码会在下次联网时失效。</p>
        {passwordFields}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            disabled={!!busy}
            onClick={() => setChanging(false)}
          >
            返回
          </button>
          <button className="button primary" disabled={!!busy || !valid}>
            {busy || '修改密码'}
          </button>
        </div>
      </form>
    );
  else
    content = (
      <>
        <p>随手记已加密：内容在本设备上加密后再上传，密码不会上传。</p>
        <p className="field-hint">取消加密后，全部随手记会以明文保存在服务器上。</p>
        <div className="clips-encryption-actions">
          <button className="text-button" disabled={!!busy} onClick={() => setChanging(true)}>
            修改密码
          </button>
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() => void run(() => setClipEncryption(keyId, progress))}
          >
            检查并同步
          </button>
        </div>
        <div className="dialog-actions">
          <button className="button" disabled={!!busy} onClick={onDone}>
            返回
          </button>
          <button
            className="button danger"
            disabled={!!busy}
            onClick={() => void run(() => setClipEncryption(null, progress))}
          >
            {busy || '取消加密'}
          </button>
        </div>
      </>
    );
  return (
    <div className="form-stack clips-encryption">
      {content}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
