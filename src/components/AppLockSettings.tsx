import { useEffect, useState, type FormEvent } from 'react';
import type { AppLockState, device as Device } from '../mobile';
import { Modal } from './Primitives';

// A Capacitor plugin answers any property, `then` included, so it must never
// be what an async function returns: call it where it is imported.
const native = async <T,>(action: (plugin: typeof Device) => Promise<T>) =>
  action((await import('../mobile')).device);
const message = (error: unknown) => (error instanceof Error && error.message) || '操作未完成，请重试。';

const TIMEOUTS: [number, string][] = [
  [0, '立即'],
  [60_000, '1 分钟后'],
  [300_000, '5 分钟后'],
  [1_800_000, '30 分钟后'],
];

type Dialog = 'set' | 'change' | 'off';
const titles: Record<Dialog, string> = { set: '设置 PIN', change: '修改 PIN', off: '关闭应用锁' };

// Android only: a PIN (and optionally a fingerprint) asked for when the
// notebook opens. 随手记, 今日记, 问青藜 and the share window stay open.
export function AppLockSettings() {
  const [state, setState] = useState<AppLockState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => setState(await native((plugin) => plugin.appLockState()));
  useEffect(() => {
    load().catch((e) => setError(message(e)));
  }, []);
  if (!state) return error ? <p className="inline-error" role="alert">{error}</p> : null;
  const change = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-lock-settings">
      <div className="setting-row">
        <div>
          <strong>应用锁</strong>
          <p>
            {state.enabled
              ? `打开页间时输入 ${state.pinLength} 位 PIN。随手记、今日记、问青藜和分享不受影响。`
              : '打开页间时要求输入 PIN。随手记、今日记、问青藜和分享不受影响。'}
          </p>
        </div>
        {state.enabled ? (
          <div className="setting-row-actions">
            <button className="button" onClick={() => setDialog('change')}>
              修改 PIN
            </button>
            <button className="button" onClick={() => setDialog('off')}>
              关闭
            </button>
          </div>
        ) : (
          <button className="button" onClick={() => setDialog('set')}>
            设置 PIN
          </button>
        )}
      </div>
      {state.enabled && (
        <>
          <div className="setting-row">
            <div>
              <strong>指纹解锁</strong>
              <p>
                {state.biometricAvailable
                  ? '锁屏时可以用指纹代替 PIN'
                  : '本机没有可用的指纹，可先在系统设置中录入'}
              </p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="指纹解锁"
                checked={state.biometric}
                disabled={busy || (!state.biometricAvailable && !state.biometric)}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void change(() => native((plugin) => plugin.appLockSetBiometric({ enabled })));
                }}
              />
              <span className="toggle-switch-track" aria-hidden="true" />
            </label>
          </div>
          <div className="setting-row">
            <div>
              <strong>重新上锁</strong>
              <p>离开页间超过这段时间，回来时需要解锁</p>
            </div>
            <select
              aria-label="重新上锁"
              value={state.timeout}
              disabled={busy}
              onChange={(event) => {
                const timeout = Number(event.target.value);
                void change(() => native((plugin) => plugin.appLockSetTimeout({ timeout })));
              }}
            >
              {TIMEOUTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {error && !dialog && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {dialog && (
        <PinDialog
          kind={dialog}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            await load().catch((e) => setError(message(e)));
          }}
        />
      )}
    </div>
  );
}

function PinDialog({ kind, onClose, onDone }: {
  kind: Dialog;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (kind !== 'off') {
      if (!/^\d{4,6}$/.test(pin)) return setError('PIN 需为 4 到 6 位数字。');
      if (pin !== repeat) return setError('两次输入的 PIN 不一致。');
    }
    setBusy(true);
    try {
      await native((plugin) =>
        kind === 'off'
          ? plugin.appLockDisable({ current })
          : plugin.appLockSetPin(kind === 'change' ? { pin, current } : { pin }),
      );
      await onDone();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const field = (label: string, value: string, set: (value: string) => void, autoFocus = false) => (
    <label>
      {label}
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        required
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => set(event.target.value.replace(/\D/g, ''))}
      />
    </label>
  );
  return (
    <Modal title={titles[kind]} onClose={() => !busy && onClose()}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        {kind !== 'set' && field('当前 PIN', current, setCurrent, true)}
        {kind !== 'off' && (
          <>
            {field(kind === 'change' ? '新 PIN' : 'PIN', pin, setPin, kind === 'set')}
            {field(kind === 'change' ? '再次输入新 PIN' : '再次输入 PIN', repeat, setRepeat)}
            <p className="field-hint">4 到 6 位数字，只保存在这台设备上。忘记时只能退出登录后重新设置。</p>
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {kind === 'off' ? '关闭应用锁' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
