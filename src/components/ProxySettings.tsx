import { useEffect, useState } from 'react';
import { CircleAlert, Network } from 'lucide-react';
import {
  addressError,
  enableProxy,
  hasNativeProxy,
  proxyError,
  proxyLabel,
  retryProxy,
  setProxyBypassOnVpn,
  setProxyUrl,
  useProxyState,
} from '../proxy';
import '../proxy.css';

const time = (millis: number) =>
  new Date(millis).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

export function ProxySettings() {
  const state = useProxyState();
  const [url, setUrl] = useState(state.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A saved address comes back normalized and replaces the draft; other status events leave it.
  useEffect(() => setUrl(state.url), [state.url]);

  if (!hasNativeProxy()) return <p className="field-hint">网络代理仅在 Android 应用中提供。</p>;

  const run = async (
    action: () => Promise<unknown>,
    failure: (caught: unknown) => string = () => '操作未完成，请重试。',
  ) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() => setProxyUrl(url.trim()), (caught) =>
      addressError((caught as { code?: string } | undefined)?.code ?? ''));
  const dirty = url.trim() !== state.url;
  const reason = state.route === 'direct' ? proxyError(state.error) : '';

  return (
    <section className="settings-section">
      <h2>
        <Network size={19} />
        网络代理
      </h2>
      <div className="setting-row">
        <div>
          <strong>使用代理</strong>
          <p>{proxyLabel(state)}</p>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="使用代理"
            checked={state.enabled}
            disabled={busy || (!state.enabled && !state.url)}
            onChange={(event) => void run(() => enableProxy(event.target.checked))}
          />
          <span className="toggle-switch-track" aria-hidden="true" />
        </label>
      </div>
      <form
        className="proxy-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && dirty) void save();
        }}
      >
        <label>
          代理地址
          <input
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="socks5://127.0.0.1:7890"
            disabled={busy}
          />
        </label>
        <p className="field-hint">支持 socks5:// 和 http://，只写“地址:端口”时按 SOCKS5 处理；不支持用户名和密码。</p>
        <div className="proxy-actions">
          <button type="submit" className="button" disabled={busy || !dirty}>
            {busy && dirty ? '保存中…' : '保存地址'}
          </button>
          {state.enabled && state.url && state.route !== 'vpn' && (
            <button type="button" className="button" disabled={busy || state.route === 'checking'}
              onClick={() => void run(retryProxy)}>
              检测
            </button>
          )}
        </div>
      </form>
      <div className="setting-row">
        <div>
          <strong>连接 VPN 时直连</strong>
          <p>{state.route === 'vpn' ? '已连接 VPN，代理已暂停' : '开启 VPN 后不使用代理'}</p>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="连接 VPN 时直连"
            checked={state.bypassOnVpn}
            disabled={busy || !state.enabled}
            onChange={(event) => void run(() => setProxyBypassOnVpn(event.target.checked))}
          />
          <span className="toggle-switch-track" aria-hidden="true" />
        </label>
      </div>
      {reason && (
        <p className="field-hint" role="status">
          {reason}
          {state.checkedAt > 0 && `（上次检测 ${time(state.checkedAt)}）`}
        </p>
      )}
      {error && <p className="field-hint" role="alert">{error}</p>}
    </section>
  );
}

/** A quiet, persistent indicator while traffic goes direct; details appear only when opened. */
export function ProxyStatus() {
  const state = useProxyState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!hasNativeProxy() || state.route !== 'direct') return null;
  return (
    <aside className="proxy-status">
      <button
        className="icon-button proxy-warning"
        aria-label="代理无法连接，当前使用直连"
        title="代理无法连接，当前使用直连"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CircleAlert size={19} />
      </button>
      {open && (
        <div className="proxy-details">
          <strong>当前使用直连</strong>
          <p>{proxyError(state.error) || '代理无法连接。'}代理恢复后会自动切回。</p>
          {error && <p>{error}</p>}
          <button
            className="text-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await retryProxy();
              } catch {
                setError('检测未完成，请再试一次。');
              } finally {
                setBusy(false);
              }
            }}
          >
            重新检测
          </button>
        </div>
      )}
    </aside>
  );
}
