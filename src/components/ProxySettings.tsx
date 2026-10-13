import { useState } from 'react';
import { CircleAlert, Network } from 'lucide-react';
import {
  enableProxy,
  hasNativeProxy,
  retryProxy,
  saveProxySubscription,
  selectProxyNode,
  selectProxyAutomatically,
  setProxyBypassOnVpn,
  proxyMessage,
  subscriptionError,
  updateProxySubscription,
  useProxyState,
  useProxySubscription,
} from '../proxy';
import { Modal } from './Primitives';
import '../proxy.css';

const labels = {
  off: '已关闭，使用直连',
  starting: '正在启动…',
  running: '已开启',
  reconnecting: '连接中断，正在重连…',
  failed: '代理不可用，当前使用直连',
};

export function ProxySettings() {
  const state = useProxyState();
  const subscription = useProxySubscription();
  const [url, setUrl] = useState(subscription.url);
  const [updateInterval, setUpdateInterval] = useState(String(subscription.updateIntervalMinutes));
  const [testInterval, setTestInterval] = useState(String(subscription.testIntervalMinutes));
  const [editingSubscription, setEditingSubscription] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!hasNativeProxy()) return <p className="field-hint">网络代理仅在 Android 应用中提供。</p>;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch {
      setError('操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const locked = busy || subscription.updating || subscription.testing;
  const message = proxyMessage(state);
  const inUse = subscription.nodes.find((node) => node.selected);

  return (
    <section className="settings-section">
      <h2>
        <Network size={19} />
        网络代理
      </h2>
      <div className="setting-row">
        <div>
          <strong>应用内代理</strong>
          <p>{labels[state.phase]}</p>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="应用内代理"
            checked={state.enabled}
            disabled={busy || subscription.updating || state.phase === 'starting'}
            onChange={(event) => void run(() => enableProxy(event.target.checked))}
          />
          <span className="toggle-switch-track" aria-hidden="true" />
        </label>
      </div>
      <div className="setting-row">
        <div>
          <strong>连接 VPN 时直连</strong>
          <p>{state.pausedByVpn ? '已连接 VPN，代理已暂停' : '开启 VPN 后不使用应用内代理'}</p>
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
      {message && <p className="field-hint">{message}</p>}
      {error && !editingSubscription && <p className="field-hint" role="alert">{error}</p>}

      <div className="proxy-actions proxy-subscription-actions">
        <button
          className="button"
          disabled={locked}
          onClick={() => {
            setUrl(subscription.url);
            setUpdateInterval(String(subscription.updateIntervalMinutes));
            setTestInterval(String(subscription.testIntervalMinutes));
            setError('');
            setEditingSubscription(true);
          }}
        >
          {subscription.url ? '更换订阅' : '添加订阅'}
        </button>
        <button className="button" disabled={locked || !subscription.url} onClick={() => void run(updateProxySubscription)}>
          {subscription.updating ? '更新中…' : '立即更新'}
        </button>
      </div>
      {state.phase === 'failed' && (
        <button className="button" disabled={locked} onClick={() => void run(retryProxy)}>
          重试启动
        </button>
      )}

      {editingSubscription && (
        <Modal title={subscription.url ? '更换订阅' : '添加订阅'} onClose={() => {
          if (!locked) setEditingSubscription(false);
        }}>
          <form className="proxy-form" onSubmit={(event) => {
            event.preventDefault();
            if (locked || !url.trim()) return;
            void run(async () => {
              const updateIntervalMinutes = Number(updateInterval), testIntervalMinutes = Number(testInterval);
              if (!Number.isInteger(updateIntervalMinutes) || updateIntervalMinutes < 15 || updateIntervalMinutes > 2147483647
                || !Number.isInteger(testIntervalMinutes) || testIntervalMinutes < 1 || testIntervalMinutes > 2147483647) {
                setError(subscriptionError('INVALID_INTERVAL'));
                return;
              }
              const next = await saveProxySubscription({ url: url.trim(), updateIntervalMinutes, testIntervalMinutes });
              if (!next.subscription.error) setEditingSubscription(false);
            });
          }}>
            <label>
              订阅地址
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
                required
                disabled={locked}
              />
            </label>
            <label>
              订阅更新间隔（分钟）
              <input type="number" min={15} max={2147483647} step={1} required value={updateInterval}
                disabled={locked} onChange={(event) => setUpdateInterval(event.target.value)} />
            </label>
            <label>
              连通性测试间隔（分钟）
              <input type="number" min={1} max={2147483647} step={1} required value={testInterval}
                disabled={locked} onChange={(event) => setTestInterval(event.target.value)} />
            </label>
            <p className="field-hint">保存后点击「立即更新」下载订阅。</p>
            {error && <p className="field-hint" role="alert">{error}</p>}
            {subscription.error && <p className="field-hint" role="alert">{subscriptionError(subscription.error)}</p>}
            <div className="dialog-actions">
              <button type="button" className="button" disabled={locked} onClick={() => setEditingSubscription(false)}>取消</button>
              <button type="submit" className="button primary" disabled={locked || !url.trim()}>
                {busy ? '保存中…' : '保存订阅'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {((subscription.error && !editingSubscription) || subscription.updating) && (
        <p className="field-hint">{subscriptionError(subscription.error) || '正在更新订阅…'}</p>
      )}
      {subscription.nodes.length > 0 && (
        <div className="proxy-nodes">
          <label>
            节点
            <select aria-label="节点" value={subscription.manualIndex} disabled={locked}
              onChange={(event) => {
                const index = Number(event.target.value);
                void run(index < 0 ? selectProxyAutomatically : () => selectProxyNode(index));
              }}>
              <option value={-1}>自动</option>
              {subscription.nodes.map((node, index) => (
                <option key={node.id} value={index}>{node.name}</option>
              ))}
            </select>
          </label>
          {subscription.fallback && inUse && (
            <p className="field-hint" role="status">所选节点不可用，暂用 {inUse.name}，恢复后自动切回。</p>
          )}
        </div>
      )}
      {subscription.testing && <p className="field-hint" role="status">正在检测节点连通性…</p>}
      {!subscription.testing && subscription.testError && <p className="field-hint" role="status">{subscription.testError === 'CONNECTIVITY_SLOW' ? '当前节点延迟较高。' : '节点连通性检测失败，请检查网络。'}</p>}
    </section>
  );
}

/** A quiet, persistent indicator; details appear only when the user opens it. */
export function ProxyStatus() {
  const state = useProxyState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!hasNativeProxy() || state.phase !== 'failed') return null;
  return (
    <aside className="proxy-status">
      <button
        className="icon-button proxy-warning"
        aria-label="代理不可用，当前使用直连"
        title="代理不可用，当前使用直连"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CircleAlert size={19} />
      </button>
      {open && (
        <div className="proxy-details">
          <strong>当前使用直连</strong>
          <p>{proxyMessage(state)}</p>
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
                setError('重试未完成，请再试一次。');
              } finally {
                setBusy(false);
              }
            }}
          >
            重试启动
          </button>
        </div>
      )}
    </aside>
  );
}
