import { AssistantPanel, type AssistantHandle } from './components/AssistantPanel';
import type { AssistantMode } from './components/AssistantWindow';
import { usePullRefresh } from './use-pull-refresh';
import { Capacitor } from '@capacitor/core';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Clock3,
  FolderOpen,
  HardDriveDownload,
  Menu,
  Plus,
  Settings2,
  Star,
  Trash2,
  WifiOff,
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
import { isOffline, useOffline } from './connectivity';
import { OfflineLibrary } from './components/OfflineCache';
import { cacheEpoch, cacheSnapshot, initializeCache } from './offline-cache';
import { ShareImport } from './components/ShareImport';
import { Brand } from './components/Brand';
import { ListingPagesContext } from './use-node-listing';
import {
  settingsTitles,
  useNotebookNavigation,
  type SettingsSection,
  type View,
} from './navigation';

const ImageViewer = lazy(() => import('./components/ImageViewer'));

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null),
    [error, setError] = useState('');
  const [setupToken] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('setup') || '';
    if (value) history.replaceState(null, '', window.location.pathname);
    return value;
  });
  const authRequest = useRef<{
    epoch: ReturnType<typeof cacheEpoch>;
    promise: Promise<boolean>;
  } | null>(null);
  const refresh = useCallback(() => {
    const epoch = cacheEpoch();
    if (authRequest.current?.epoch === epoch) return authRequest.current.promise;
    const request = (async () => {
      try {
        const state = await api<AuthStatus>('/api/auth/status');
        if (!state.authenticated) lockEdits();
        setStatus(state);
        setError('');
        const connected = state.authenticated && !isOffline();
        if (connected) window.dispatchEvent(new Event('note:library-refresh'));
        return connected;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    })();
    authRequest.current = { epoch, promise: request };
    void request.finally(() => {
      if (authRequest.current?.promise === request) authRequest.current = null;
    });
    return request;
  }, []);
  useEffect(() => {
    void refresh();
    void initializeCache();
    const expired = () => {
      lockEdits();
      setStatus((previous) => (previous ? { ...previous, authenticated: false } : null));
      void refresh();
    };
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const focus = () => {
      clearTimeout(focusTimer);
      if (document.visibilityState === 'visible')
        focusTimer = setTimeout(() => void refresh(), 100);
    };
    window.addEventListener('note:unauthenticated', expired);
    window.addEventListener('focus', focus);
    window.addEventListener('note:cache-reset', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('note:unauthenticated', expired);
      window.removeEventListener('focus', focus);
      window.removeEventListener('note:cache-reset', focus);
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
    <Notebook name={status.name} onCheckSession={refresh} />
  ) : (
    <AuthScreen status={status} token={setupToken} onSuccess={refresh} />
  );
}
function AuthScreen({
  status,
  token,
  onSuccess,
}: {
  status: AuthStatus;
  token: string;
  onSuccess: () => Promise<boolean>;
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
            <p className="field-hint">在部署端重置密码，使用新的设置链接登录。笔记和文件会保留。</p>
          )}
        </form>
      </div>
    </main>
  );
}

