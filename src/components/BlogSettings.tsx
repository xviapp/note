import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, FolderOpen, Globe } from 'lucide-react';
import {
  BLOG_DESCRIPTION_LIMIT,
  BLOG_PAGES,
  BLOG_THEMES,
  BLOG_TITLE_LIMIT,
  type BlogPageKey,
  DEFAULT_BLOG_HOME,
  DEFAULT_BLOG_THEME,
} from '../../shared/blog';
import type { BlogCandidate, BlogPostInfo, BlogSettings as Settings } from '../../shared/types';
import { api } from '../api';
import { blogFolderChanged } from './BlogPublish';
import { Modal, Spinner, type Confirm } from './Primitives';
import { NodePicker } from './Tree';

const folderLabel = (path: { title: string }[]) => path.map((item) => item.title).join(' / ');
type Folder = { id: string; title: string };
// What each section shows: a folder ID for the lists, a note ID for the pages.
const sectionValues = (value: Settings): Record<string, string> => ({
  ...value.pages,
  ...(value.articlesFolderId ? { articles: value.articlesFolderId } : {}),
  ...(value.projectsFolderId ? { projects: value.projectsFolderId } : {}),
});

export function BlogSettings({ confirm, onNavigate }: { confirm: Confirm; onNavigate: (id: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [posts, setPosts] = useState<BlogPostInfo[]>([]);
  const [candidates, setCandidates] = useState<BlogCandidate[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [home, setHome] = useState<BlogPageKey>(DEFAULT_BLOG_HOME);
  const [form, setForm] = useState({ title: '', description: '', url: '', theme: DEFAULT_BLOG_THEME as string });
  const [pages, setPages] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState<{ parentId: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const accept = (value: Settings) => {
    setSettings(value);
    setForm({ title: value.title, description: value.description, url: value.url ?? '', theme: value.theme });
    setPages(sectionValues(value));
    setHome(value.home);
  };
  const lists = () =>
    Promise.all([
      api<{ posts: BlogPostInfo[] }>('/api/blog/posts'),
      api<{ notes: BlogCandidate[]; folders: Folder[] }>('/api/blog/candidates'),
    ]);
  useEffect(() => {
    let live = true;
    Promise.all([api<Settings>('/api/blog/settings'), lists()])
      .then(([value, [list, notes]]) => {
        if (!live) return;
        accept(value);
        setPosts(list.posts);
        setCandidates(notes.notes);
        setFolders(notes.folders);
      })
      .catch((reason: Error) => live && setError(reason.message));
    return () => {
      live = false;
    };
  }, []);
  // Only what changed, so a page whose note left the folder stays as it is.
  const changedPages = (): Record<string, string | null> => {
    if (!settings) return {};
    const before = sectionValues(settings);
    return Object.fromEntries(
      BLOG_PAGES.filter(({ key, kind }) => kind === 'note' && (pages[key] ?? '') !== (before[key] ?? '')).map(({ key }) => [
        key,
        pages[key] || null,
      ]),
    );
  };
  // Home can only be a section that shows something.
  const chosen = BLOG_PAGES.filter(({ key }) => pages[key]).map(({ key }) => key);
  const homeValue = chosen.includes(home) ? home : (chosen[0] ?? DEFAULT_BLOG_HOME);
  // Folders too only when changed: one that left the blog would be refused.
  const sections = () => {
    const before = settings ? sectionValues(settings) : {};
    const changed = (key: string) => (pages[key] ?? '') !== (before[key] ?? '');
    return {
      pages: changedPages(),
      ...(changed('articles') ? { articlesFolderId: pages.articles || null } : {}),
      ...(changed('projects') ? { projectsFolderId: pages.projects || null } : {}),
      home: homeValue,
    };
  };
  const save = async (parentId: string | null, withPages = false) => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      accept(await api<Settings>('/api/blog/settings', 'PUT', { parentId, ...form, ...(withPages ? sections() : {}) }));
      blogFolderChanged();
      // Changing the folder can take posts online or offline.
      const [list, notes] = await lists();
      setPosts(list.posts);
      setCandidates(notes.notes);
      setFolders(notes.folders);
      setFolder(null);
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Choosing a note that was never published is what makes it public.
  const submit = async () => {
    const fresh = Object.values(changedPages()).filter((id) => id && !posts.some((post) => post.nodeId === id));
    if (fresh.length && !(await confirm('公开笔记', `选中的 ${fresh.length} 篇笔记还没有发布，保存后当前版本会公开。`, '保存并公开')))
      return;
    await save(settings?.parentId ?? null, true);
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
          void submit();
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
          <div className="blog-field">
            <span id="blog-theme-label">主题</span>
            <div className="blog-themes" role="radiogroup" aria-labelledby="blog-theme-label">
              {BLOG_THEMES.map((theme) => (
                <label key={theme.value} className="blog-theme">
                  <input
                    type="radio"
                    name="blog-theme"
                    value={theme.value}
                    checked={form.theme === theme.value}
                    onChange={() => setForm({ ...form, theme: theme.value })}
                  />
                  <span className="blog-theme-swatch" style={{ background: theme.colors[0] }} aria-hidden="true">
                    <i style={{ background: theme.colors[1] }} />
                    <i style={{ background: theme.colors[2] }} />
                  </span>
                  <span>{theme.label}</span>
                </label>
              ))}
            </div>
          </div>
          {settings.parentId && (
            <div className="blog-field">
              <span>页面</span>
              <div className="blog-pages">
                {BLOG_PAGES.map((page) => {
                  const current = pages[page.key] ?? '';
                  const folder = page.kind === 'folder';
                  // A note or folder that left the blog keeps its place until replaced.
                  const stale =
                    current && (folder ? !folders.some((item) => item.id === current) : !candidates.some((note) => note.id === current));
                  return (
                    <label key={page.key}>
                      {page.label}
                      <select value={current} onChange={(event) => setPages({ ...pages, [page.key]: event.target.value })}>
                        <option value="">不显示</option>
                        {stale && (
                          <option value={current}>
                            {folder ? '原文件夹' : (posts.find((post) => post.nodeId === current)?.title ?? '未知笔记')}
                            （已不在博客目录）
                          </option>
                        )}
                        {folder
                          ? folders.map((item) => (
                              <option key={item.id} value={item.id} disabled={Object.values(pages).includes(item.id) && current !== item.id}>
                                {item.title}
                              </option>
                            ))
                          : candidates.map((note) => (
                              <option key={note.id} value={note.id}>
                                {note.category ? `${note.category} / ` : ''}
                                {note.title}
                              </option>
                            ))}
                      </select>
                    </label>
                  );
                })}
                <label>
                  首页
                  <select value={homeValue} disabled={!chosen.length} onChange={(event) => setHome(event.target.value as BlogPageKey)}>
                    {(chosen.length ? chosen : [DEFAULT_BLOG_HOME]).map((key) => (
                      <option key={key} value={key}>
                        {BLOG_PAGES.find((page) => page.key === key)!.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="field-hint">文章和项目列出所选文件夹里已发布的笔记；不在这两个文件夹里、也没有选作页面的文章不会显示。</p>
            </div>
          )}
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
                {post.page ? `${BLOG_PAGES.find((page) => page.key === post.page)?.label ?? ''}页面 · ` : ''}
                {!post.online ? '未显示（不在文章或项目目录）' : post.outdated ? '有未发布的修改' : '已是当前版本'}
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
