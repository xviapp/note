import { useEffect, useState, type FormEvent } from 'react';
import { getServer, nativeServer, setServer, type ServerInfo } from '../server';

export function useServer() {
  const [server, setValue] = useState<ServerInfo | null>(null);
  useEffect(() => {
    if (!nativeServer) return;
    let live = true;
    getServer()
      .then((value) => {
        if (live) setValue(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return [server, setValue] as const;
}

// Choose the server. Another server restarts the app; its login and offline
// copies are kept apart from this one's.
export function ServerForm({
  server,
  submitLabel = '保存',
  onSaved,
  onCancel,
}: {
  server: ServerInfo;
  submitLabel?: string;
  onSaved?: (server: ServerInfo) => void;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState(`https://${server.host}`);
  const [busy, setBusy] = useState(false),
    [restarting, setRestarting] = useState(false),
    [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await setServer(url);
      if (result.restarting) setRestarting(true);
      else {
        setBusy(false);
        onSaved?.({ ...server, host: result.host, configured: true });
      }
    } catch (e) {
      setError((e as Error).message || '服务器地址不正确。');
      setBusy(false);
    }
  };
  return (
    <form className="form-stack server-form" onSubmit={(event) => void save(event)}>
      <label>
        服务器地址
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={`https://${server.defaultHost}`}
          disabled={busy}
        />
        <span className="field-hint">
          填写部署页间的 https
          站点地址。更换后应用会重新打开，需要在新服务器上登录；各服务器的登录状态和离线缓存分开保存。
        </span>
      </label>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {url !== `https://${server.defaultHost}` && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => setUrl(`https://${server.defaultHost}`)}
          >
            恢复默认
          </button>
        )}
        {onCancel && (
          <button type="button" className="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
        )}
        <button className="button primary" disabled={busy}>
          {restarting ? '正在切换…' : busy ? '正在保存…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function ServerSettings() {
  const [server, setValue] = useServer();
  if (!server) return null;
  return (
    <section className="settings-section">
      <p className="field-hint">当前服务器：{server.host}</p>
      <ServerForm server={server} onSaved={setValue} />
    </section>
  );
}
