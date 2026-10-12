import { useEffect, useState } from 'react';
import { CalendarDays, FolderOpen, Share2 } from 'lucide-react';
import type { NoteNode, ShareSettings as Settings } from '../../shared/types';
import { api } from '../api';
import { Modal, Spinner } from './Primitives';
import { NodePicker } from './Tree';

import { shareDestinationLabel } from '../use-share-destination';

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
        保存位置
      </h2>
      {settings ? (
        <div className="share-setting-row">
          <div>
            <span className="small muted">分享保存到</span>
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
      <QuickJournalSetting />
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

// Where Android's 今日记 window writes: a chosen journal, or (by default) the
// journal written in most recently. An account setting, like the share folder.
function QuickJournalSetting() {
  const [journals, setJournals] = useState<NoteNode[] | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ nodes: NoteNode[] }>('/api/nodes?view=journals'),
      api<{ journalId: string | null }>('/api/journals/quick'),
    ])
      .then(([list, setting]) => {
        if (!live) return;
        setJournals(list.nodes);
        setValue(setting.journalId);
      })
      .catch((reason: Error) => live && setError(reason.message));
    return () => {
      live = false;
    };
  }, []);
  const choose = async (journalId: string | null) => {
    setBusy(true);
    setError('');
    try {
      setValue((await api<{ journalId: string | null }>('/api/journals/quick', 'PUT', { journalId })).journalId);
      // The 今日记 window opens from this device's cached list; refresh its order.
      await api('/api/nodes?view=journals').catch(() => {});
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="share-setting-row">
        <label className="quick-journal-setting">
          <span className="small muted">
            <CalendarDays size={14} aria-hidden="true" />
            今日记保存到
          </span>
          {journals ? (
            <select
              value={value ?? ''}
              disabled={busy}
              onChange={(event) => void choose(event.target.value || null)}
            >
              <option value="">最近写过的日记本</option>
              {journals.map((journal) => (
                <option key={journal.id} value={journal.id}>
                  {journal.title}
                </option>
              ))}
            </select>
          ) : (
            !error && <Spinner />
          )}
        </label>
      </div>
      <p className="field-hint">
        {journals && !journals.length
          ? '还没有日记本。新建日记本后可在这里选择。'
          : '长按页间图标的「今日记」把记录写入所选日记本的今天。'}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
