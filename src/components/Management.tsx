import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  Palette,
  Download,
  FolderOpen,
  HardDrive,
  History,
  LogOut,
  RotateCcw,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';
import { api, fileUrl, formatBytes, formatDate, upload } from '../api';
import {
  KIND_LABELS,
  type AuthStatus,
  type FileInfo,
  type NodeKind,
  type NoteNode,
  type StorageInfo,
  type TrashBatch,
} from '../../shared/types';
import { Empty, Modal, NodeIcon, Spinner } from './Primitives';
import { NodeMenu, NodePicker, type NodeAction } from './Tree';
import { ThemeChoices } from './ThemePicker';
import { MIN_PASSWORD_LENGTH, preparePassword } from '../../shared/password';
import { AiSettings } from './AiSettings';

export type Confirm = (
  title: string,
  message: string,
  ok?: string,
  danger?: boolean,
) => Promise<boolean>;

export function NodeForm({
  node,
  parent,
  existingFile,
  onClose,
  onSaved,
}: {
  node?: NoteNode;
  parent: string | null;
  existingFile?: FileInfo;
  onClose: () => void;
  onSaved: (node: NoteNode) => void;
}) {
  const [kind, setKind] = useState<NodeKind>(
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
  const close = () => {
    if (busy) return;
    if (uploaded.current && !existingFile)
      void api(`/api/files/${uploaded.current.id}`, 'DELETE').catch(() => {});
    onClose();
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!node && ['pdf', 'image'].includes(kind) && !uploaded.current) {
        if (!file) throw new Error('请先选择一个文件。');
        uploaded.current = await upload(file);
      }
      const result = node
        ? await api<NoteNode>(`/api/nodes/${node.id}`, 'PATCH', {
            title,
            ...(kind === 'link' ? { url } : {}),
            revision: node.revision,
          })
        : await api<NoteNode>(
            '/api/nodes',
            'POST',
            { kind, title, parentId: parent, url, fileId: uploaded.current?.id, content: '' },
            key.current,
          );
      onSaved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={node ? '修改节点信息' : existingFile ? '将附件添加到笔记树' : '新建节点'}
      onClose={close}
    >
      <form onSubmit={save} className="form-stack">
        {!node && !existingFile && (
          <fieldset className="kind-choices">
            <legend>内容类型</legend>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <label key={value} className={kind === value ? 'selected' : ''}>
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={kind === value}
                  disabled={busy || !!uploaded.current}
                  onChange={() => setKind(value as NodeKind)}
                />
                <NodeIcon kind={value as NodeKind} />
                {label}
              </label>
            ))}
          </fieldset>
        )}
        <label>
          标题
          <input
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        </label>
        {kind === 'link' && (
          <label>
            网页地址
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
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
                  : 'image/png,image/jpeg,image/gif,image/webp,image/avif'
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
          <button type="button" className="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? '正在保存…' : node ? '保存信息' : '创建'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MoveDialog({
  node,
  onClose,
  onSaved,
}: {
  node: NoteNode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [parent, setParent] = useState<string | null>(node.parent_id),
    [title, setTitle] = useState('原位置');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={`移动「${node.title}」`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <NodePicker
        value={parent}
        parentsOnly
        exclude={node.id}
        onSelect={(id, name) => {
          setParent(id);
          setTitle(name);
        }}
      />
      <p className="small muted">移动到：{title}</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || parent === node.parent_id}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/nodes/${node.id}`, 'PATCH', {
                parentId: parent,
                revision: node.revision,
              });
              onSaved();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          确认移动
        </button>
      </div>
    </Modal>
  );
}

export function NodeList({
  view,
  parent,
  refresh,
  onOpen,
  onAction,
}: {
  view?: 'favorites' | 'recent';
  parent?: string | null;
  refresh: number;
  onOpen: (node: NoteNode) => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
}) {
  const [items, setItems] = useState<NoteNode[] | null>(null),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState('');
  const query = view ? `view=${view}` : `parent=${parent || ''}`;
  useEffect(() => {
    let live = true;
    setError('');
    api<{ nodes: NoteNode[]; nextOffset: number | null }>(`/api/nodes?${query}`)
      .then((data) => {
        if (live) {
          setItems(data.nodes);
          setNext(data.nextOffset);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [query, refresh]);
  if (error) return <p className="inline-error">{error}</p>;
  if (!items) return <Spinner />;
  if (!items.length)
    return view ? (
      <Empty
        icon={view === 'favorites' ? <Star /> : <History />}
        title={view === 'favorites' ? '暂无收藏' : '暂无阅读记录'}
      >
        {view === 'favorites' ? '点击笔记旁的星标添加收藏。' : undefined}
      </Empty>
    ) : (
      <p className="children-empty">此目录还没有内容</p>
    );
  return (
    <div className="node-list">
      {items.map((node) => (
        <div className="node-list-row" key={node.id}>
          <button className="node-list-main" onClick={() => onOpen(node)}>
            <NodeIcon kind={node.kind} size={20} />
            <span>
              <strong>{node.title}</strong>
              <small>{node.kind === 'link' ? node.url : KIND_LABELS[node.kind]}</small>
            </span>
            {node.kind === 'link' ? (
              <ArrowUpRight size={16} />
            ) : (
              <time>{formatDate(node.updated_at)}</time>
            )}
          </button>
          <NodeMenu node={node} onAction={onAction} />
        </div>
      ))}
      {next !== null && (
        <button
          className="text-button load-more"
          onClick={async () => {
            try {
              const data = await api<{ nodes: NoteNode[]; nextOffset: number | null }>(
                `/api/nodes?${query}&offset=${next}`,
              );
              setItems((previous) => [...(previous || []), ...data.nodes]);
              setNext(data.nextOffset);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          加载更多
        </button>
      )}
    </div>
  );
}

export function TrashView({
  confirm,
  onChanged,
  onError,
}: {
  confirm: Confirm;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [items, setItems] = useState<TrashBatch[] | null>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ batches: TrashBatch[] }>('/api/trash')
      .then((data) => {
        if (live) setItems(data.batches);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [revision]);
  async function act(batch: TrashBatch, restore: boolean) {
    if (
      !restore &&
      !(await confirm(
        '永久删除这些内容？',
        `「${batch.title}」及其子节点，共 ${batch.node_count} 个节点将永久删除，无法恢复。`,
        '永久删除',
        true,
      ))
    )
      return;
    setBusy(batch.id);
    try {
      const result = await api<{ movedToRoot?: boolean }>(
        `/api/trash/${batch.id}${restore ? '/restore' : ''}`,
        restore ? 'POST' : 'DELETE',
        {},
      );
      if (result.movedToRoot)
        onError(new Error('已恢复到根目录：原来的上级目录已不存在或仍在回收站中。'));
      setRevision((r) => r + 1);
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="collection-page">
      <h1>回收站</h1>
      <p className="page-description">
        保留 7 天，恢复时一并还原子节点。删除后仍占用空间，清理完成后释放。
      </p>
      {!items ? (
        <Spinner />
      ) : !items.length ? (
        <Empty icon={<Trash2 />} title="回收站为空" />
      ) : (
        <div className="trash-list">
          {items.map((batch) => {
            const expired = batch.expires_at <= Date.now() || batch.purging !== 0;
            return (
              <div className="trash-row" key={batch.id}>
                <Trash2 size={20} />
                <div>
                  <strong>{batch.title}</strong>
                  <small>
                    {batch.node_count} 个节点 ·{' '}
                    {expired
                      ? '等待清理'
                      : `${Math.max(1, Math.ceil((batch.expires_at - Date.now()) / 86400_000))} 天后清理`}
                  </small>
                </div>
                <button
                  className="button"
                  disabled={expired || busy !== null}
                  onClick={() => act(batch, true)}
                >
                  <RotateCcw size={15} />
                  恢复
                </button>
                <button
                  className="icon-button danger-text"
                  aria-label={`永久删除 ${batch.title}`}
                  disabled={busy !== null}
                  onClick={() => act(batch, false)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Settings({
  storage,
  confirm,
  onChanged,
  onLogout,
  onError,
}: {
  storage: StorageInfo | null;
  confirm: Confirm;
  onChanged: () => void;
  onLogout: (all?: boolean) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [quota, setQuota] = useState(String((storage?.quotaBytes || 8e9) / 1e9)),
    [busy, setBusy] = useState(false),
    [passwordOpen, setPasswordOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState(''),
    [newPassword, setNewPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [error, setError] = useState('');
  return (
    <section className="collection-page settings-page">
      <h1>设置</h1>
      <section className="settings-section">
        <h2>
          <Palette size={19} />
          外观
        </h2>
        <ThemeChoices />
      </section>
      <AiSettings confirm={confirm} />
      <section className="settings-section">
        <h2>
          <HardDrive size={19} />
          存储空间
        </h2>
        {storage ? (
          <>
            <div className="usage-heading">
              <strong>{formatBytes(storage.allocatedBytes)}</strong>
              <span> / {formatBytes(storage.quotaBytes)}</span>
            </div>
            <progress value={storage.allocatedBytes} max={storage.quotaBytes} />
            <div className="storage-breakdown">
              {[
                ['当前内容', storage.currentBytes],
                ['历史版本', storage.historyBytes],
                ['回收站', storage.trashBytes],
                ['等待清理', storage.orphanBytes],
                ['上传预留', storage.reservedBytes],
              ].map(([label, size]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{formatBytes(Number(size))}</strong>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Spinner />
        )}
        <form
          className="quota-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/api/settings', 'PATCH', {
                quotaBytes: Math.round(Number(quota) * 1e9),
              });
              onChanged();
            } catch (e) {
              onError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            全库容量上限{' '}
            <span className="input-unit">
              <input
                aria-label="容量上限 GB"
                type="number"
                min="0.001"
                max="1000"
                step="0.001"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
              />
              <span>GB</span>
            </span>
          </label>
          <button className="button" disabled={busy}>
            更新上限
          </button>
        </form>
        <p className="field-hint">
          容量上限包含历史和回收站；Cloudflare 账号的免费额度由所有项目共享。
        </p>
        <button
          className="text-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/api/cleanup', 'POST', {});
              onChanged();
            } catch (e) {
              onError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <RotateCcw size={15} />
          立即执行一批清理
        </button>
      </section>
      <section className="settings-section">
        <h2>
          <ShieldCheck size={19} />
          密码与设备
        </h2>
        <div className="setting-row">
          <div>
            <strong>登录密码</strong>
            <p>修改后，所有设备都需要重新登录。</p>
          </div>
          <button className="button" onClick={() => setPasswordOpen(true)}>
            修改密码
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>所有设备</strong>
            <p>同时结束电脑、手机和当前页面的登录。</p>
          </div>
          <button
            className="button"
            onClick={async () => {
              if (
                await confirm(
                  '退出所有设备？',
                  '所有设备将在下次访问时要求重新输入密码，当前设备也会退出。',
                  '退出所有设备',
                )
              )
                await onLogout(true);
            }}
          >
            退出所有设备
          </button>
        </div>
        <button className="text-button" onClick={() => onLogout()}>
          <LogOut size={16} />
          退出当前设备
        </button>
      </section>
      {passwordOpen && (
        <Modal
          title="修改密码"
          onClose={() => {
            if (!busy) setPasswordOpen(false);
          }}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              if (newPassword !== repeat) {
                setError('两次输入的新密码不一致。');
                return;
              }
              setBusy(true);
              try {
                const status = await api<AuthStatus>('/api/auth/status');
                const [currentPassword, replacement] = await Promise.all([
                  preparePassword(oldPassword, status.password),
                  preparePassword(newPassword),
                ]);
                await api('/api/auth/password', 'POST', {
                  currentPassword,
                  newPassword: replacement,
                });
                window.dispatchEvent(new Event('note:unauthenticated'));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              当前密码
              <input
                type="password"
                required
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </label>
            <label>
              新密码
              <input
                aria-label="新密码"
                aria-describedby="new-password-hint"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={256}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <span id="new-password-hint" className="field-hint">
                至少 {MIN_PASSWORD_LENGTH} 个字符
              </span>
            </label>
            <label>
              再次输入新密码
              <input
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </label>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => setPasswordOpen(false)}
                disabled={busy}
              >
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? '正在修改…' : '修改并重新登录'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function Attachments({
  files,
  editing,
  onRemove,
  onPreview,
  onCreate,
}: {
  files: FileInfo[];
  editing?: boolean;
  onRemove?: (id: string) => void;
  onPreview: (file: FileInfo) => void;
  onCreate?: (file: FileInfo) => void;
}) {
  if (!files.length) return null;
  return (
    <section className="attachments">
      <h3>
        附件 <span>{files.length}</span>
      </h3>
      {files.map((file) => (
        <div key={file.id} className="attachment-row">
          <button className="attachment-name" onClick={() => onPreview(file)}>
            <NodeIcon
              kind={
                file.mime === 'application/pdf'
                  ? 'pdf'
                  : file.mime.startsWith('image/')
                    ? 'image'
                    : 'text'
              }
            />
            <span>
              {file.name}
              <small>{formatBytes(file.size)}</small>
            </span>
          </button>
          {onCreate && (file.mime === 'application/pdf' || file.mime.startsWith('image/')) && (
            <button
              className="icon-button"
              aria-label={`将 ${file.name} 添加到笔记树`}
              onClick={() => onCreate(file)}
            >
              <FolderOpen size={16} />
            </button>
          )}
          <a
            className="icon-button"
            aria-label={`下载 ${file.name}`}
            href={fileUrl(file.id, true)}
          >
            <Download size={16} />
          </a>
          {editing && (
            <button
              className="icon-button danger-text"
              aria-label={`移除 ${file.name}`}
              onClick={() => onRemove?.(file.id)}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