function Notebook({
  name,
  onCheckSession,
}: {
  name: string;
  onCheckSession: () => Promise<boolean>;
}) {
  const android = Capacitor.getPlatform() === 'android';
  const treeExpansion = useRef(new Set<string>());
  const [globalOpen, setGlobalOpen] = useState(false);
  const [globalSelection, setGlobalSelection] = useState('');
  const [globalMode, setGlobalMode] = useState<AssistantMode>('floating');
  const [globalImage, setGlobalImage] = useState<{ src: string; alt: string } | null>(null);
  const globalActions = useRef<AssistantHandle | null>(null);
  const offline = useOffline();
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
      iconOnly?: boolean;
    } | null>(null),
    [moving, setMoving] = useState<NoteNode | null>(null);
  const leaveGuard = useRef<() => Promise<boolean>>(async () => true),
    question = useQuestion();
  const navigation = useNotebookNavigation(leaveGuard);
  const listingPages = useRef(new Map<string, number>());
  const { view, id: selected, section: settingsSection } = navigation.route;
  const subpage = !!selected || !!settingsSection || ['recent', 'offline', 'trash'].includes(view);
  useEffect(() => {
    setMobileOpen(false);
    setLoaded(null);
    setGlobalSelection('');
  }, [navigation.key]);
  const report = useCallback(
    (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    [],
  );
  const changed = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(() => {
    window.addEventListener('note:library-refresh', changed);
    return () => window.removeEventListener('note:library-refresh', changed);
  }, [changed]);
  const openSidebar = () => {
    setMobileOpen(true);
    if (isOffline()) void onCheckSession();
    else changed();
  };
  const refreshLibrary = async () => {
    if (!(await onCheckSession()))
      throw new Error('暂时无法刷新，仍显示已有目录。请检查连接后重试。');
  };
  const pullRefresh = usePullRefresh(
    navigation.scroll,
    navigation.key,
    android && !selected && (view === 'tree' || view === 'favorites'),
    refreshLibrary,
    report,
  );
  useEffect(() => {
    let live = true;
    const revalidate = async () => {
      setDetailRevision((value) => value + 1);
      await initializeCache();
      for (const item of cacheSnapshot().notes.filter((note) => note.pinned)) {
        if (!live || !navigator.onLine) break;
        await api(`/api/nodes/${item.node.id}`).catch(() => {});
      }
    };
    if (!offline) void revalidate();
    return () => {
      live = false;
    };
  }, [offline]);
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
    void navigation.go(id ? `/n/${id}` : '/', replace, false);
  };
  const navigate = async (id: string) => {
    if (id === selected && view === 'tree') {
      setMobileOpen(false);
      return;
    }
    await navigation.go(id ? `/n/${id}` : '/');
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
    if (await navigation.go(next === 'tree' ? '/' : `/${next}`)) changed();
    setMobileOpen(false);
  };
  const openSettings = (section: SettingsSection) => {
    void navigation.go(`/settings/${section}`);
  };
  useEffect(() => {
    const back = (event: Event) => {
      if (dismissReadingOverlay()) event.preventDefault();
      else if (mobileOpen) {
        event.preventDefault();
        setMobileOpen(false);
      } else if (subpage) {
        event.preventDefault();
        navigation.back();
      } else if (view !== 'tree') {
        event.preventDefault();
        void navigate('');
      }
    };
    window.addEventListener('note:native-back', back);
    return () => window.removeEventListener('note:native-back', back);
  }, [view, subpage, mobileOpen, navigation.back]);
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
    document.querySelectorAll<HTMLDetailsElement>('details.node-menu[open]').forEach((element) => {
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
      else if (kind === 'icon') setForm({ node: fresh, parent: fresh.parent_id, iconOnly: true });
      else if (kind === 'move') setMoving(fresh);
      else {
        const preview = await api<{ count: number; title: string }>(
          `/api/nodes/${node.id}/delete-preview`,
        );
        if (
          !(await question.confirm(
            '移到回收站？',
            `「${preview.title}」${preview.count > 1 ? `及其下级笔记，共 ${preview.count} 项内容` : ''}将保留 7 天，到期后清理。`,
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
      await onCheckSession();
    } catch (e) {
      report(e);
    }
  };
  const navItems = [
    { key: 'tree' as const, label: '全部笔记', icon: FolderOpen },
    { key: 'favorites' as const, label: '收藏', icon: Star },
    { key: 'recent' as const, label: '最近访问', icon: Clock3 },
    { key: 'offline' as const, label: '离线阅读', icon: HardDriveDownload },
  ];
  return (
    <div
      className={`app-shell ${android ? 'android-shell' : ''} ${mobileOpen ? 'sidebar-open' : ''} ${subpage ? 'has-subpage' : 'has-bottom-nav'}`}
    >
      <ShareImport
        onImported={(nodes) => {
          changed();
          setNotice(`已保存 ${nodes.length} 项内容。`);
          const first = nodes.find((node) => node.kind !== 'link');
          if (first) void navigate(first.id);
        }}
      />
      {!android && (
        <>
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
                onRefresh={refreshLibrary}
                selected={selected}
                onOpen={openNode}
                onAction={action}
                onDrop={drop}
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
                  onClick={() => openSettings('storage')}
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
        </>
      )}
      <main className="main-area">
        {!(view === 'tree' && selected) && (
          <header className="app-header">
            <div className="header-location">
              {subpage && (
                <button
                  className="icon-button page-back"
                  aria-label="返回"
                  onClick={navigation.back}
                >
                  <ArrowLeft size={22} />
                </button>
              )}
              {!android && (
                <button
                  className="icon-button mobile-menu"
                  aria-label="打开笔记目录"
                  aria-controls="notebook-sidebar"
                  aria-expanded={mobileOpen}
                  onClick={openSidebar}
                >
                  <Menu size={21} />
                </button>
              )}
              <span className="header-title">
                {view === 'tree'
                  ? '我的笔记库'
                  : view === 'favorites'
                    ? '收藏'
                    : view === 'recent'
                      ? '最近访问'
                      : view === 'offline'
                        ? '离线阅读'
                        : view === 'trash'
                          ? '回收站'
                          : settingsSection
                            ? settingsTitles[settingsSection]
                            : '设置'}
              </span>
            </div>
          </header>
        )}
        {offline && (
          <div className="offline-banner" role="status">
            <WifiOff size={14} />
            离线阅读
            <button className="text-button" onClick={() => void onCheckSession()}>
              重新连接
            </button>
          </div>
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
            <button className="text-button" onClick={() => openSettings('storage')}>
              管理空间
            </button>
          </div>
        )}
        {android && (pullRefresh.distance > 0 || pullRefresh.refreshing) && (
          <div
            className="pull-refresh"
            role="status"
            style={{ height: pullRefresh.refreshing ? 44 : pullRefresh.distance }}
          >
            {pullRefresh.refreshing
              ? '正在刷新…'
              : pullRefresh.distance >= 64
                ? '松开刷新'
                : '下拉刷新'}
          </div>
        )}
        <ListingPagesContext.Provider value={listingPages.current}>
          <div
            ref={navigation.scroll}
            key={navigation.key}
            className={`main-content page-${navigation.direction}`}
          >
            {view === 'tree' ? (
              selected ? (
                <NotePane
                  key={selected}
                  id={selected}
                  refresh={detailRevision}
                  treeRefresh={revision}
                  showSidebar={!android}
                  globalAssistantOpen={globalOpen}
                  onGlobalAssistant={(selection) => {
                    setGlobalSelection(selection);
                    setGlobalOpen(true);
                  }}
                  sidebarOpen={mobileOpen}
                  onOpenSidebar={openSidebar}
                  onBack={navigation.back}
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
                  onSettings={() => openSettings('ai')}
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
                  <nav className="library-shortcuts" aria-label="笔记快捷入口">
                    <button onClick={() => switchView('recent')}>
                      <Clock3 size={20} />
                      最近访问
                    </button>
                    <button onClick={() => switchView('offline')}>
                      <HardDriveDownload size={20} />
                      离线阅读
                    </button>
                    <button onClick={() => switchView('trash')}>
                      <Trash2 size={20} />
                      回收站
                    </button>
                  </nav>
                  {android ? (
                    <Tree
                      refresh={revision}
                      onRefresh={refreshLibrary}
                      selected={selected}
                      onOpen={openNode}
                      onAction={action}
                      onDrop={drop}
                      expansionState={treeExpansion.current}
                      rememberPages
                      showRefresh={false}
                    />
                  ) : (
                    <NodeList
                      parent={null}
                      refresh={revision}
                      onOpen={openNode}
                      onAction={action}
                    />
                  )}
                </section>
              )
            ) : view === 'favorites' || view === 'recent' ? (
              <section className="collection-page">
                <h1>{view === 'favorites' ? '收藏' : '最近访问'}</h1>
                <NodeList view={view} refresh={revision} onOpen={openNode} onAction={action} />
              </section>
            ) : view === 'offline' ? (
              <OfflineLibrary onOpen={openNode} />
            ) : view === 'trash' ? (
              <TrashView confirm={question.confirm} onChanged={changed} onError={report} />
            ) : (
              <Settings
                section={settingsSection}
                onOpen={openSettings}
                storage={storage}
                confirm={question.confirm}
                onChanged={changed}
                onLogout={logout}
                onError={report}
              />
            )}
          </div>
        </ListingPagesContext.Provider>
        {!subpage && (
          <nav className="phone-bottom-nav" aria-label="底部导航">
            {[
              { key: 'tree' as const, label: '笔记', icon: BookOpen },
              { key: 'favorites' as const, label: '收藏', icon: Star },
              { key: 'settings' as const, label: '设置', icon: Settings2 },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                className={view === key ? 'active' : ''}
                aria-current={view === key ? 'page' : undefined}
                onClick={() => switchView(key)}
              >
                <span>
                  <Icon size={22} />
                </span>
                {label}
              </button>
            ))}
          </nav>
        )}
      </main>
      <AssistantPanel
        global
        node={loaded?.kind !== 'folder' ? (loaded ?? undefined) : undefined}
        actionsRef={globalActions}
        visible={globalOpen}
        enabled
        showLauncher={!selected || loaded?.kind === 'folder'}
        mode={globalMode}
        onModeChange={setGlobalMode}
        selection={globalSelection}
        readingRoot={navigation.scroll}
        onOpen={() => setGlobalOpen(true)}
        onClose={() => setGlobalOpen(false)}
        onChanged={changed}
        onSettings={() => {
          setGlobalOpen(false);
          void openSettings('ai');
        }}
        onNavigate={(id) => {
          setGlobalOpen(false);
          void navigate(id);
        }}
        onImage={(src, alt) => setGlobalImage({ src, alt })}
      />
      {globalImage && (
        <Suspense fallback={<Spinner />}>
          <ImageViewer {...globalImage} onClose={() => setGlobalImage(null)} />
        </Suspense>
      )}
      {form && (
        <NodeForm
          node={form.node}
          parent={form.parent}
          existingFile={form.file}
          iconOnly={form.iconOnly}
          onClose={() => setForm(null)}
          onSaved={(node) => {
            setForm(null);
            changed();
            if (selected === node.id) setDetailRevision((r) => r + 1);
            else if (!form.iconOnly) setRoute(node.id);
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
