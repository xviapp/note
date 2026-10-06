import { useState } from 'react';
import { CircleAlert, Network } from 'lucide-react';
import { enableProxy, hasNativeProxy, nativeProxy, retryProxy, useProxyState } from '../proxy';
import '../proxy.css';

const labels = { off: '已关闭，使用直连', starting: '正在启动…', running: '已开启，按规则分流', failed: '代理不可用，当前使用直连' };
export function ProxySettings() {
  const state = useProxyState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!hasNativeProxy()) return <p className="field-hint">网络代理仅在 Android 应用中提供。</p>;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await action(); }
    catch { setError('操作未完成，请重试。'); }
    finally { setBusy(false); }
  };
  return (
    <section className="settings-section">
      <h2><Network size={19} />网络代理</h2>
      <div className="setting-row">
        <div><strong>应用内代理</strong><p>{labels[state.phase]}</p></div>
        <label className="proxy-toggle">
          <input type="checkbox" checked={state.enabled} disabled={busy || state.phase === 'starting'}
            onChange={(event) => void run(() => enableProxy(event.target.checked))} />
          开启
        </label>
      </div>
      {state.message && <p className="field-hint">{state.message}</p>}
      {!state.hasProfile && <p className="field-hint">请先在配置中导入订阅或节点，并选择一个节点。</p>}
      <div className="proxy-actions">
        <button className="button" disabled={busy} onClick={() => void run(() => nativeProxy.openConfiguration())}>节点、订阅与完整配置</button>
        {state.phase === 'failed' && <button className="button" disabled={busy} onClick={() => void run(retryProxy)}>重试启动</button>}
      </div>
      {error && <p className="field-hint">{error}</p>}
      <p className="field-hint">开启后，页间的联网请求统一按路由规则选择直连、代理或阻止。核心启动失败或停止运行时自动使用直连；节点连接失败时遵守原规则。</p>
      <p className="field-hint">配置保存在当前手机。可在完整配置中单独备份与恢复，不随笔记同步。</p>
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
      <button className="icon-button proxy-warning" aria-label="代理不可用，当前使用直连" title="代理不可用，当前使用直连"
        aria-expanded={open} onClick={() => setOpen(!open)}><CircleAlert size={19} /></button>
      {open && <div className="proxy-details">
        <strong>当前使用直连</strong>
        <p>{state.message}</p>
        {error && <p>{error}</p>}
        <div className="proxy-actions">
          <button className="text-button" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try { await retryProxy(); } catch { setError('重试未完成，请再试一次。'); } finally { setBusy(false); }
          }}>重试启动</button>
          <button className="text-button" onClick={() => void nativeProxy.openConfiguration().catch(() => setError('无法打开配置，请重试。'))}>代理配置</button>
        </div>
      </div>}
    </aside>
  );
}
