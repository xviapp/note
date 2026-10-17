import { Check, Delete } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
              ? `打开页间时输入 ${state.pinLength} 位 PIN`
              : '打开页间时需要输入 PIN'}
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
                  ? '用指纹代替 PIN 解锁'
                  : '未录入指纹，可在系统设置中添加'}
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
              <p>离开页间多久后需要重新解锁</p>
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
          pinLength={state.pinLength}
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

type Step = 'current' | 'pin' | 'repeat';
const STEPS: Record<Dialog, Step[]> = { set: ['pin', 'repeat'], change: ['current', 'pin', 'repeat'], off: ['current'] };
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'next', '0', 'delete'];
const MIN = 4, MAX = 6;

// Each PIN is typed on a number pad like the lock screen's, one step at a time:
// the current PIN (its length is known, so it is taken when complete), the new
// one (4 to 6 digits, taken at 6 or on 下一步) and the new one again.
function PinDialog({ kind, pinLength, onClose, onDone }: {
  kind: Dialog;
  pinLength: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const steps = STEPS[kind];
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<Step, string>>({ current: '', pin: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const name = steps[step];
  const typed = values[name];
  const length = name === 'current' ? pinLength : name === 'repeat' ? values.pin.length : 0;
  const prompt = {
    current: '输入当前 PIN',
    pin: kind === 'change' ? '输入新 PIN' : '输入 PIN',
    repeat: kind === 'change' ? '再次输入新 PIN' : '再次输入 PIN',
  }[name];
  const fail = (text: string, back: Step) => {
    setError(text);
    setShake((n) => n + 1);
    const from = steps.indexOf(back);
    setValues((old) => {
      const next = { ...old };
      for (const s of steps.slice(from)) next[s] = '';
      return next;
    });
    setStep(from);
  };
  const save = async (done: Record<Step, string>) => {
    setBusy(true);
    try {
      await native((plugin) =>
        kind === 'off'
          ? plugin.appLockDisable({ current: done.current })
          : plugin.appLockSetPin(kind === 'change' ? { pin: done.pin, current: done.current } : { pin: done.pin }),
      );
      await onDone();
    } catch (e) {
      setBusy(false);
      fail(message(e), steps[0]);
    }
  };
  const finish = (done: Record<Step, string>) => {
    if (name === 'repeat' && done.repeat !== done.pin) return fail('两次输入的 PIN 不一致，请重新输入。', 'pin');
    if (step + 1 < steps.length) return setStep(step + 1);
    void save(done);
  };
  const press = (key: string) => {
    if (busy) return;
    if (key === 'delete') return setValues({ ...values, [name]: typed.slice(0, -1) });
    if (key === 'next') return typed.length >= MIN && finish(values);
    if (typed.length >= (length || MAX)) return;
    setError('');
    const done = { ...values, [name]: typed + key };
    setValues(done);
    if (done[name].length === (length || MAX)) finish(done);
  };
  const pressed = useRef(press);
  pressed.current = press;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = /^\d$/.test(event.key) ? event.key
        : event.key === 'Backspace' ? 'delete' : event.key === 'Enter' ? 'next' : '';
      if (!key) return;
      event.preventDefault();
      pressed.current(key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Modal title={titles[kind]} className="pin-modal" onClose={() => !busy && onClose()}>
      <div className="pin-entry">
        <p className="pin-prompt">{prompt}</p>
        <div
          key={shake}
          className={`pin-dots${shake ? ' shake' : ''}`}
          role="status"
          aria-label={`已输入 ${typed.length} 位`}
        >
          {Array.from({ length: length || Math.max(MIN, Math.min(MAX, typed.length + 1)) }, (_, i) => (
            <span key={i} className={i < typed.length ? 'filled' : ''} />
          ))}
        </div>
        <p className={error ? 'inline-error' : 'field-hint'} role={error ? 'alert' : undefined}>
          {error || (name === 'pin' ? '4 到 6 位数字，只用于这台设备' : ' ')}
        </p>
        <div className="pin-pad">
          {KEYS.map((key) =>
            key === 'next' ? (
              name === 'pin' ? (
                <button key={key} className="pin-key pin-key-icon" aria-label="下一步"
                  disabled={busy || typed.length < MIN} onClick={() => press(key)}>
                  <Check size={24} />
                </button>
              ) : (
                <span key={key} />
              )
            ) : key === 'delete' ? (
              <button key={key} className="pin-key pin-key-icon" aria-label="删除"
                disabled={busy || !typed} onClick={() => press(key)}>
                <Delete size={24} />
              </button>
            ) : (
              <button key={key} className="pin-key" disabled={busy} onClick={() => press(key)}>
                {key}
              </button>
            ),
          )}
        </div>
      </div>
    </Modal>
  );
}
