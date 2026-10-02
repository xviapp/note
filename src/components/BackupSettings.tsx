import { useEffect, useRef, useState } from 'react';
import { Archive, Download, Upload } from 'lucide-react';
import { exportLibrary, openBackup, restoreLibrary, type OpenBackup } from '../backup';
import { api, formatBytes } from '../api';
import { useOffline } from '../connectivity';
import type { Confirm } from './Management';

export function BackupSettings({
  confirm,
  onChanged,
}: {
  confirm: Confirm;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [backup, setBackup] = useState<OpenBackup | null>(null);
  const controller = useRef<AbortController | null>(null),
    active = useRef<OpenBackup | null>(null);
  const offline = useOffline();
  active.current = backup;
  useEffect(
    () => () => {
      controller.current?.abort();
      if (active.current) {
        void active.current.reader.close();
        void api(`/api/backups/${active.current.key}`, 'DELETE').catch(() => {});
      }
    },
    [],
  );
  useEffect(() => {
    if (!busy) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [busy]);
  const perform = async (operation: (signal: AbortSignal) => Promise<void>) => {
    setBusy(true);
    setMessage('');
    controller.current = new AbortController();
    try {
      await operation(controller.current.signal);
    } catch (error) {
      setMessage(
        error instanceof DOMException && error.name === 'AbortError'
          ? '已取消。'
          : (error as Error).message,
      );
    } finally {
      setBusy(false);
      controller.current = null;
    }
  };
  return (
    <section className="settings-section">
      <h2>
        <Archive size={19} />
        备份与恢复
      </h2>
      <p className="field-hint">包含笔记、附件、历史版本、收藏、阅读位置、青藜对话和翻译记录。</p>
      <div className="backup-actions">
        <button
          className="button"
          disabled={busy || offline}
          onClick={() => {
            void perform(async (signal) => {
              const saved = await exportLibrary(setMessage, signal);
              setMessage(saved ? '备份已保存。' : '已取消。');
            });
          }}
        >
          <Download size={15} />
          导出整库备份
        </button>
        <label className="button file-input-button">
          <Upload size={15} />
          选择备份文件
          <input
            className="sr-only"
            aria-label="选择备份文件"
            type="file"
            accept=".zip,application/zip"
            disabled={busy || offline}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void perform(async () => {
                setBackup(null);
                if (backup) {
                  await backup.reader.close();
                  await api(`/api/backups/${backup.key}`, 'DELETE').catch(() => {});
                }
                const next = await openBackup(file);
                setBackup(next);
                setMessage('');
              });
            }}
          />
        </label>
      </div>
      {backup && (
        <div className="backup-preview">
          <p>
            {new Date(backup.archive.createdAt).toLocaleString('zh-CN')} ·{' '}
            {backup.archive.tables.nodes.length} 个节点 ·{' '}
            {formatBytes(backup.archive.files.reduce((sum, f) => sum + f.size, 0))}
          </p>
          <p className="field-hint">
            恢复到新目录，当前资料保留。原回收站内容放入「原回收站」子目录。密码和 AI
            密钥保持当前设置。
          </p>
          <button
            className="button"
            disabled={busy || offline}
            onClick={async () => {
              if (
                !(await confirm(
                  '恢复这份备份？',
                  `将添加 ${backup.archive.tables.nodes.length} 个节点及对应记录。`,
                  '恢复到新目录',
                ))
              )
                return;
              await perform(async (signal) => {
                await restoreLibrary(backup, setMessage, signal);
                await backup.reader.close();
                await api(`/api/backups/${backup.key}`, 'DELETE').catch(() => {});
                setBackup(null);
                onChanged();
                setMessage('已恢复，可在全部笔记中打开新的备份目录。');
              });
            }}
          >
            恢复到新目录
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {busy && (
        <button className="text-button" onClick={() => controller.current?.abort()}>
          取消
        </button>
      )}
      {offline && <p className="field-hint">联网后可备份或恢复。</p>}
    </section>
  );
}
