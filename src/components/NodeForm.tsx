import { useRef, useState, type FormEvent } from 'react';
import { api, upload } from '../api';
import { importPaper } from '../arxiv-import';
import {
  UNTITLED_NAMES,
  variantOf,
  type ArxivImportProgress,
  type FileInfo,
  type NoteNode,
  type NoteVariant,
} from '../../shared/types';
import { CREATABLE_TYPES, NOTE_TYPES } from '../note-types/registry';
import { BookRoleField } from './BookRoleField';
import { Modal, NodeIcon } from './Primitives';
import { FolderIconPicker, type FolderIconValue } from './FolderIconPicker';
import { isFolderEmoji } from '../../shared/folder-icons';
import { NodePicker } from './Tree';

const commonTypes: NoteVariant[] = ['markdown', 'folder', 'journal', 'link'];
const choices = [
  ...commonTypes.map((variant) => NOTE_TYPES[variant]),
  ...CREATABLE_TYPES.filter(({ variant }) => !commonTypes.includes(variant)),
];

export function NodeForm({
  node,
  parent,
  existingFile,
  iconOnly = false,
  onClose,
  onSaved,
  onBackground,
}: {
  node?: NoteNode;
  parent: string | null;
  existingFile?: FileInfo;
  iconOnly?: boolean;
  onClose: () => void;
  onSaved: (node: NoteNode) => void;
  // Given, the form closes once its files are uploaded and the request goes on
  // in the background: `shown` is what the lists show until it is confirmed.
  onBackground?: (request: Promise<NoteNode>, shown: { fields?: Partial<NoteNode>; added?: NoteNode }) => void;
}) {
  const [kind, setKind] = useState<NoteVariant>(
    (node && variantOf(node)) ||
      (existingFile ? (existingFile.mime === 'application/pdf' ? 'pdf' : 'image') : 'markdown'),
  );
  const [title, setTitle] = useState(node?.title || existingFile?.name || ''),
    [url, setUrl] = useState(node?.url || '');
  const [moreTypes, setMoreTypes] = useState(false);
  const [reference, setReference] = useState<{ id: string; title: string } | null>(null);
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
  const folderLike = NOTE_TYPES[kind].customIcon;
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
      if (kind === 'reference' && !reference) throw new Error('请先选择要引用的文件或文件夹。');
      if (folderLike) {
        if (icon.emoji && !isFolderEmoji(icon.emoji)) throw new Error('请输入一个 Emoji。');
        if (icon.file && uploadedIcon.current?.source !== icon.file) {
          if (uploadedIcon.current)
            await api(`/api/files/${uploadedIcon.current.info.id}`, 'DELETE').catch(() => {});
          uploadedIcon.current = {
            source: icon.file,
            info: await upload(icon.file, node ? node.id : parent),
          };
        }
        iconData = {
          emoji: icon.emoji,
          fileId: icon.file ? uploadedIcon.current!.info.id : icon.fileId,
        };
      }
      if (!node && ['pdf', 'image'].includes(kind) && !uploaded.current) {
        if (!file) throw new Error('请先选择一个文件。');
        uploaded.current = await upload(file, parent);
      }
      if (kind === 'paper' && !continued.current) setProgress(null);
      // Files are up; the record itself can be saved behind the closed form.
      if (onBackground && kind !== 'paper') {
        const request = (node
          ? api<NoteNode>(`/api/nodes/${node.id}`, 'PATCH', {
              title,
              ...(kind === 'link' && !node.arxiv_id ? { url } : {}),
              revision: node.revision,
              ...(folderLike ? { icon: iconData } : {}),
            })
          : api<NoteNode>('/api/nodes', 'POST', {
              kind: NOTE_TYPES[kind].create?.kind ?? kind,
              title,
              parentId: parent,
              url,
              fileId: uploaded.current?.id,
              content: '',
              ...(kind === 'project' ? { project: true } : {}),
              ...(kind === 'journal' ? { journal: true } : {}),
              ...(kind === 'reference' ? { referenceId: reference!.id } : {}),
              ...(folderLike ? { icon: iconData } : {}),
              ...(kind === 'book' ? { book: { author, pageCount: Number(pageCount) || 0, rolePrompt: role } } : {}),
            }, key.current)
        ).then((result) => {
          if (uploadedIcon.current && uploadedIcon.current.info.id !== result.icon_blob_id)
            void api(`/api/files/${uploadedIcon.current.info.id}`, 'DELETE').catch(() => {});
          return result;
        });
        const now = Date.now();
        onBackground(
          request,
          node
            ? { fields: { title: title.trim() || node.title } }
            : {
                added: {
                  id: `pending-${key.current}`, parent_id: parent, kind: NOTE_TYPES[kind].create?.kind ?? 'markdown',
                  title: title.trim() || '正在创建…', position: Number.MAX_SAFE_INTEGER, url: null, file_blob_id: null,
                  current_version_id: null, revision: 0, trash_id: null, created_at: now, updated_at: now, child_count: 0,
                },
              },
        );
        return;
      }
      const result = node
        ? await api<NoteNode>(`/api/nodes/${node.id}`, 'PATCH', {
            title,
            ...(kind === 'link' && !node.arxiv_id ? { url } : {}),
            revision: node.revision,
            ...(folderLike ? { icon: iconData } : {}),
          })
        : kind === 'paper'
          ? await importPaper({ title, parentId: parent, url }, key.current, continued, setProgress)
          : await api<NoteNode>(
              '/api/nodes',
              'POST',
              {
                kind: NOTE_TYPES[kind].create?.kind ?? kind,
                title,
                parentId: parent,
                url,
                fileId: uploaded.current?.id,
                content: '',
                ...(kind === 'project' ? { project: true } : {}),
                ...(kind === 'journal' ? { journal: true } : {}),
                ...(kind === 'reference' ? { referenceId: reference!.id } : {}),
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
            {choices
              .filter(({ variant }) => moreTypes || commonTypes.includes(variant) || variant === kind)
              .map(({ variant: value, label }) => (
                <label key={value} className={kind === value ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="kind"
                    value={value}
                    checked={kind === value}
                    disabled={working || !!uploaded.current}
                    onChange={() => setKind(value)}
                  />
                  <NodeIcon kind={value} />
                  {label}
                </label>
              ))}
            <button type="button" className="text-button kind-more" aria-expanded={moreTypes}
              disabled={working} onClick={() => setMoreTypes((value) => !value)}>
              {moreTypes ? '收起其他类型' : '更多类型'}
            </button>
          </fieldset>
        )}
        {!iconOnly && (
          <label>
            标题
            <input
              autoFocus
              required={!!node}
              placeholder={
                kind === 'paper'
                  ? '留空使用论文标题'
                  : node
                    ? undefined
                    : kind === 'book'
                      ? '书名'
                      : kind === 'project'
                        ? '项目名称'
                        : kind === 'journal'
                          ? '日记'
                        : kind === 'reference'
                          ? reference?.title || '留空使用原文件名称'
                          : UNTITLED_NAMES[NOTE_TYPES[kind].create?.kind ?? 'markdown']
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
        {kind === 'project' && !node && (
          <p className="field-hint">
            集中管理待办、问题和笔记。
          </p>
        )}
        {kind === 'journal' && !node && (
          <p className="field-hint">
            每天一篇，按年月归档。
          </p>
        )}
        {kind === 'reference' && !node && (
          <>
            <p className="field-hint">引用不复制内容，删除引用不影响原文件。</p>
            <NodePicker
              value={reference?.id || null}
              label="选择引用内容"
              onSelect={(id, name) => {
                if (id) setReference({ id, title: name });
              }}
            />
          </>
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
            <BookRoleField
              value={role}
              onChange={setRole}
              title={title}
              author={author}
              disabled={working}
              rows={4}
            />
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
        {(kind === 'link' || kind === 'paper') && !node?.arxiv_id && (
          <label>
            {kind === 'paper' ? 'arXiv 论文地址' : '网页地址'}
            <input
              type="url"
              required
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                continued.current = null;
              }}
              placeholder={
                kind === 'paper' ? 'https://arxiv.org/html/2503.01800v1' : 'https://example.com'
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
              ? kind === 'paper'
                ? progress
                  ? `正在下载论文图片 ${progress.done}/${progress.total}…`
                  : '正在导入论文和图片…'
                : '正在保存…'
              : node
                ? '保存信息'
                : kind === 'paper'
                  ? '导入论文'
                  : '创建'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
