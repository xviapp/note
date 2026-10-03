import { useState, useSyncExternalStore } from 'react';
import { HardDriveDownload, LoaderCircle, X } from 'lucide-react';
import type { NoteDetail, NoteNode } from '../../shared/types';
import { api, formatBytes } from '../api';
import {
  cacheSnapshot,
  clearRecentCache,
  rememberNote,
  setCacheLimit,
  subscribeCache,
  unpinNote,
} from '../offline-cache';
import { Empty, NodeIcon } from './Primitives';
import '../offline.css';
import { prepareOfflineShell } from '../offline-shell';

export const useCache = () => useSyncExternalStore(subscribeCache, cacheSnapshot);

export function OfflineSaveButton({ node }: { node: NoteNode }) {
  const cache = useCache();
  const saved = cache.notes.find((item) => item.node.id === node.id);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (node.kind === 'folder' || (node.kind === 'link' && !node.arxiv_id)) return null;
  return (
    <>
      <button
        disabled={busy || !cache.supported}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            if (saved?.pinned) await unpinNote(node.id);
            else {
              // Persistence is best-effort; the browser can decline the request.
              void navigator.storage?.persist?.().catch(() => false);
              await prepareOfflineShell();
              const detail = await api<NoteDetail>(`/api/nodes/${node.id}`);
              await rememberNote(detail, true);
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {/* Other menu items have no icon; only the progress spinner shows. */}
        {busy && <LoaderCircle size={14} className="spin menu-spinner" />}
        {busy ? '正在离线保存…' : saved?.pinned ? '取消离线保存' : '离线保存'}
      </button>
      {saved?.error && !error && (
        <p className="offline-menu-error" role="status">
          {saved.error}
        </p>
      )}
      {error && (
        <p className="offline-menu-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function CacheSettings() {
  const cache = useCache();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pinned = cache.notes.filter((item) => item.pinned);
  return (
    <section className="settings-section cache-settings">
      <h2>
        <HardDriveDownload size={19} />
        本机缓存
      </h2>
      {cache.supported ? (
        <>
          <div className="usage-heading">
            <strong>{formatBytes(cache.bytes)}</strong>
            <span> / {formatBytes(cache.limit)}</span>
          </div>
          <progress value={cache.bytes} max={cache.limit} />
          <p className="field-hint">
            自动缓存最近阅读。离线保存的文件保留在本机，清理不会删除云端内容。网页和外链图片需联网。
          </p>
          <div className="setting-row">
            <label htmlFor="cache-limit">缓存上限</label>
            <select
              id="cache-limit"
              value={cache.limit}
              disabled={busy}
              onChange={(e) => void act(() => setCacheLimit(Number(e.target.value)))}
            >
              {[50, 100, 200, 500, 1000, 2000].map((mb) => (
                <option key={mb} value={mb * 1e6}>
                  {mb} MB
                </option>
              ))}
            </select>
          </div>
          <button
            className="button"
            disabled={busy || !cache.notes.some((item) => !item.pinned)}
            onClick={() => void act(clearRecentCache)}
          >
            清理自动缓存
          </button>
          {!!pinned.length && (
            <div className="cache-pinned">
              <h3>
                已离线保存 <span>{pinned.length}</span>
              </h3>
              {pinned.map((item) => (
                <div className="cache-pinned-row" key={item.node.id}>
                  <NodeIcon node={item.node} kind={item.node.arxiv_id ? 'arxiv' : item.node.kind} />
                  <span>
                    {item.node.title}
                    <small>{formatBytes(item.bytes)}</small>
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`取消离线保存 ${item.node.title}`}
                    disabled={busy}
                    onClick={() => void act(() => unpinNote(item.node.id))}
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="inline-error">{cache.error}</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function OfflineLibrary({ onOpen }: { onOpen: (node: NoteNode) => void }) {
  const cache = useCache();
  const notes = cache.notes.filter(
    (item) => item.node.kind !== 'folder' && (item.node.kind !== 'link' || item.node.arxiv_id),
  );
  return (
    <section className="collection-page">
      <h1>离线阅读</h1>
      {!notes.length ? (
        <Empty icon={<HardDriveDownload />} title="还没有缓存的文件">
          打开文件会自动缓存，也可以在文件菜单中选择「离线保存」。
        </Empty>
      ) : (
        <div className="node-list offline-library">
          {notes.map((item) => (
            <div className="node-list-row" key={item.node.id}>
              <button className="node-list-main" onClick={() => onOpen(item.node)}>
                <NodeIcon node={item.node} kind={item.node.arxiv_id ? 'arxiv' : item.node.kind} />
                <span className="offline-file-title">
                  {item.node.title}
                  <small>
                    {item.error ||
                      (item.pinned ? '已离线保存' : item.complete ? '自动缓存' : '下载未完成')}
                  </small>
                </span>
              </button>
              <span className="offline-file-size">{formatBytes(item.bytes)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
