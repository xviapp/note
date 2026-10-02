import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BookOpen,
  Clock3,
  FolderOpen,
  Menu,
  Plus,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { api, formatBytes, lockEdits } from './api';
import {
  PARENT_KINDS,
  type AuthStatus,
  type FileInfo,
  type NoteDetail,
  type NoteNode,
  type StorageInfo,
} from '../shared/types';
import { Spinner, useQuestion } from './components/Primitives';
import { Tree, type NodeAction } from './components/Tree';
import { MoveDialog, NodeForm, NodeList, Settings, TrashView } from './components/Management';
import NotePane from './components/NotePane';
import { ThemeSwitcher } from './components/ThemePicker';
import { MIN_PASSWORD_LENGTH, preparePassword } from '../shared/password';
import { openLink } from './open-link';
import { dismissReadingOverlay } from './mobile-back';

type View = 'tree' | 'favorites' | 'recent' | 'trash' | 'settings';
const routeId = () => window.location.pathname.match(/^\/n\/([a-zA-Z0-9_-]+)$/)?.[1] || null;

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null),
    [error, setError] = useState('');
  const [setupToken] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('setup') || '';
    if (value) history.replaceState(null, '', window.location.pathname);
    return value;
  });
  const refresh = useCallback(async () => {
    try {
      const state = await api<AuthStatus>('/api/auth/status');
      if (!state.authenticated) lockEdits();
      setStatus(state);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => {
      lockEdits();
      setStatus((previous) => (previous ? { ...previous, authenticated: false } : null));
      void refresh();
    };
    const focus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('note:unauthenticated', expired);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.removeEventListener('note:unauthenticated', expired);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [refresh]);
  if (!status)
    return (
      <div className="boot-screen">
        <Brand />
        {error ? (
          <>
            <p className="inline-error" role="alert">
              {error}
            </p>
            <button className="button" onClick={refresh}>
              重新连接
            </button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    );
  return status.authenticated ? (
    <Notebook name={status.name} onLogout={refresh} />
  ) : (
    <AuthScreen status={status} token={setupToken} onSuccess={refresh} />
  );
}
function Brand({ name = '页间' }: { name?: string }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <BookOpen size={22} strokeWidth={1.6} />
      </span>
      <span>{name}</span>
    </div>
  );
}
function AuthScreen({
  status,
  token,
  onSuccess,
}: {
  status: AuthStatus;
  token: string;
  onSuccess: () => Promise<void>;
}) {
  const setup = !status.initialized;
  const [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [forgot, setForgot] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (setup && password !== repeat) {
      setError('两次输入的密码不一致。');
      return;
    }
    setBusy(true);
    try {
      const current = await api<AuthStatus>('/api/auth/status');
      await api(`/api/auth/${setup ? 'setup' : 'login'}`, 'POST', {
        password: await preparePassword(password, setup ? undefined : current.password),
        ...(setup ? { token } : {}),
      });
      setPassword('');
      setRepeat('');
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-screen">
      <div className="auth-theme">
        <ThemeSwitcher />
      </div>
      <div className="auth-form-area">
        <form onSubmit={submit} className="auth-form">
          <Brand name={status.name} />
          <h1>{setup ? '设置密码' : '登录'}</h1>
          {setup && !token ? (
            <p className="inline-error">请使用部署时生成的专属设置链接，完成第一次密码设置。</p>
          ) : (
            <>
              <label>
                {setup ? '设置密码' : '密码'}
                <input
                  autoFocus
                  type="password"
                  autoComplete={setup ? 'new-password' : 'current-password'}
                  required
                  minLength={setup ? MIN_PASSWORD_LENGTH : undefined}
                  maxLength={256}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={setup ? `至少 ${MIN_PASSWORD_LENGTH} 个字符` : undefined}
                  disabled={busy}
                />
              </label>
              {setup && (
                <label>
                  确认密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={256}
                    required
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              <button className="button primary auth-submit" disabled={busy}>
                {busy ? '正在验证…' : setup ? '创建笔记库' : '打开笔记库'}
              </button>
            </>
          )}
          {!setup && (
            <button
              type="button"
              className="text-button forgot-button"
              onClick={() => setForgot((value) => !value)}
            >
              忘记密码？
            </button>
          )}
          {forgot && (
            <p className="field-hint">
              在部署端重置密码，使用新的设置链接登录。笔记和文件会保留。
            </p>
          )}
        </form>
      </div>
    </main>
  );
}

function Notebook({ name, onLogout }: { name: string; onLogout: () => Promise<void> }) {
  const [view, setView] = useState<View>('tree'),
    [selected, setSelected] = useState<string | null>(routeId);
  const [loaded, setLoaded] = useState<NoteDetail | null>(null),
    [mobileOpen, setMobileOpen] = useState(false);
  const [revision, setRevision] = useState(0),
    [detailRevision, setDetailRevision] = useState(0),
    [storage, setStorage] = useState<StorageInfo | null>(null),
    [notice, setNotice] = useState('');
  const [form, setForm] = useState<{
      node?: NoteNode;
      parent: string | null;
      file?: FileInfo;
    } | null>(null),
    [moving, setMoving] = useState<NoteNode | null>(null);
  const leaveGuard = useRef<() => Promise<boolean>>(async () => true),
    question = useQuestion();
  const report = useCallback(
    (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    [],
  );
  const changed = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(() => {
    let live = true;
    api<StorageInfo>('/api/storage')
      .then((data) => {
        if (live) setStorage(data);
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [revision, report]);
  const setRoute = (id: string | null, replace = false) => {
    const path = id ? `/n/${id}` : '/';
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setSelected(id);
    setView('tree');
    setMobileOpen(false);
    setLoaded(null);
  };
  const navigate = async (id: string) => {
    if (id === selected && view === 'tree') {
      setMobileOpen(false);
      return;
    }
    if (await leaveGuard.current()) setRoute(id || null);
  };
  const openNode = (node: NoteNode) => {
    if (node.kind === 'link' && !node.arxiv_id && node.url) {
      openLink(node.url);
      void api(`/api/nodes/${node.id}/open`, 'POST', {}).then(changed).catch(report);
      setMobileOpen(false);
      return;
    }
    void navigate(node.id);
  };
  const switchView = async (next: View) => {
    if (!(await leaveGuard.current())) return;
    setView(next);
    setSelected(null);
    setLoaded(null);
    history.pushState(null, '', '/');
    setMobileOpen(false);
    changed();
  };
  useEffect(() => {
    const pop = async () => {
      const target = routeId();
      if (await leaveGuard.current()) {
        setSelected(target);
        setView('tree');
        setMobileOpen(false);
        setLoaded(null);
      } else history.pushState(null, '', selected ? `/n/${selected}` : '/');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [selected]);
  useEffect(() => {
    const back = (event: Event) => {
      if (dismissReadingOverlay()) event.preventDefault();
      else if (mobileOpen) {
        event.preventDefault();
        setMobileOpen(false);
      } else if ((event as CustomEvent<{ canGoBack: boolean }>).detail?.canGoBack) {
        event.preventDefault();
        history.back();
      } else if (selected || view !== 'tree') {
        event.preventDefault();
        void navigate('');
      }
    };
    window.addEventListener('note:native-back', back);
    return () => window.removeEventListener('note:native-back', back);
  }, [selected, view, mobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [mobileOpen]);
  useEffect(() => {
    const openMenus = () =>
      document.querySelectorAll<HTMLDetailsElement>('details.node-menu[open]');
    const dismissOutside = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      for (const menu of openMenus()) {
        if (!menu.contains(event.target)) menu.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const menus = openMenus();
      if (!menus.length) return;
      event.preventDefault();
      event.stopPropagation();
      for (const menu of menus) menu.open = false;
      menus[0].querySelector('summary')?.focus();
    };
    document.addEventListener('click', dismissOutside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('click', dismissOutside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  const action = async (kind: NodeAction, node: NoteNode) => {
    document
      .querySelectorAll<HTMLDetailsElement>('details.node-menu[open]')
      .forEach((element) => {
        element.open = false;
      });
    if (!(await leaveGuard.current())) return;
    if (kind === 'new') {
      setForm({ parent: node.id });
      return;
    }
    try {
      const fresh = await api<NoteDetail>(`/api/nodes/${node.id}`);
      if (kind === 'rename') setForm({ node: fresh, parent: fresh.parent_id });
      else if (kind === 'move') setMoving(fresh);
      else {
        const preview = await api<{ count: number; title: string }>(
          `/api/nodes/${node.id}/delete-preview`,
        );
        if (
          !(await question.confirm(
            '移到回收站？',
            `「${preview.title}」${preview.count > 1 ? `及其子节点，共 ${preview.count} 个节点` : ''}将保留 7 天，到期后清理。`,
            '移到回收站',
            true,
          ))
        )
          return;
        await api(`/api/nodes/${node.id}`, 'DELETE', { count: preview.count });
        if (selected === node.id || loaded?.breadcrumbs.some((part) => part.id === node.id))
          setRoute(null);
        changed();
      }
    } catch (e) {
      report(e);
    }
  };
  const drop = async (id: string, parent: string | null) => {
    if (!id || id === parent || !(await leaveGuard.current())) return;
    try {
      const node = await api<NoteNode>(`/api/nodes/${id}`);
      await api(`/api/nodes/${id}`, 'PATCH', { parentId: parent, revision: node.revision });
      changed();
      setDetailRevision((r) => r + 1);
    } catch (e) {
      report(e);
    }
  };
  const newNode = async () => {
    if (!(await leaveGuard.current())) return;
    setForm({ parent: loaded && PARENT_KINDS.includes(loaded.kind) ? loaded.id : null });
  };
  const logout = async (all = false) => {
    if (!(await leaveGuard.current())) return;
    try {
      await api(`/api/auth/${all ? 'logout-all' : 'logout'}`, 'POST', {});
      lockEdits();
      await onLogout();
    } catch (e) {
      report(e);
    }
  };
  const navItems = [
    { key: 'tree' as const, label: '全部笔记', icon: FolderOpen },
    { key: 'favorites' as const, label: '收藏', icon: Star },
    { key: 'recent' as const, label: '最近访问', icon: Clock3 },
  ];
  return (
    <div className={`app-shell ${mobileOpen ? 'sidebar-open' : ''}`}>
      <button
        className="sidebar-scrim"
        aria-label="关闭笔记目录"
        onClick={() => setMobileOpen(false)}
      />
      <aside id="notebook-sidebar" className="sidebar" aria-label="主导航">
        <div className="sidebar-brand">
          <Brand name={name} />
          <button
            className="icon-button close-sidebar"
            aria-label="关闭侧栏"
            onClick={() => setMobileOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <button className="new-note-button" onClick={newNode}>
          <Plus size={18} />
          新建笔记
        </button>
        <nav className="main-nav">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={view === item.key ? 'active' : ''}
              onClick={() => switchView(item.key)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-tree">
          <Tree
            refresh={revision}
            selected={selected}
            onOpen={openNode}
            onAction={action}
            onDrop={drop}
            onError={report}
          />
        </div>
        <div className="sidebar-bottom">
          <nav className="main-nav">
            <button
              className={view === 'trash' ? 'active' : ''}
              onClick={() => switchView('trash')}
            >
              <Trash2 size={17} />
              回收站
            </button>
            <button
              className={view === 'settings' ? 'active' : ''}
              onClick={() => switchView('settings')}
            >
              <Settings2 size={17} />
              设置
            </button>
          </nav>
          <ThemeSwitcher showLabel />
          {storage && (
            <button
              className={`sidebar-usage ${storage.allocatedBytes >= storage.quotaBytes * 0.8 ? 'warning' : ''}`}
              onClick={() => switchView('settings')}
            >
              <span>
                <span>存储空间</span>
                <span>
                  {formatBytes(storage.allocatedBytes)} / {formatBytes(storage.quotaBytes)}
                </span>
              </span>
              <progress value={storage.allocatedBytes} max={storage.quotaBytes} />
            </button>
          )}
        </div>
      </aside>
      <main className="main-area">
        {!(view === 'tree' && selected) && (
          <header className="app-header">
            <div className="header-location">
              <button
                className="icon-button mobile-menu"
                aria-label="打开笔记目录"
                aria-controls="notebook-sidebar"
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={21} />
              </button>
              <span className="header-title">
                {view === 'tree'
                  ? '我的笔记库'
                  : view === 'favorites'
                    ? '收藏'
                    : view === 'recent'
                      ? '最近访问'
                      : view === 'trash'
                        ? '回收站'
                        : '设置'}
              </span>
            </div>
          </header>
        )}
        {notice && (
          <div className="notice" role="alert">
            <span>{notice}</span>
            <button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {storage && storage.allocatedBytes >= storage.quotaBytes * 0.8 && (
          <div className="capacity-warning">
            空间已使用 {Math.round((storage.allocatedBytes / storage.quotaBytes) * 100)}
            %。可在设置中查看历史和回收站占用。
            <button className="text-button" onClick={() => switchView('settings')}>
              管理空间
            </button>
          </div>
        )}
        <div className="main-content">
          {view === 'tree' ? (
            selected ? (
              <NotePane
                key={selected}
                id={selected}
                refresh={detailRevision}
                treeRefresh={revision}
                sidebarOpen={mobileOpen}
                onOpenSidebar={() => setMobileOpen(true)}
                onNavigate={navigate}
                onOpen={openNode}
                onAction={action}
                onChanged={changed}
                onLoaded={setLoaded}
                onFileNode={async (file, parent) => {
                  if (await leaveGuard.current()) setForm({ file, parent });
                }}
                setLeaveGuard={(guard) => {
                  leaveGuard.current = guard;
                }}
                onError={report}
                onTrash={() => switchView('trash')}
                onSettings={() => switchView('settings')}
              />
            ) : (
              <section className="collection-page library-home">
                <div className="collection-title">
                  <h1>全部笔记</h1>
                  <button className="button" onClick={newNode}>
                    <Plus size={16} />
                    新建
                  </button>
                </div>
                <NodeList
                  parent={null}
                  refresh={revision}
                  onOpen={openNode}
                  onAction={action}
                />
              </section>
            )
          ) : view === 'favorites' || view === 'recent' ? (
            <section className="collection-page">
              <h1>{view === 'favorites' ? '收藏' : '最近访问'}</h1>
              <NodeList view={view} refresh={revision} onOpen={openNode} onAction={action} />
            </section>
          ) : view === 'trash' ? (
            <TrashView confirm={question.confirm} onChanged={changed} onError={report} />
          ) : (
            <Settings
              storage={storage}
              confirm={question.confirm}
              onChanged={changed}
              onLogout={logout}
              onError={report}
            />
          )}
        </div>
      </main>
      {form && (
        <NodeForm
          node={form.node}
          parent={form.parent}
          existingFile={form.file}
          onClose={() => setForm(null)}
          onSaved={(node) => {
            setForm(null);
            changed();
            if (selected === node.id) setDetailRevision((r) => r + 1);
            else setRoute(node.id);
          }}
        />
      )}{' '}
      {moving && (
        <MoveDialog
          node={moving}
          onClose={() => setMoving(null)}
          onSaved={() => {
            setMoving(null);
            changed();
            setDetailRevision((r) => r + 1);
          }}
        />
      )}{' '}
      {question.dialog}
    </div>
  );
}
