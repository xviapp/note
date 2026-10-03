import { AssistantPanel, type AssistantHandle } from './components/AssistantPanel';
import type { AssistantMode } from './components/AssistantWindow';
import { usePullRefresh } from './use-pull-refresh';
import { Capacitor } from '@capacitor/core';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Clock3,
  HardDriveDownload,
  Settings2,
  Star,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { api, lockEdits } from './api';
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
import { useMoveNotes } from './use-move-notes';
import { MoveDialog } from './components/MoveDialog';
import { NodeForm } from './components/NodeForm';
import { NodeList } from './components/NodeList';
import { Settings } from './components/Settings';
import { TrashView } from './components/TrashView';
import NotePane from './components/NotePane';

import { openLink } from './open-link';
import { dismissReadingOverlay } from './mobile-back';
import { isOffline, useOffline } from './connectivity';
import { OfflineLibrary } from './components/OfflineCache';
import { cacheEpoch, cacheSnapshot, initializeCache } from './offline-cache';
import { ShareImport } from './components/ShareImport';
import { BootScreen } from './components/BootScreen';
import { preloadMarkdown } from './components/LazyMarkdown';
import { AppHeader, Sidebar } from './components/Sidebar';
import { AuthScreen } from './components/AuthScreen';
import { ListingCacheContext, type ListingCache } from './use-node-listing';
import { useNotebookNavigation, type SettingsSection, type View } from './navigation';

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
  const booted = !!status || !!error;
  useEffect(() => {
    // The Android splash stays up until the first screen (or boot error) renders.
    if (booted && import.meta.env.MODE === 'android')
      void import('./mobile').then(({ finishBoot }) => finishBoot());
  }, [booted]);
  if (!status) return <BootScreen error={error} onRetry={refresh} />;
  return status.authenticated ? (
    <Notebook name={status.name} onCheckSession={refresh} />
  ) : (
    <AuthScreen status={status} token={setupToken} onSuccess={refresh} />
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
  const listings = useRef<ListingCache>(new Map());
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
  useEffect(preloadMarkdown, []);
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
    await navigation.go(next === 'tree' ? '/' : `/${next}`);
    setMobileOpen(false);
  };
  const openSettings = (section: SettingsSection) => {
    void navigation.go(`/settings/${section}`);
  };
  // The system back button reads the latest page state; the listener stays put.
  const nativeBack = useRef<(event: Event) => void>(() => {});
  nativeBack.current = (event: Event) => {
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
  useEffect(() => {
    const back = (event: Event) => nativeBack.current(event);
    window.addEventListener('note:native-back', back);
    return () => window.removeEventListener('note:native-back', back);
  }, []);
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
  const moves = useMoveNotes({
    canLeave: () => leaveGuard.current(),
    onMoved: () => {
      changed();
      setDetailRevision((r) => r + 1);
    },
    onError: report,
  });
  const { moved, drop } = moves;
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
          <Sidebar
            name={name}
            view={view}
            onNew={() => void newNode()}
            onClose={() => setMobileOpen(false)}
            onView={(next) => void switchView(next)}
            tree={{
              refresh: revision,
              onRefresh: refreshLibrary,
              selected,
              onOpen: openNode,
              onAction: action,
              onDrop: drop,
              moved,
            }}
          />
        </>
      )}
      <main className="main-area">
        {!(view === 'tree' && selected) && (
          <AppHeader
            view={view}
            section={settingsSection}
            showBack={subpage}
            showMenu={!android}
            menuOpen={mobileOpen}
            onBack={navigation.back}
            onMenu={openSidebar}
            onNew={view === 'tree' && !selected ? () => void newNode() : undefined}
          />
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
        <ListingCacheContext.Provider value={listings.current}>
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
                  <h1 className="sr-only">全部笔记</h1>
                  <nav className="library-shortcuts" aria-label="笔记快捷入口">
                    <button onClick={() => switchView('recent')}>
                      <Clock3 size={16} />
                      最近访问
                    </button>
                    <button onClick={() => switchView('offline')}>
                      <HardDriveDownload size={16} />
                      离线阅读
                    </button>
                    <button onClick={() => switchView('trash')}>
                      <Trash2 size={16} />
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
                      moved={moved}
                      expansionState={treeExpansion.current}
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
        </ListingCacheContext.Provider>
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
        {moves.toast}
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
          onSaved={(parent, title, ancestors) => {
            moves.announce(moving.id, moving.parent_id, parent, title, ancestors);
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
