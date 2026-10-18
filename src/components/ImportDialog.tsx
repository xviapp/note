import { useEffect, useRef, useState } from 'react';
import { FolderUp, Upload } from 'lucide-react';
import { api, formatBytes } from '../api';
import type { StorageInfo } from '../../shared/types';
import {
  IMPORT_LIMIT,
  importTitle,
  pickedFiles,
  planImport,
  runImport,
  startImport,
  type ImportFile,
  type ImportPlan,
  type ImportProgress,
  type ImportState,
} from '../vault-import';
import { Modal } from './Primitives';
import { UnlockForm } from './Encryption';
import { LockedError } from '../encryption';

// 导入文件夹: pick or drop a vault, see what it becomes, then import it.
export function ImportDialog({
  parent,
  parentTitle,
  dropped,
  onClose,
  onImported,
}: {
  parent: string | null;
  parentTitle: string;
  // Files dropped on the window, already read.
  dropped?: ImportFile[];
  onClose: () => void;
  // Called after each run that created something; `root` is the import's folder.
  onImported: (root: string | null) => void;
}) {
  const [plan, setPlan] = useState<ImportPlan<ImportFile> | null>(() => (dropped ? planImport(dropped) : null));
  const [free, setFree] = useState<number | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState('');
  const [state, setState] = useState<ImportState<ImportFile> | null>(null);
  const [running, setRunning] = useState(false);
  // The import's place is encrypted and its key is locked on this device.
  const [locked, setLocked] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    void api<StorageInfo>('/api/storage')
      .then((info) => setFree(info.quotaBytes - info.allocatedBytes))
      .catch(() => setFree(null));
  }, []);
  const choose = (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    setState(null);
    setPlan(planImport(pickedFiles(files)));
  };
  const tooMany = !!plan && plan.items.length > IMPORT_LIMIT;
  const tooLarge = !!plan && free !== null && plan.bytes > free;
  const start = async () => {
    if (!plan || running) return;
    const current = state ?? startImport(plan, parent);
    setState(current);
    setError('');
    setLocked(null);
    setRunning(true);
    abort.current = new AbortController();
    try {
      await runImport(current, setProgress, abort.current.signal);
    } catch (reason) {
      if (reason instanceof LockedError && reason.keyId) {
        setLocked(reason.keyId);
        return;
      }
      setError(
        abort.current.signal.aborted
          ? '已停止，已导入的内容保留，可继续导入剩余部分。'
          : (reason as Error).message || '导入未完成。',
      );
    } finally {
      abort.current = null;
      setProgress(null);
      setRunning(false);
      if (current.created.size) onImported(current.rootId);
    }
  };
  const finished = !!state && !running && !error && !state.failed.size;
  const counts = plan
    ? {
        notes: plan.items.filter((item) => item.kind === 'markdown' || item.kind === 'text').length,
        files: plan.items.filter((item) => item.kind === 'pdf' || item.kind === 'image').length,
        folders: plan.items.filter((item) => item.kind === 'folder').length,
      }
    : null;
  const missing = state ? [...state.missing].flatMap(([path, targets]) => targets.map((target) => `${path}：${target}`)) : [];
  return (
    <Modal title="导入文件夹" onClose={() => !running && onClose()}>
      <div className="form-stack import-dialog">
        <p className="field-hint">
          把 Obsidian、Typora 等笔记文件夹导入到「{parentTitle}」。目录会新建一个文件夹存放；Markdown
          和纯文本成为笔记，PDF 和图片成为条目，笔记中的图片和笔记链接改为站内链接。
        </p>
        {!state && (
          <div className="backup-actions">
            <label className="button file-input-button">
              <FolderUp size={15} />
              选择文件夹
              <input
                type="file"
                aria-label="选择文件夹"
                ref={(input) => {
                  input?.setAttribute('webkitdirectory', '');
                }}
                onChange={(event) => {
                  choose(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
            <label className="button file-input-button">
              <Upload size={15} />
              选择文件
              <input
                type="file"
                aria-label="选择文件"
                multiple
                accept=".md,.markdown,.txt,.pdf,image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml"
                onChange={(event) => {
                  choose(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
        )}
        {!plan && <p className="field-hint">也可以把文件夹或文件直接拖到窗口中。</p>}
        {plan && counts && (
          <div className="import-summary">
            <p>
              {plan.wrap ? `新建「${state?.title ?? importTitle(plan)}」，` : ''}
              {counts.notes} 篇笔记、{counts.files} 个文件
              {counts.folders ? `、${counts.folders} 个文件夹` : ''} · {formatBytes(plan.bytes)}
            </p>
            {!plan.items.length && <p className="inline-error">没有可导入的内容。</p>}
            {tooMany && <p className="inline-error">一次最多导入 {IMPORT_LIMIT} 项，请分批导入。</p>}
            {tooLarge && <p className="inline-error">剩余空间不足（还有 {formatBytes(free!)}）。</p>}
            {!!plan.skipped.length && (
              <details>
                <summary>跳过 {plan.skipped.length} 个文件</summary>
                <ul className="import-list">
                  {plan.skipped.map((item) => (
                    <li key={item.path}>
                      {item.path}（{item.reason}）
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {progress && (
          <div aria-live="polite">
            <progress max={progress.total || 1} value={progress.done} />
            <p className="field-hint">
              {progress.done}/{progress.total} {progress.current}
            </p>
          </div>
        )}
        {state && !running && (
          <div className="import-summary">
            <p>{finished ? '导入完成。' : `已导入 ${state.created.size - (state.rootId ? 1 : 0)} 项。`}</p>
            {!!state.failed.size && (
              <details open>
                <summary>{state.failed.size} 项未能导入</summary>
                <ul className="import-list">
                  {[...state.failed].map(([path, message]) => (
                    <li key={path}>
                      {path}：{message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {!!missing.length && (
              <details>
                <summary>{missing.length} 个链接未找到目标，保留原样</summary>
                <ul className="import-list">
                  {missing.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {locked && (
          <div>
            <p className="field-hint">导入位置已加密，请先解锁，再继续导入。</p>
            <UnlockForm keyId={locked} onUnlocked={() => setLocked(null)} />
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {running ? (
            <button type="button" className="button" onClick={() => abort.current?.abort()}>
              停止
            </button>
          ) : (
            <button type="button" className="button" onClick={onClose}>
              {finished ? '完成' : '取消'}
            </button>
          )}
          {!finished && plan && (
            <button
              type="button"
              className="button primary"
              disabled={running || !!locked || !plan.items.length || tooMany || (tooLarge && !state)}
              onClick={() => void start()}
            >
              {running ? '正在导入…' : state ? '继续导入' : '开始导入'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
