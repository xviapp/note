import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderOpen, Plus, RefreshCw } from 'lucide-react';
import { api, lockNote, unlockNote } from '../api';
import type { NoteDetail, NoteNode } from '../../shared/types';
import {
  PROJECT_CATEGORIES,
  PROJECT_LABELS,
  PROJECT_STATUSES,
  type ProjectCategory,
  type ProjectItem,
  type ProjectOverview,
} from '../../shared/projects';
import { Modal, NodeIcon, Spinner } from './Primitives';

export function ProjectPanel({
  id,
  refresh,
  offline,
  onChanged,
  onNavigate,
}: {
  id: string;
  refresh: number;
  offline: boolean;
  onChanged: () => void;
  onNavigate: (id: string) => void;
}) {
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [category, setCategory] = useState<ProjectCategory>('todo');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [unfinished, setUnfinished] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    api<ProjectOverview>(`/api/nodes/${id}/project`)
      .then((result) => {
        if (live) {
          setOverview(result);
          if (result.indexing > 0) timer = setTimeout(() => setRetry((value) => value + 1), 500);
        }
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, refresh, retry]);
  const changeStatus = async (item: ProjectItem, status: string) => {
    setPending(item.id);
    setError('');
    try {
      // Choosing a state explicitly authorizes this small body edit. The server
      // still checks the per-file edit token, revision and project membership.
      await unlockNote(item.id);
      await api(`/api/nodes/${item.id}/project-status`, 'PUT', {
        projectId: id,
        category: item.category,
        status,
        revision: item.revision,
      });
      onChanged();
      setRetry((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setRetry((value) => value + 1);
    } finally {
      lockNote(item.id);
      setPending(null);
    }
  };
  const items = overview?.items.filter((item) => item.category === category) ?? [];
  const visible = unfinished
    ? items.filter((item) => item.status !== 'done' && item.status !== 'closed')
    : items;
  const todos = overview?.items.filter((item) => item.category === 'todo') ?? [];
  const completed = todos.filter((item) => item.status === 'done').length;
  const percent = todos.length ? Math.round((completed / todos.length) * 100) : 0;
  const directory = overview?.directories.find((item) => item.category === category);
  return (
    <section className="project-panel" aria-label="项目概览" aria-busy={loading}>
      <div className="project-summary">
        <p>
          待办已完成{' '}
          <strong>
            {completed}/{todos.length}
          </strong>
        </p>
        <progress aria-label="待办完成进度" max={100} value={percent} />
        <button
          className="icon-button"
          aria-label="刷新项目"
          disabled={loading}
          onClick={() => {
            setError('');
            setRetry((value) => value + 1);
          }}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <div className="project-tabs" role="tablist" aria-label="项目分类">
        {PROJECT_CATEGORIES.map((value) => (
          <button
            key={value}
            role="tab"
            id={`project-tab-${value}`}
            aria-selected={category === value}
            aria-controls="project-items"
            tabIndex={category === value ? 0 : -1}
            className={category === value ? 'active' : ''}
            onKeyDown={(event) => {
              const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!offset && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const index =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 2
                    : (PROJECT_CATEGORIES.indexOf(value) + offset + 3) % 3;
              const next = PROJECT_CATEGORIES[index];
              setCategory(next);
              setUnfinished(false);
              document.getElementById(`project-tab-${next}`)?.focus();
            }}
            onClick={() => {
              setCategory(value);
              setUnfinished(false);
            }}
          >
            <NodeIcon kind={value} size={19} />
            <span>{PROJECT_LABELS[value]}</span>
            <span className="project-count">
              {overview?.items.filter((item) => item.category === value).length ?? 0}
            </span>
          </button>
        ))}
      </div>
      <div className="project-controls">
        <button
          className="button compact primary"
          disabled={offline || loading}
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          新建{PROJECT_LABELS[category]}
        </button>
        {directory && (
          <button className="text-button" onClick={() => onNavigate(directory.id)}>
            <FolderOpen size={16} />
            打开目录
          </button>
        )}
        {category !== 'note' && (
          <label className="project-filter">
            <input
              type="checkbox"
              checked={unfinished}
              onChange={(event) => setUnfinished(event.target.checked)}
            />
            {category === 'todo' ? '只看未完成' : '只看未关闭'}
          </label>
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!!overview?.indexing && (
        <p className="project-empty" role="status">
          正在读取剩余 {overview.indexing} 篇文件的标题和状态…
        </p>
      )}
      {overview?.warnings.map((warning) => (
        <p className="project-warning" role="status" key={warning}>
          {warning}
        </p>
      ))}
      <div id="project-items" role="tabpanel" aria-labelledby={`project-tab-${category}`}>
        {!overview && loading ? (
          <Spinner />
        ) : visible.length ? (
          <div className="project-items">
            {visible.map((item) => {
              const states = PROJECT_STATUSES[item.category];
              const known = item.status !== null && Object.hasOwn(states, item.status);
              return (
                <div
                  className={`project-item${item.status === 'done' || item.status === 'closed' ? ' is-complete' : ''}`}
                  key={item.id}
                >
                  <button className="project-item-main" onClick={() => onNavigate(item.id)}>
                    <NodeIcon kind={item.category} size={20} />
                    <span>
                      <strong>{item.title}</strong>
                      {item.summary && <small>{item.summary}</small>}
                    </span>
                  </button>
                  {item.category !== 'note' && (
                    <select
                      aria-label={`${item.title}的状态`}
                      value={known ? item.status! : ''}
                      disabled={offline || loading || !!overview?.indexing || pending !== null}
                      onChange={(event) => void changeStatus(item, event.target.value)}
                    >
                      {!known && (
                        <option value="" disabled>
                          {item.status ? `待调整：${item.status}` : '未设置'}
                        </option>
                      )}
                      {Object.entries(states).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          overview && (
            <p className="project-empty">
              {unfinished
                ? category === 'todo'
                  ? '所有待办均已完成。'
                  : '所有问题均已关闭。'
                : `暂无${PROJECT_LABELS[category]}。新建一条，或在 ${category} 目录中添加 Markdown 文件或引用。`}
            </p>
          )
        )}
      </div>
      {creating && (
        <ProjectItemForm
          id={id}
          category={category}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            onChanged();
            setRetry((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}

function ProjectItemForm({
  id,
  category,
  onClose,
  onSaved,
}: {
  id: string;
  category: ProjectCategory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(
        `/api/nodes/${id}/project/items`,
        'POST',
        { category, title, content },
        key.current,
      );
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`新建${PROJECT_LABELS[category]}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack" onSubmit={save}>
        <label>
          标题
          <input
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          说明（可选）
          <textarea
            rows={5}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={busy}
          />
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? '正在创建…' : '创建'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ReferencePanel({
  note,
  onOpen,
}: {
  note: NoteDetail;
  onOpen: (node: NoteNode) => void;
}) {
  const target = note.reference?.target;
  return (
    <section className="reference-panel" aria-label="引用内容">
      {target ? (
        <>
          <p>引用「{target.title}」，打开后阅读和修改原内容。</p>
          <button className="button" onClick={() => onOpen(target)}>
            <NodeIcon node={target} />
            打开原{target.kind === 'folder' ? '目录' : '文件'}
          </button>
        </>
      ) : (
        <p role="status">引用的内容已删除或在回收站中。恢复原内容后可以重新打开。</p>
      )}
    </section>
  );
}
