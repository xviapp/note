import { useRef, useState, type FormEvent } from 'react';
import { api, upload } from '../api';
import { importPaper } from '../arxiv-import';
import {
  BOOK_ROLE_LIMIT,
  KIND_LABELS,
  UNTITLED_NAMES,
  type ArxivImportProgress,
  type FileInfo,
  type NodeKind,
  type NoteNode,
} from '../../shared/types';
import { Modal, NodeIcon } from './Primitives';
import { FolderIconPicker, type FolderIconValue } from './FolderIconPicker';
import { isFolderEmoji } from '../../shared/folder-icons';

export function NodeForm({
  node,
  parent,
  existingFile,
  iconOnly = false,
  onClose,
  onSaved,
}: {
  node?: NoteNode;
  parent: string | null;
  existingFile?: FileInfo;
  iconOnly?: boolean;
  onClose: () => void;
  onSaved: (node: NoteNode) => void;
}) {
  const [kind, setKind] = useState<NodeKind | 'arxiv' | 'book'>(
    node?.kind ||
      (existingFile ? (existingFile.mime === 'application/pdf' ? 'pdf' : 'image') : 'markdown'),
  );
  const [title, setTitle] = useState(node?.title || existingFile?.name || ''),
    [url, setUrl] = useState(node?.url || '');
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const uploaded = useRef<FileInfo | null>(existingFile || null),
    key = useRef(crypto.randomUUID());
  // An unfinished paper import resumes from here after a failed step.
  const continued = useRef<string | null>(null),
    [progress, setProgress] = useState<ArxivImportProgress | null>(null);
  const [icon, setIcon] = useState<FolderIconValue>({
    emoji: node?.icon_emoji ?? null,
    fileId: node?.icon_blob_id ?? null,
  });
  const [author, setAuthor] = useState(''),
    [pageCount, setPageCount] = useState(''),
    [role, setRole] = useState('');
  // A book is a folder created with its reading details.
  const folderLike = kind === 'folder' || kind === 'book';
  const [preparingIcon, setPreparingIcon] = useState(false);
  const uploadedIcon = useRef<{ source: File; info: FileInfo } | null>(null);
  const working = busy || preparingIcon;
  const close = () => {
    if (working) return;
    if (uploaded.current && !existingFile)
      void api(`/api/files/${uploaded.current.id}`, 'DELETE').catch(() => {});
    if (uploadedIcon.current)
      void api(`/api/files/${uploadedIcon.current.info.id}`, 'DELETE').catch(() => {});
    onClose();
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setBusy(true);
    setError('');
    try {
      let iconData;
      if (folderLike) {
        if (icon.emoji && !isFolderEmoji(icon.emoji)) throw new Error('请输入一个 Emoji。');
        if (icon.file && uploadedIcon.current?.source !== icon.file) {
          if (uploadedIcon.current)
            await api(`/api/files/${uploadedIcon.current.info.id}`, 'DELETE').catch(() => {});
          uploadedIcon.current = { source: icon.file, info: await upload(icon.file) };
        }
        iconData = {
          emoji: icon.emoji,
          fileId: icon.file ? uploadedIcon.current!.info.id : icon.fileId,
        };
      }
      if (!node && ['pdf', 'image'].includes(kind) && !uploaded.current) {
        if (!file) throw new Error('请先选择一个文件。');
        uploaded.current = await upload(file);
      }
      if (kind === 'arxiv' && !continued.current) setProgress(null);
      const result = node
        ? await api<NoteNode>(`/api/nodes/${node.id}`, 'PATCH', {
            title,
            ...(kind === 'link' && !node.arxiv_id ? { url } : {}),
            revision: node.revision,
            ...(folderLike ? { icon: iconData } : {}),
          })
        : kind === 'arxiv'
          ? await importPaper({ title, parentId: parent, url }, key.current, continued, setProgress)
          : await api<NoteNode>(
              '/api/nodes',
              'POST',
              {
                kind: kind === 'book' ? 'folder' : kind,
                title,
                parentId: parent,
                url,
                fileId: uploaded.current?.id,
                content: '',
                ...(folderLike ? { icon: iconData } : {}),
                ...(kind === 'book'
                  ? { book: { author, pageCount: Number(pageCount) || 0, rolePrompt: role } }
                  : {}),
              },
              key.current,
            );
      if (uploadedIcon.current && uploadedIcon.current.info.id !== result.icon_blob_id)
        void api(`/api/files/${uploadedIcon.current.info.id}`, 'DELETE').catch(() => {});
      onSaved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        iconOnly
          ? '更换文件夹图标'
          : node
            ? '修改笔记信息'
            : existingFile
              ? '将附件添加到笔记树'
              : '新建笔记'
      }
      onClose={close}
    >
      <form onSubmit={save} className="form-stack">
        {!node && !existingFile && (
          <fieldset className="kind-choices">
            <legend>内容类型</legend>
            {Object.entries(KIND_LABELS)
              .flatMap((entry) => (entry[0] === 'folder' ? [entry, ['book', '书籍']] : [entry]))
              .concat([['arxiv', 'arXiv 论文']])
              .map(([value, label]) => (
                <label key={value} className={kind === value ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="kind"
                    value={value}
                    checked={kind === value}
                    disabled={working || !!uploaded.current}
                    onChange={() => setKind(value as NodeKind | 'arxiv' | 'book')}
                  />
                  <NodeIcon kind={value as NodeKind | 'arxiv' | 'book'} />
                  {label}
                </label>
              ))}
          </fieldset>
        )}
        {!iconOnly && (
          <label>
            标题
            <input
              autoFocus
              required={!!node}
              placeholder={
                kind === 'arxiv'
                  ? '留空使用论文标题'
                  : node
                    ? undefined
                    : kind === 'book'
                      ? '书名'
                      : UNTITLED_NAMES[kind]
              }
              maxLength={200}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                continued.current = null;
              }}
              disabled={working}
            />
          </label>
        )}
        {kind === 'book' && !node && (
          <>
            <label>
              作者
              <input
                maxLength={200}
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                disabled={working}
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
                disabled={working}
              />
            </label>
            <label>
              青藜角色
              <textarea
                rows={4}
                maxLength={BOOK_ROLE_LIMIT}
                value={role}
                placeholder="例如：你是这本书的导读老师，先讲清作者的论证，再提出值得追问的问题。"
                onChange={(e) => setRole(e.target.value)}
                disabled={working}
              />
              <span className="field-hint">书中所有页面和讨论与青藜对话时都会使用这个角色。</span>
            </label>
          </>
        )}
        {folderLike && (
          <FolderIconPicker
            value={icon}
            onChange={setIcon}
            disabled={working}
            onBusy={setPreparingIcon}
          />
        )}
        {(kind === 'link' || kind === 'arxiv') && !node?.arxiv_id && (
          <label>
            {kind === 'arxiv' ? 'arXiv 论文地址' : '网页地址'}
            <input
              type="url"
              required
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                continued.current = null;
              }}
              placeholder={
                kind === 'arxiv' ? 'https://arxiv.org/html/2503.01800v1' : 'https://example.com'
              }
              disabled={busy}
            />
          </label>
        )}
        {!node && !existingFile && ['pdf', 'image'].includes(kind) && (
          <label>
            选择文件
            <input
              type="file"
              required={!uploaded.current}
              accept={
                kind === 'pdf'
                  ? 'application/pdf'
                  : 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml'
              }
              disabled={busy || !!uploaded.current}
              onChange={(e) => {
                const selected = e.target.files?.[0] || null;
                setFile(selected);
                if (!title) setTitle(selected?.name || '');
              }}
            />
            <span className="field-hint">单个文件不超过 50 MB</span>
          </label>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={close} disabled={working}>
            取消
          </button>
          <button
            className="button primary"
            disabled={working || (folderLike && !!icon.emoji && !isFolderEmoji(icon.emoji))}
          >
            {busy
              ? kind === 'arxiv'
                ? progress
                  ? `正在下载论文图片 ${progress.done}/${progress.total}…`
                  : '正在导入论文和图片…'
                : '正在保存…'
              : node
                ? '保存信息'
                : kind === 'arxiv'
                  ? '导入论文'
                  : '创建'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
