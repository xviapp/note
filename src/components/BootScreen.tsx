import { useEffect, useState } from 'react';
import { hasNativeProxy, nativeProxy } from '../proxy';
import { nativeServer } from '../server';
import { ServerForm, useServer } from './ServerSettings';
import { Modal } from './Primitives';

// After this long, add a line saying we are still connecting.
const SLOW_MS = 4000;

// The first screen while the session is checked; on Android it follows the splash.
export function BootScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  const [slow, setSlow] = useState(false),
    [serverOpen, setServerOpen] = useState(false);
  useEffect(() => {
    if (error) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [error]);
  return (
    <div className="boot-screen">
      <div className={`boot-mark${error ? '' : ' is-loading'}`}>
        <img src="/brand/day-192.png" width="88" height="88" alt="" draggable={false} />
      </div>
      <h1 className="boot-name">页间</h1>
      {error ? (
        <>
          <p className="inline-error" role="alert">
            {error}
          </p>
          <button className="button" onClick={onRetry}>
            重新连接
          </button>
          {/* A wrong address at first launch must not leave the app stuck here. */}
          {nativeServer && (
            <button className="text-button" onClick={() => setServerOpen(true)}>
              更换服务器
            </button>
          )}
          {serverOpen && <ServerDialog onClose={() => setServerOpen(false)} onSaved={onRetry} />}
          {hasNativeProxy() && (
            <button
              className="text-button proxy-boot-settings"
              onClick={() => void nativeProxy.openConfiguration()}
            >
              网络代理配置
            </button>
          )}
        </>
      ) : (
        <div className="boot-status" role="status">
          <span>正在加载</span>
          <span className="boot-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {/* Shown from React state, not a CSS delay, so reduced motion keeps it. */}
          {slow && <small>网络较慢，仍在连接…</small>}
        </div>
      )}
    </div>
  );
}

function ServerDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [server] = useServer();
  return (
    <Modal title="更换服务器" onClose={onClose}>
      {server && (
        <ServerForm
          server={server}
          onCancel={onClose}
          onSaved={() => {
            onClose();
            onSaved();
          }}
        />
      )}
    </Modal>
  );
}
