import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BookText, Camera, PenLine, Settings2 } from 'lucide-react';
import { api, fileUrl, upload } from '../api';
import { addBookPage, pagePhoto } from '../books';
import {
  BOOK_STATUS_LABELS,
  type BookInfo,
  type BookStatus,
  type NoteDetail,
  type NoteNode,
} from '../../shared/types';
import { BookRoleField } from './BookRoleField';
import { Modal } from './Primitives';
import { CachedImage } from './CachedImage';

// The top of a book's page: its details, and adding pages or discussions.
export function BookCard({
  book,
  offline,
  onEdit,
  onChanged,
  onOpen,
  onError,
}: {
  book: BookInfo;
  offline: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onOpen: (node: NoteNode) => void;
  onError: (error: unknown) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<File[]>([]),
    [typing, setTyping] = useState(false);
  const [progress, setProgress] = useState(''),
    [collecting, setCollecting] = useState(false);
  // Every page's reading note in page order, as one note in the book.
  const collect = async () => {
    setCollecting(true);
    try {
      const result = await api<{ note: NoteNode }>(`/api/nodes/${book.id}/book-note`, 'POST', {});
      onChanged();
      onOpen(result.note);
    } catch (error) {
      onError(error);
    } finally {
      setCollecting(false);
    }
  };
  const percent = book.page_count
    ? Math.min(100, Math.round((book.pages_read / book.page_count) * 100))
    : 0;
  const recognize = async (start: number | null) => {
    const files = photos;
    setPhotos([]);
    let done = 0;
    try {
      for (const [index, file] of files.entries()) {
        setProgress(`正在识别 ${index + 1}/${files.length}…`);
        const page = await addBookPage(book.id, file, start ? start + index : null);
        done++;
        // The summary and questions can be made again from the page if this fails.
        setProgress(`正在生成摘要 ${index + 1}/${files.length}…`);
        await api(`/api/nodes/${page.id}/insights`, 'POST', {}).catch(() => {});
      }
    } catch (error) {
      onError(error);
    } finally {
      setProgress('');
      if (done) onChanged();
    }
  };
  return (
    <section className="book-card" aria-label="书籍资料">
      <div className="book-details">
      {book.cover_blob_id && <CachedImage className="book-cover" src={fileUrl(book.cover_blob_id)} alt={`《${book.title}》封面`} />}
      <div className="book-description">
      <div className="book-facts">
        <span className="book-status">{BOOK_STATUS_LABELS[book.status]}</span>
        {book.author && <span>{book.author}</span>}
        {book.page_count > 0 && (
          <span>
            {book.pages_read}/{book.page_count} 页
          </span>
        )}
      </div>
      {book.page_count > 0 && (
        <div
          className="book-progress"
          role="progressbar"
          aria-label="阅读进度"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {book.role_prompt && <p className="book-role">青藜角色：{book.role_prompt}</p>}
      </div>
      </div>
      <div className="book-actions">
        <button
          className="button compact primary"
          disabled={offline || !!progress}
          onClick={() => input.current?.click()}
        >
          <Camera size={15} />
          <span>{progress || '拍照添加页面'}</span>
        </button>
        <button
          className="button compact"
          disabled={offline || !!progress}
          onClick={() => setTyping(true)}
        >
          <PenLine size={15} />
          <span>手动添加页面</span>
        </button>
        <button
          className="button compact"
          disabled={offline || collecting}
          onClick={() => void collect()}
        >
          <BookText size={15} />
          <span>{collecting ? '正在汇总…' : '汇总读书笔记'}</span>
        </button>
        <button className="button compact" disabled={offline} onClick={onEdit}>
          <Settings2 size={15} />
          <span>书籍资料</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            setPhotos(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>
      {typing && (
        <ManualPageDialog
          bookId={book.id}
          next={book.pages_read + 1}
          onClose={() => setTyping(false)}
          onSaved={(page) => {
            setTyping(false);
            onChanged();
            onOpen(page);
          }}
        />
      )}
      {photos.length > 0 && (
        <PageNumberDialog
          count={photos.length}
          next={book.pages_read + 1}
          onClose={() => setPhotos([])}
          onStart={(start) => void recognize(start)}
        />
      )}
    </section>
  );
}

// A page typed in (or pasted) instead of photographed.
function ManualPageDialog({
  bookId,
  next,
  onClose,
  onSaved,
}: {
  bookId: string;
  next: number;
  onClose: () => void;
  onSaved: (page: NoteNode) => void;
}) {
  const [page, setPage] = useState(String(next)),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('正在保存…');
    setError('');
    try {
      const created = await api<NoteNode>(
        `/api/nodes/${bookId}/pages`,
        'POST',
        { content: text, ...(Number(page) ? { page: Number(page) } : {}) },
        key.current,
      );
      // The summary and questions can be made again from the page if this fails.
      setBusy('正在生成摘要…');
      await api(`/api/nodes/${created.id}/insights`, 'POST', {}).catch(() => {});
      onSaved(created);
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  };
  return (
    <Modal title="手动添加页面" onClose={() => !busy && onClose()}>
      <form className="form-stack" onSubmit={(event) => void save(event)}>
        <label>
          页码
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            value={page}
            placeholder="留空则不记页码"
            onChange={(event) => setPage(event.target.value)}
            disabled={!!busy}
          />
        </label>
        <label>
          正文
          <textarea
            rows={10}
            required
            value={text}
            placeholder="输入或粘贴这一页的文字，支持 Markdown。"
            onChange={(event) => setText(event.target.value)}
            disabled={!!busy}
            autoFocus
          />
          <span className="field-hint">保存后青藜会为这一页生成摘要和值得追问的问题。</span>
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={!!busy}>
            取消
          </button>
          <button className="button primary" disabled={!!busy || !text.trim()}>
            {busy || '保存页面'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PageNumberDialog({
  count,
  next,
  onClose,
  onStart,
}: {
  count: number;
  next: number;
  onClose: () => void;
  onStart: (start: number | null) => void;
}) {
  const [page, setPage] = useState(String(next));
  return (
    <Modal title={`识别 ${count} 张书页`} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          onStart(Number(page) || null);
        }}
      >
        <label>
          {count > 1 ? '起始页码' : '页码'}
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            value={page}
            placeholder="留空则不记页码"
            onChange={(event) => setPage(event.target.value)}
            autoFocus
          />
          <span className="field-hint">
            照片交给 DeepSeek 识别文字，使用你的 API 额度；每张照片保存为一页笔记。
          </span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary">开始识别</button>
        </div>
      </form>
    </Modal>
  );
}

// Edit a book's details.
export function BookForm({
  note,
  onClose,
  onSaved,
}: {
  note: NoteDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = note.book!;
  const [title, setTitle] = useState(current.title);
  const [coverId, setCoverId] = useState(current.cover_blob_id);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const uploadedCover = useRef<{ file: File; id: string } | null>(null);
  useEffect(() => {
    if (!coverFile) { setPreview(''); return; }
    const url = URL.createObjectURL(coverFile);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);
  const [author, setAuthor] = useState(current.author);
  const [status, setStatus] = useState<BookStatus>(current.status);
  const [pageCount, setPageCount] = useState(String(current.page_count || ''));
  const [pagesRead, setPagesRead] = useState(String(current.pages_read || ''));
  const [role, setRole] = useState(current.role_prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await task();
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      let savedCover = coverId;
      if (coverFile) {
        if (uploadedCover.current?.file !== coverFile) {
          const file = await upload(await pagePhoto(coverFile), note.id);
          uploadedCover.current = { file: coverFile, id: file.id };
        }
        savedCover = uploadedCover.current.id;
      }
      return api(`/api/nodes/${note.id}/book`, 'PUT', {
        title,
        revision: note.revision,
        coverId: savedCover,
        author,
        status,
        pageCount: Number(pageCount) || 0,
        pagesRead: Number(pagesRead) || 0,
        rolePrompt: role,
      });
    });
  };
  return (
    <Modal title="书籍资料" onClose={() => !busy && onClose()}>
      <form className="form-stack" onSubmit={save}>
        <label>
          书名
          <input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
        </label>
        <div className="book-cover-field">
          <span>封面</span>
          <div className="book-cover-controls">
            {preview ? <img className="book-cover" src={preview} alt="待保存的封面" /> : coverId ? <CachedImage className="book-cover" src={fileUrl(coverId)} alt={`《${title}》封面`} /> : <div className="book-cover book-cover-empty"><BookText size={28} /><span>暂无封面</span></div>}
            <div className="form-stack">
              <label>
                上传封面
                <input type="file" accept="image/*" aria-label="上传封面" disabled={busy} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) { setCoverFile(file); uploadedCover.current = null; }
                  event.target.value = '';
                }} />
              </label>
              <span className="field-hint">选择图片或拍摄封面，保存时自动压缩。</span>
              {(coverId || coverFile) && <button type="button" className="text-button" disabled={busy} onClick={() => { setCoverId(null); setCoverFile(null); uploadedCover.current = null; }}>移除封面</button>}
            </div>
          </div>
        </div>
        <label>
          作者
          <input
            maxLength={200}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          阅读状态
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as BookStatus)}
            disabled={busy}
          >
            {Object.entries(BOOK_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="book-pages-fields">
          <label>
            已读页数
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100000}
              value={pagesRead}
              onChange={(e) => setPagesRead(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            总页数
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100000}
              value={pageCount}
              onChange={(e) => setPageCount(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>
        <BookRoleField
          value={role}
          onChange={setRole}
          title={title}
          author={author}
          disabled={busy}
          rows={5}
        />
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? '正在保存…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
