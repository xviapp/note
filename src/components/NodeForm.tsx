import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError, upload } from '../api';
import {
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
  const [kind, setKind] = useState<NodeKind | 'arxiv'>(
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
  // Papers with many images import over several requests; the server returns
  // signed progress until the note is created.
  async function importPaper() {
    if (!continued.current) setProgress(null);
    let result = continued.current
      ? null
      : await api<NoteNode | ArxivImportProgress>(
          '/api/import/arxiv',
          'POST',
          { title, parentId: parent, url },
          key.current,
        );
    for (;;) {
      if (result && !('continuation' in result)) return result;
      if (result) {
        continued.current = result.continuation;
        setProgress(result);
      }
      try {
        result = await api<NoteNode | ArxivImportProgress>('/api/import/arxiv/continue', 'POST', {
          continuation: continued.current,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 410) continued.current = null;
        throw e;
      }
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setBusy(true);
    setError('');
    try {
      let iconData;
      if (kind === 'folder') {
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
      const result = node
        ? await api<NoteNode>(`/api/nodes/${node.id}`, 'PATCH', {
            title,
            ...(kind === 'link' && !node.arxiv_id ? { url } : {}),
            revision: node.revision,
            ...(kind === 'folder' ? { icon: iconData } : {}),
          })
        : kind === 'arxiv'
          ? await importPaper()
          : await api<NoteNode>(
              '/api/nodes',
              'POST',
              {
                kind,
                title,
                parentId: parent,
                url,
                fileId: uploaded.current?.id,
                content: '',
                ...(kind === 'folder' ? { icon: iconData } : {}),
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
            {Object.entries({ ...KIND_LABELS, arxiv: 'arXiv 论文' }).map(([value, label]) => (
              <label key={value} className={kind === value ? 'selected' : ''}>
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={kind === value}
                  disabled={working || !!uploaded.current}
                  onChange={() => setKind(value as NodeKind | 'arxiv')}
                />
                <NodeIcon kind={value as NodeKind | 'arxiv'} />
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
                kind === 'arxiv' ? '留空使用论文标题' : node ? undefined : UNTITLED_NAMES[kind]
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
        {kind === 'folder' && (
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
            disabled={working || (kind === 'folder' && !!icon.emoji && !isFolderEmoji(icon.emoji))}
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
