import { useEffect, useState } from 'react';
import { FolderOpen, Share2 } from 'lucide-react';
import type { ShareSettings as Settings } from '../../shared/types';
import { api } from '../api';
import { Modal, Spinner } from './Primitives';
import { NodePicker } from './Tree';

export const shareDestinationLabel = (settings: Settings) =>
  settings.breadcrumbs.map((part) => part.title).join(' / ') || '根目录';

export function ShareSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<{ parentId: string | null; title: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    api<Settings>('/api/share/settings')
      .then((value) => {
        if (live) setSettings(value);
      })
      .catch((error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [retry]);
  const close = () => {
    if (!busy) {
      setDraft(null);
      setError('');
    }
  };
  return (
    <section className="settings-section share-settings">
      <h2>
        <Share2 size={19} />
        分享保存
      </h2>
      {settings ? (
        <div className="share-setting-row">
          <div>
            <span className="small muted">默认保存位置</span>
            <p className="destination-summary">
              <FolderOpen size={17} />
              <span>{shareDestinationLabel(settings)}</span>
            </p>
          </div>
          <button
            className="button"
            onClick={() => {
              setError('');
              setDraft({ parentId: settings.parentId, title: shareDestinationLabel(settings) });
            }}
          >
            更改目录
          </button>
        </div>
      ) : !error ? (
        <Spinner />
      ) : (
        <button className="text-button" onClick={() => setRetry((n) => n + 1)}>
          重新加载
        </button>
      )}
      <p className="field-hint">用于系统分享，保存时仍可更改。</p>
      {error && !draft && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {draft && settings && (
        <Modal title="分享默认保存目录" onClose={close}>
          <fieldset disabled={busy}>
            <NodePicker
              parentsOnly
              value={draft.parentId}
              initialPath={settings.breadcrumbs}
              onSelect={(parentId, title) => setDraft({ parentId, title })}
            />
          </fieldset>
          <p className="destination-summary">
            <FolderOpen size={17} />
            <span>保存到：{draft.title}</span>
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button" onClick={close} disabled={busy}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  setSettings(
                    await api<Settings>('/api/share/settings', 'PUT', { parentId: draft.parentId }),
                  );
                  setDraft(null);
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '正在保存…' : '保存'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
