import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, FolderOpen, Globe } from 'lucide-react';
import { BLOG_DESCRIPTION_LIMIT, BLOG_TITLE_LIMIT } from '../../shared/blog';
import type { BlogPostInfo, BlogSettings as Settings } from '../../shared/types';
import { api } from '../api';
import { blogFolderChanged } from './BlogPublish';
import { Modal, Spinner, type Confirm } from './Primitives';
import { NodePicker } from './Tree';

const folderLabel = (path: { title: string }[]) => path.map((item) => item.title).join(' / ');

export function BlogSettings({ confirm, onNavigate }: { confirm: Confirm; onNavigate: (id: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [posts, setPosts] = useState<BlogPostInfo[]>([]);
  const [form, setForm] = useState({ title: '', description: '', url: '' });
  const [folder, setFolder] = useState<{ parentId: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const accept = (value: Settings) => {
    setSettings(value);
    setForm({ title: value.title, description: value.description, url: value.url ?? '' });
  };
  useEffect(() => {
    let live = true;
    Promise.all([api<Settings>('/api/blog/settings'), api<{ posts: BlogPostInfo[] }>('/api/blog/posts')])
      .then(([value, list]) => {
        if (!live) return;
        accept(value);
        setPosts(list.posts);
      })
      .catch((reason: Error) => live && setError(reason.message));
    return () => {
      live = false;
    };
  }, []);
  const save = async (parentId: string | null) => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      accept(await api<Settings>('/api/blog/settings', 'PUT', { parentId, ...form }));
      blogFolderChanged();
      // Changing the folder can take posts online or offline.
      setPosts((await api<{ posts: BlogPostInfo[] }>('/api/blog/posts')).posts);
      setFolder(null);
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (
      await confirm(
        '关闭博客',
        '所有已发布的文章会立刻从博客上消失。发布记录会保留，重新选择目录后可恢复。',
        '关闭博客',
        true,
      )
    )
      await save(null);
  };
  if (!settings)
    return (
      <section className="settings-section">
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : (
          <Spinner />
        )}
      </section>
    );
  return (
    <section className="settings-section blog-settings">
      <h2>
        <Globe size={19} />
        博客
      </h2>
      <div className="share-setting-row">
        <div>
          <span className="small muted">博客目录</span>
          <p className="destination-summary">
            <FolderOpen size={17} />
            <span>{settings.parentId ? folderLabel(settings.breadcrumbs) : '未开启'}</span>
          </p>
        </div>
        <button
          className="button"
          onClick={() =>
            setFolder({
              parentId: settings.parentId ?? '',
              title: settings.parentId ? folderLabel(settings.breadcrumbs) : '请选择文件夹',
            })
          }
        >
          {settings.parentId ? '更改目录' : '选择目录'}
        </button>
        {settings.parentId && (
          <button className="button" disabled={busy} onClick={() => void close()}>
            关闭博客
          </button>
        )}
      </div>
      <p className="field-hint">选好目录不会公开任何内容；只有在笔记菜单里点了“发布到博客”的文章才对外可见。加密的笔记不能发布。</p>
      <form
        className="form-stack blog-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void save(settings.parentId);
        }}
      >
        <fieldset disabled={busy}>
          <label>
            博客名称
            <input
              value={form.title}
              required
              maxLength={BLOG_TITLE_LIMIT}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label>
            简介
            <textarea
              value={form.description}
              rows={2}
              maxLength={BLOG_DESCRIPTION_LIMIT}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>
          <label>
            博客地址
            <input
              type="url"
              inputMode="url"
              placeholder="https://blog.example.com"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
            />
          </label>
          <p className="field-hint">仅用于在这里打开文章。绑定域名的方法见部署文档。</p>
          {error && !folder && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {saved && <p className="field-hint" role="status">已保存</p>}
          <div className="dialog-actions">
            <button type="submit" className="button primary">
              {busy ? '正在保存…' : '保存'}
            </button>
          </div>
        </fieldset>
      </form>
      <h3 className="blog-posts-heading">已发布的文章（{posts.length}）</h3>
      {posts.length ? (
        <ul className="blog-posts">
          {posts.map((post) => (
            <li key={post.nodeId}>
              <button className="text-button" onClick={() => onNavigate(post.nodeId)}>
                {post.title}
              </button>
              <span className="small muted">
                {!post.online ? '未显示（已移出博客目录）' : post.outdated ? '有未发布的修改' : '已是当前版本'}
              </span>
              {post.url && post.online && (
                <a className="icon-button" href={post.url} target="_blank" rel="noopener noreferrer" aria-label={`打开《${post.title}》`}>
                  <ExternalLink size={16} />
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">还没有发布文章。</p>
      )}
      {folder && (
        <Modal title="博客目录" onClose={() => !busy && setFolder(null)}>
          <fieldset disabled={busy}>
            <NodePicker
              parentsOnly
              value={folder.parentId || null}
              initialPath={settings.breadcrumbs}
              onSelect={(parentId, title) => parentId && setFolder({ parentId, title })}
            />
          </fieldset>
          <p className="destination-summary">
            <FolderOpen size={17} />
            <span>{folder.title}</span>
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button" disabled={busy} onClick={() => setFolder(null)}>
              取消
            </button>
            <button className="button primary" disabled={busy || !folder.parentId} onClick={() => void save(folder.parentId)}>
              {busy ? '正在保存…' : '使用这个目录'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
