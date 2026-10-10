import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { projectCategory, type ProjectContext } from '../shared/projects';

export const settingsTitles = {
  theme: '外观',
  reading: '阅读',
  ai: '青藜',
  offline: '离线缓存',
  share: '分享保存',
  backup: '备份与恢复',
  storage: '存储空间',
  encryption: '本地加密',
  account: '密码与设备',
  about: '关于页间',
  server: '服务器',
} as const;
export type SettingsSection = keyof typeof settingsTitles;
export type View = 'tree' | 'favorites' | 'recent' | 'offline' | 'trash' | 'settings';
export type NotebookRoute = { view: View; id: string | null; section: SettingsSection | null; project?: ProjectContext };

export function parseRoute(path: string): NotebookRoute {
  const [pathname, query] = path.split('?');
  path = pathname;
  const note = path.match(/^\/n\/([a-zA-Z0-9_-]+)$/);
  if (note) {
    const params = new URLSearchParams(query);
    const id = params.get('project') || '';
    const category = projectCategory(params.get('category'));
    return { view: 'tree', id: note[1], section: null,
      ...(category && /^[a-zA-Z0-9_-]+$/.test(id) ? { project: { id, category } } : {}),
    };
  }
  const section = path.match(/^\/settings\/([^/]+)$/)?.[1];
  if (path === '/settings' || (section && Object.hasOwn(settingsTitles, section)))
    return { view: 'settings', id: null, section: (section as SettingsSection) || null };
  const view = path.slice(1);
  return {
    view: ['favorites', 'recent', 'offline', 'trash'].includes(view) ? (view as View) : 'tree',
    id: null,
    section: null,
  };
}

export function routePath(route: NotebookRoute): string {
  if (route.id) return `/n/${route.id}${route.project ? `?project=${route.project.id}&category=${route.project.category}` : ''}`;
  if (route.view === 'settings' && route.section) return `/settings/${route.section}`;
  return route.view === 'tree' ? '/' : `/${route.view}`;
}

type Entry = { index: number; key: string; path: string };
function entry(path: string, index: number): Entry {
  return { path, index, key: crypto.randomUUID() };
}

// Each history entry owns its list position. Reading positions remain managed by useReading.
export function useNotebookNavigation(guard: { current: () => Promise<boolean> }) {
  const [current, setCurrent] = useState(() => {
    const path = routePath(parseRoute(location.pathname + location.search));
    const saved = history.state?.notebook as Entry | undefined;
    const initial = saved?.path === path ? saved : entry(path, 0);
    history.replaceState({ ...history.state, notebook: initial }, '', path);
    return initial;
  });
  const active = useRef(current);
  const busy = useRef(false);
  const restore = useRef<{ key: string; done: () => void } | null>(null);
  const replay = useRef<string | null>(null);
  const [direction, setDirection] = useState('none');
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const apply = useCallback((next: Entry, motion: string) => {
    active.current = next;
    setDirection(motion);
    setCurrent(next);
  }, []);
  const go = useCallback(
    async (path: string, replace = false, check = true) => {
      if (busy.current || path === active.current.path) return false;
      busy.current = true;
      try {
        if (check && !(await guard.current())) return false;
        const next = entry(path, active.current.index + (replace ? 0 : 1));
        history[replace ? 'replaceState' : 'pushState']({ notebook: next }, '', path);
        const rootTab = ['/', '/favorites', '/settings'].includes(path);
        apply(next, rootTab || replace ? 'none' : 'forward');
        return true;
      } finally {
        busy.current = false;
      }
    },
    [apply, guard],
  );
  const back = useCallback(() => {
    if (busy.current) return;
    if (active.current.index > 0) history.back();
    else void go(active.current.path.startsWith('/settings/') ? '/settings' : '/', true);
  }, [go]);

  useEffect(() => {
    const pop = async (event: PopStateEvent) => {
      const previous = active.current;
      const next: Entry = event.state?.notebook || entry(location.pathname + location.search, 0);
      if (restore.current?.key === next.key) {
        const { done } = restore.current;
        restore.current = null;
        done();
        return;
      }
      if (replay.current === next.key) {
        replay.current = null;
        apply(next, next.index < previous.index ? 'back' : 'forward');
        busy.current = false;
        return;
      }
      const delta = next.index - previous.index;
      if (busy.current) {
        if (delta) history.go(-delta);
        return;
      }
      busy.current = true;
      // Ask on the original entry. Cancelling must not discard the forward stack.
      if (delta)
        await new Promise<void>((done) => {
          restore.current = { key: previous.key, done };
          history.go(-delta);
        });
      if (await guard.current()) {
        if (delta) {
          replay.current = next.key;
          history.go(delta);
        } else {
          apply(next, 'back');
          busy.current = false;
        }
      } else {
        if (!delta) history.replaceState({ notebook: previous }, '', previous.path);
        busy.current = false;
      }
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [apply, guard]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const top = positions.current.get(current.key) || 0;
    let restoring = true;
    const restore = () => {
      if (restoring) element.scrollTop = top;
    };
    const stop = () => {
      restoring = false;
    };
    const remember = () => {
      if (!restoring || element.scrollTop >= top)
        positions.current.set(current.key, element.scrollTop);
    };
    restore();
    const observer = new ResizeObserver(restore);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener('scroll', remember);
    element.addEventListener('pointerdown', stop);
    element.addEventListener('wheel', stop);
    element.addEventListener('keydown', stop);
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', remember);
      element.removeEventListener('pointerdown', stop);
      element.removeEventListener('wheel', stop);
      element.removeEventListener('keydown', stop);
    };
  }, [current.key]);
  return {
    route: parseRoute(current.path),
    path: current.path,
    key: current.key,
    direction,
    scroll,
    go,
    back,
  };
}
