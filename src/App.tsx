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
import { api, ApiError, cachedApi, lockEdits } from './api';
import {
  TEXT_KINDS,
  type AuthStatus,
  type FileInfo,
  type NoteDetail,
  type NoteNode,
  type StorageInfo,
  type StorageUsage,
} from '../shared/types';
import { Modal, Spinner, useQuestion } from './components/Primitives';
import { Tree, type NodeAction } from './components/Tree';
import { useMoveNotes } from './use-move-notes';
import { useToast } from './use-toast';
import { MoveDialog } from './components/MoveDialog';
import { EncryptionDialog } from './components/Encryption';
import { refreshCatalog, subscribeKeys } from './keyring';
import { flushJournalOutbox } from './journal-outbox';
import { flushQuickRecords } from './quick-journal';
import { flushSaves } from './save-outbox';
import { fillSearchIndex } from './search-index';
import { settleChange, showChange } from './optimistic';
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
import { QuickClips } from './components/QuickClips';
import { flushClips } from './clips';
import { watchWidgetClips } from './widget-clips';
import { BootScreen } from './components/BootScreen';
import { preloadMarkdown } from './components/LazyMarkdown';
import { AppHeader, Sidebar } from './components/Sidebar';
import { SyncStatus } from './components/SyncStatus';
import { ContinueReading } from './components/ContinueReading';
import { useOutboxSummary } from './outbox';
import { SearchDialog } from './components/SearchDialog';
import { AuthScreen } from './components/AuthScreen';
import { translationWindowId } from './screen-link';
import { ListingCacheContext, type ListingCache } from './use-node-listing';
import { routePath, useNotebookNavigation, type SettingsSection, type View } from './navigation';
import type { ProjectContext } from '../shared/projects';
import { noteType } from './note-types/registry';
// The translation window for a second screen loads only what it shows.
const TranslationScreen = lazy(() => import('./components/TranslationScreen'));

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
  // Set while the notebook shows a cached session whose listings are already
  // loading alongside the first session check.
  const fromCache = useRef(false),
    answered = useRef(false),
    checked = useRef(false);
  const refresh = useCallback(() => {
    const epoch = cacheEpoch();
    if (authRequest.current?.epoch === epoch) return authRequest.current.promise;
    const request = (async () => {
      try {
        const state = await api<AuthStatus>('/api/auth/status');
        if (!state.authenticated) lockEdits();
        const confirmed = fromCache.current;
        fromCache.current = false;
        answered.current = checked.current = true;
        setStatus(state);
        setError('');
        const connected = state.authenticated && !isOffline();
        if (connected && !confirmed) window.dispatchEvent(new Event('note:library-refresh'));
        // Picks up passwords changed on other devices (and locks them here).
        if (connected) void refreshCatalog().catch(() => {});
        return connected;
      } catch (e) {
        fromCache.current = false;
        checked.current = true;
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
    const epoch = cacheEpoch();
    void refresh();
    // A signed-in device opens on its cached library while the session is
    // verified (a slow proxy or network can take seconds); a signed-out answer
    // then replaces it and clears the cache. A failed check keeps the library,
    // as when offline.
    void cachedApi<AuthStatus>('/api/auth/status').then((cached) => {
      if (!cached?.authenticated || answered.current || epoch !== cacheEpoch()) return;
      fromCache.current = !checked.current;
      setStatus(cached);
    });
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
  const translationWindow = translationWindowId();
  if (status.authenticated && translationWindow)
    return (
      <Suspense fallback={<BootScreen error="" onRetry={refresh} />}>
        <TranslationScreen id={translationWindow} />
      </Suspense>
    );
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
  const [clipsOpen, setClipsOpen] = useState(false);
  const globalActions = useRef<AssistantHandle | null>(null);
  const offline = useOffline();
  const [loaded, setLoaded] = useState<NoteDetail | null>(null),
    [mobileOpen, setMobileOpen] = useState(false);
  // A note just created from the form, opened for writing on arrival.
  const [freshNote, setFreshNote] = useState<string | null>(null);
  const clearFreshNote = useCallback(() => setFreshNote(null), []);
  const [revision, setRevision] = useState(0),
    [detailRevision, setDetailRevision] = useState(0),
    [storage, setStorage] = useState<StorageInfo | null>(null),
    [usage, setUsage] = useState<StorageUsage | null>(null),
    [notice, setNotice] = useState('');
  const [form, setForm] = useState<{
      node?: NoteNode;
      parent: string | null;
      file?: FileInfo;
      iconOnly?: boolean;
    } | null>(null),
    [moving, setMoving] = useState<NoteNode | null>(null),
    [encrypting, setEncrypting] = useState<NoteDetail | null>(null);
  const leaveGuard = useRef<() => Promise<boolean>>(async () => true),
    question = useQuestion();
  const navigation = useNotebookNavigation(leaveGuard);
  const listings = useRef<ListingCache>(new Map());
  const { view, id: selected, section: settingsSection } = navigation.route;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const subpage = !!selected || !!settingsSection || ['recent', 'offline', 'trash'].includes(view);
  useEffect(() => {
    setMobileOpen(false);
    setLoaded(null);
    setGlobalSelection('');
  }, [navigation.key]);
  const toast = useToast();
  const outbox = useOutboxSummary();
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
  // Every change refreshes the quota warning, which reads one row. The full
  // breakdown scans all files, so it loads only while its settings page is open.
  useEffect(() => {
    let live = true;
    api<StorageUsage>('/api/storage/usage')
      .then((data) => {
        if (live) setUsage(data);
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [revision, report]);
  const storageOpen = view === 'settings' && settingsSection === 'storage';
  useEffect(() => {
    if (!storageOpen) return;
    let live = true;
    api<StorageInfo>('/api/storage')
      .then((data) => {
        if (live) setStorage(data);
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [storageOpen, revision, report]);
  const setRoute = (id: string | null, replace = false) => {
    void navigation.go(id ? `/n/${id}` : '/', replace, false);
  };
  const navigate = async (id: string, project?: ProjectContext) => {
    const path = routePath({ id: id || null, view: 'tree', section: null, project });
    if (path === navigation.path) {
      setMobileOpen(false);
      return;
    }
    await navigation.go(path);
  };
  // A note saved from the new/rename form (see NodeForm's onBackground).
  // `open`: go to the note (a rename saved in the background already went there).
  const formSaved = (current: NonNullable<typeof form>, node: NoteNode, open = true) => {
    const created = !current.node && !current.file;
    changed();
    if (created && TEXT_KINDS.includes(node.kind)) setFreshNote(node.id);
    if (selectedRef.current === node.id) setDetailRevision((r) => r + 1);
    else if (!current.iconOnly && open) setRoute(node.id);
  };
  const openNode = (node: NoteNode) => {
    // Still being created (shown ahead by the new-note form).
    if (node.id.startsWith('pending-')) return;
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
    // Clips kept offline, or from the share window, go out once the notebook opens.
    void flushClips();
    const stopWidgetClips = android ? watchWidgetClips() : () => {};
    const open = () => setClipsOpen(true);
    window.addEventListener('note:clips', open);
    return () => {
      stopWidgetClips();
      window.removeEventListener('note:clips', open);
    };
  }, [android]);
  const showToast = toast.show;
  // 今日记 kept on this device for a locked journal goes out once it is unlocked.
  useEffect(() => {
    const flush = () => {
      // Note bodies saved in the background that are still on their way.
      void flushSaves();
      // Bodies not yet in the server's search index.
      fillSearchIndex();
      void flushJournalOutbox().then((sent) => {
        if (sent) {
          showToast(`${sent} 条今日记已记入日记`);
          changed();
        }
      });
      // 今日记 saved on an earlier day that Android ended before it was sent.
      void flushQuickRecords({ earlier: true }).then((sent) => {
        if (sent) {
          showToast(`${sent} 条之前的今日记已记入日记`);
          changed();
        }
      });
    };
    flush();
    const stop = subscribeKeys(flush);
    window.addEventListener('online', flush);
    window.addEventListener('note:reconnected', flush);
    return () => {
      stop();
      window.removeEventListener('online', flush);
      window.removeEventListener('note:reconnected', flush);
    };
  }, [showToast, changed]);
  // Android notices and status lines (downloads, links) use the notebook's own.
  useEffect(() => {
    const show = (event: Event) => {
      event.preventDefault();
      const message = (event as CustomEvent<string>).detail;
      if (event.type === 'note:toast') showToast(message);
      else setNotice(message);
    };
    window.addEventListener('note:notice', show);
    window.addEventListener('note:toast', show);
    return () => {
      window.removeEventListener('note:notice', show);
      window.removeEventListener('note:toast', show);
    };
  }, [showToast]);
  // A floating window (今日记, 青藜) handing over to a page of the notebook.
  const open = useRef((path: string) => void navigation.go(path));
  open.current = (path) => void navigation.go(path);
  useEffect(() => {
    if (!android) return;
    const take = () =>
      void import('./mobile')
        .then(({ device }) => device.takeLaunch())
        .then(({ action, path }) => {
          if (action === 'open' && path) open.current(path);
        })
        .catch(report);
    take();
    window.addEventListener('note:launch', take);
    return () => window.removeEventListener('note:launch', take);
  }, [android, report]);
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
  // Computer shortcuts: Ctrl+K or / searches, N creates a note, E edits the open one.
  const [searchOpen, setSearchOpen] = useState(false),
    [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcuts = useRef({ newNode: () => {} });
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || !!target.closest('input, textarea, select, .cm-editor'));
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const letter = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && letter === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        typing(event.target) ||
        document.querySelector('dialog[open]')
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (letter === 'n') {
        event.preventDefault();
        shortcuts.current.newNode();
      } else if (letter === 'e') window.dispatchEvent(new Event('note:edit-shortcut'));
      else if (letter === 'q') {
        event.preventDefault();
        setClipsOpen(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
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
    if (kind === 'delete') {
      await remove(node);
      return;
    }
    try {
      const fresh = await api<NoteDetail>(`/api/nodes/${node.id}`);
      if (kind === 'rename') setForm({ node: fresh, parent: fresh.parent_id });
      else if (kind === 'icon') setForm({ node: fresh, parent: fresh.parent_id, iconOnly: true });
      else if (kind === 'move') setMoving(fresh);
      else if (kind === 'encryption') setEncrypting(fresh);
    } catch (e) {
      report(e);
    }
  };
  // A note leaves the list at once and goes to the trash with 撤销. A note
  // shown without children skips the preview; a branch is counted and asked
  // about first, as is one whose count turns out different.
  const remove = async (node: NoteNode, counted = false) => {
    try {
      const preview =
        !counted && node.child_count === 0
          ? { count: 1, title: node.title }
          : await api<{ count: number; title: string }>(`/api/nodes/${node.id}/delete-preview`);
      if (
        preview.count > 1 &&
        !(await question.confirm(
          '移到回收站？',
          `「${preview.title}」及其下级笔记，共 ${preview.count} 项内容将保留 7 天，到期后清理。`,
          '移到回收站',
          true,
        ))
      )
        return;
      const wasOpen =
        selected === node.id || !!loaded?.breadcrumbs.some((part) => part.id === node.id);
      const withdraw = showChange(node.id, { hidden: true });
      if (wasOpen) setRoute(null);
      try {
        const batch = await api<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', {
          count: preview.count,
        });
        changed();
        settleChange(withdraw);
        toast.show(`「${preview.title}」已移到回收站`, async () => {
          try {
            await api(`/api/trash/${batch.id}/restore`, 'POST', {});
            changed();
            if (wasOpen) setRoute(selected);
            toast.show('已恢复');
          } catch (e) {
            report(e);
          }
        });
      } catch (e) {
        withdraw();
        if (wasOpen) setRoute(selected);
        if (!counted && e instanceof ApiError && e.code === 'TREE_CHANGED') return remove(node, true);
        throw e;
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
    toast: toast.show,
  });
  const { moved, drop } = moves;
  const newNode = async () => {
    if (!(await leaveGuard.current())) return;
    setForm({
      parent: loaded && noteType(loaded).container && !(loaded.kind === 'markdown' && (loaded.project_category || navigation.route.project)) ? loaded.id : loaded?.parent_id || null,
    });
  };
  shortcuts.current.newNode = () => void newNode();
  const logout = async (all = false) => {
    if (!(await leaveGuard.current())) return;
    try {
      if (android) await (await import('./mobile')).device.clearWidgetClips();
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
          toast.show(`已保存 ${nodes.length} 项内容`);
          const first = nodes.find((node) => node.kind !== 'link');
          if (first) void navigate(first.id);
        }}
        onClipped={() => toast.show('已存入随手记')}
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
            onSearch={() => setSearchOpen(true)}
            onClose={() => setMobileOpen(false)}
            onView={(next) => void switchView(next)}
            status={
              <SyncStatus
                count={outbox.count}
                failed={outbox.failed}
                onOpen={() => {
                  setMobileOpen(false);
                  openSettings('outbox');
                }}
              />
            }
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
            onSearch={() => setSearchOpen(true)}
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
        {usage && usage.allocatedBytes >= usage.quotaBytes * 0.8 && (
          <div className="capacity-warning">
            空间已使用 {Math.round((usage.allocatedBytes / usage.quotaBytes) * 100)}
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
                  projectContext={navigation.route.project}
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
                  onCreated={(node) => {
                    changed();
                    setFreshNote(node.id);
                    void navigate(node.id);
                  }}
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
                  onNotice={toast.show}
                  autoEdit={freshNote === selected}
                  onAutoEdit={clearFreshNote}
                />
              ) : (
                <section className="collection-page library-home">
                  <h1 className="sr-only">全部笔记</h1>
                  <ContinueReading refresh={revision} onOpen={openNode} />
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
                      onNew={() => void newNode()}
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
                      onNew={() => void newNode()}
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
                onNavigate={(id) => void navigate(id)}
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
                aria-label={key === 'settings' && outbox.count ? `${label}，${outbox.count} 项待发送` : undefined}
                onClick={() => switchView(key)}
              >
                <span>
                  <Icon size={22} />
                  {key === 'settings' && outbox.count > 0 && (
                    <i className={`nav-badge${outbox.failed ? ' failed' : ''}`} aria-hidden="true" />
                  )}
                </span>
                {label}
              </button>
            ))}
          </nav>
        )}
        {toast.element}
      </main>
      <AssistantPanel
        global
        node={loaded?.kind !== 'folder' ? (loaded ?? undefined) : undefined}
        actionsRef={globalActions}
        visible={globalOpen}
        enabled
        // Books talk to 青藜 through their pages' discussions.
        showLauncher={(!selected || loaded?.kind === 'folder') && !loaded?.book}
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
            formSaved(form, node);
          }}
          // The form closes at once: a new note shows in its folder as 正在创建…
          // and opens when created; a new title shows while it is saved.
          onBackground={(request, shown) => {
            const current = form;
            setForm(null);
            const target = shown.added?.id ?? current.node?.id;
            const withdraw = target
              ? showChange(target, shown.added ? { added: shown.added } : { fields: shown.fields })
              : () => {};
            if (current.node && !current.iconOnly && selected !== current.node.id) setRoute(current.node.id);
            void request
              .then((node) => {
                if (shown.added) withdraw();
                else settleChange(withdraw);
                formSaved(current, node, !current.node);
              })
              .catch((e) => {
                withdraw();
                report(e);
              });
          }}
        />
      )}{' '}
      {shortcutsOpen && (
        <Modal title="快捷键" onClose={() => setShortcutsOpen(false)}>
          <dl className="shortcut-list">
            {[
              ['Ctrl K 或 /', '按标题搜索笔记'],
              ['N', '新建笔记'],
              ['E', '编辑当前笔记'],
              ['Q', '打开随手记'],
              ['Ctrl S', '编辑时保存并继续编辑'],
              ['Esc', '关闭弹窗、菜单或全屏视图'],
              ['?', '显示这份列表'],
            ].map(([keys, action]) => (
              <div key={keys}>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
          <p className="shortcut-note">在输入框或编辑器里打字时，单键快捷键不会触发。</p>
        </Modal>
      )}
      {clipsOpen && (
        <QuickClips
          source={
            view === 'tree' && selected && loaded?.id === selected
              ? { id: loaded.id, title: loaded.title }
              : null
          }
          onClose={() => setClipsOpen(false)}
          onNavigate={(id) => void navigate(id)}
          onCreated={(node) => {
            changed();
            toast.show('已转为笔记');
            void navigate(node.id);
          }}
        />
      )}
      {searchOpen && (
        <SearchDialog
          onOpen={(node) => {
            setMobileOpen(false);
            openNode(node);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {encrypting && (
        <EncryptionDialog
          note={encrypting}
          onClose={() => setEncrypting(null)}
          onChanged={() => {
            changed();
            setDetailRevision((r) => r + 1);
          }}
        />
      )}
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
