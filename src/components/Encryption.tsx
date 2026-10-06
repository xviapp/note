import { useState, type FormEvent } from 'react';
import { KeyRound, LockKeyhole } from 'lucide-react';
import { api, formatDate } from '../api';
import { MIN_ENCRYPTION_PASSWORD } from '../../shared/encryption';
import type { Crumb, NoteDetail } from '../../shared/types';
import {
  createKey,
  defaultPolicy,
  isUnlocked,
  KEEP_OPTIONS,
  lock,
  lockAll,
  policyKey,
  policyLabel,
  rewrap,
  setDefaultPolicy,
  unlock,
  unlockedEntries,
  type KeepPolicy,
} from '../keyring';
import { syncEncryption, type SyncResult } from '../encryption-sync';
import { Modal } from './Primitives';
import { LockBadge, useKeys } from './LockBadge';

// Re-renders when a key is unlocked, locked or expires.
export { useKeys };

function KeepSelect({
  value,
  onChange,
  disabled,
}: {
  value: KeepPolicy;
  onChange: (policy: KeepPolicy) => void;
  disabled?: boolean;
}) {
  return (
    <label>
      在本设备上
      <select
        value={policyKey(value)}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            KEEP_OPTIONS.find((option) => policyKey(option.policy) === event.target.value)!.policy,
          )
        }
      >
        {KEEP_OPTIONS.map((option) => (
          <option key={policyKey(option.policy)} value={policyKey(option.policy)}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// The title of the node whose password a key is, from a note's path.
export function keyOwner(path: Crumb[], keyId: string) {
  return [...path].reverse().find((part) => part.encryption === keyId)?.title ?? '';
}

export function UnlockForm({
  keyId,
  owner,
  onUnlocked,
}: {
  keyId: string;
  owner?: string;
  onUnlocked?: () => void;
}) {
  const [password, setPassword] = useState(''),
    [policy, setPolicy] = useState(defaultPolicy),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await unlock(keyId, password, policy);
      setPassword('');
      onUnlocked?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form-stack unlock-form" onSubmit={submit}>
      <label>
        {owner ? `「${owner}」的密码` : '密码'}
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <KeepSelect value={policy} onChange={setPolicy} disabled={busy} />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button primary" disabled={busy || !password}>
          {busy ? '正在解锁…' : '解锁'}
        </button>
      </div>
    </form>
  );
}

// Shown in place of a note whose key is not unlocked on this device.
export function LockedNote({ note, keyId }: { note: NoteDetail; keyId: string }) {
  return (
    <section className="locked-note">
      <LockKeyhole size={28} aria-hidden="true" />
      <h2>此内容已加密</h2>
      <p>输入密码后在本设备上解密。密码不会上传。</p>
      <UnlockForm keyId={keyId} owner={keyOwner(note.breadcrumbs, keyId)} />
    </section>
  );
}

function SyncReport({
  result,
  path,
  onRetry,
}: {
  result: SyncResult;
  path: Crumb[];
  onRetry: () => void;
}) {
  if (!result.locked.length && !result.failed.length) return null;
  return (
    <div className="encryption-report">
      {result.locked.map((keyId) => (
        <div key={keyId}>
          <p>部分内容仍使用另一个密码加密，解锁后才能继续：</p>
          {isUnlocked(keyId) ? null : (
            <UnlockForm keyId={keyId} owner={keyOwner(path, keyId)} onUnlocked={onRetry} />
          )}
        </div>
      ))}
      {result.failed.length > 0 && (
        <p className="inline-error" role="alert">
          {result.failed.length} 项未完成：{result.failed.slice(0, 3).join('；')}
        </p>
      )}
    </div>
  );
}

type Step = 'overview' | 'set' | 'change';
// A note's encryption: its own password, inheriting, or plain text below it.
export function EncryptionDialog({
  note,
  onClose,
  onChanged,
}: {
  note: NoteDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  useKeys();
  const [current, setCurrent] = useState(note);
  const [step, setStep] = useState<Step>('overview'),
    [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [old, setOld] = useState(''),
    [policy, setPolicy] = useState(defaultPolicy),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [result, setResult] = useState<SyncResult | null>(null);
  const own = current.encryption ?? null;
  const ownKey = own && own !== 'none' ? own : null;
  const ancestors = current.breadcrumbs.slice(0, -1);
  const inherited = [...ancestors].reverse().find((part) => part.encryption);
  const parentKey = inherited && inherited.encryption !== 'none' ? inherited.encryption! : null;
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const sync = () =>
    run('正在同步加密…', async () => {
      const outcome = await syncEncryption(current.id, (done) => setBusy(`正在处理第 ${done} 项…`));
      setResult(outcome);
      onChanged();
    });
  const setting = (encryption: string | null) =>
    run('正在保存设置…', async () => {
      const fresh = await api<NoteDetail>(`/api/nodes/${current.id}/encryption`, 'PUT', {
        encryption,
      });
      setCurrent({
        ...current,
        ...fresh,
        breadcrumbs: current.breadcrumbs.map((part) =>
          part.id === current.id ? { ...part, encryption } : part,
        ),
      });
      setStep('overview');
      const outcome = await syncEncryption(current.id, (done) => setBusy(`正在处理第 ${done} 项…`));
      setResult(outcome);
      onChanged();
    });
  const validNew = password.length >= MIN_ENCRYPTION_PASSWORD && password === repeat;
  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    if (!validNew) return;
    void run('正在生成密钥…', async () => {
      const created = await createKey(password, policy);
      await api('/api/encryption/keys', 'POST', created.record);
      created.commit();
      setPassword('');
      setRepeat('');
      await setting(created.record.id);
    });
  };
  const submitChange = (event: FormEvent) => {
    event.preventDefault();
    if (!validNew || !ownKey) return;
    void run('正在修改密码…', async () => {
      const next = await rewrap(ownKey, isUnlocked(ownKey) ? null : old, password);
      await api(`/api/encryption/keys/${ownKey}`, 'PUT', next.fields);
      next.commit();
      setPassword('');
      setRepeat('');
      setOld('');
      setStep('overview');
      setResult({ done: 0, locked: [], failed: [] });
    });
  };
  const status = ownKey
    ? '已加密，下级条目使用同一密码。'
    : own === 'none'
      ? '此条目及下级不加密。'
      : parentKey
        ? `已加密，使用「${inherited!.title}」的密码。`
        : '未加密。';
  return (
    <Modal title="本地加密" onClose={() => !busy && onClose()}>
      <div className="form-stack encryption-dialog">
        <p className="encryption-status">
          {current.key_id ? <LockBadge keyId={current.key_id} size={16} /> : <KeyRound size={16} />}
          {status}
        </p>
        {step === 'overview' && (
          <>
            <p className="field-hint">内容在本设备加密后再上传，标题不加密。密码不会上传。</p>
            <div className="encryption-choices">
              {!ownKey && (
                <button className="button primary" disabled={!!busy} onClick={() => setStep('set')}>
                  设置密码
                </button>
              )}
              {ownKey && (
                <button className="button" disabled={!!busy} onClick={() => setStep('change')}>
                  修改密码
                </button>
              )}
              {ownKey && (
                <button className="button" disabled={!!busy} onClick={() => setting(null)}>
                  {parentKey ? '改为使用上级密码' : '取消加密'}
                </button>
              )}
              {parentKey && own !== 'none' && (
                <button className="button" disabled={!!busy} onClick={() => setting('none')}>
                  此条目不加密
                </button>
              )}
              {own === 'none' && (
                <button className="button" disabled={!!busy} onClick={() => setting(null)}>
                  恢复继承上级
                </button>
              )}
              {current.key_id && isUnlocked(current.key_id) && (
                <button className="button" disabled={!!busy} onClick={() => lock(current.key_id!)}>
                  立即锁定
                </button>
              )}
              <button className="button" disabled={!!busy} onClick={sync}>
                检查并同步
              </button>
            </div>
          </>
        )}
        {(step === 'set' || step === 'change') && (
          <form className="form-stack" onSubmit={step === 'set' ? submitNew : submitChange}>
            {step === 'change' && ownKey && !isUnlocked(ownKey) && (
              <label>
                当前密码
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={old}
                  onChange={(event) => setOld(event.target.value)}
                />
              </label>
            )}
            <label>
              {step === 'set' ? '密码' : '新密码'}
              <input
                type="password"
                autoComplete="new-password"
                autoFocus
                minLength={MIN_ENCRYPTION_PASSWORD}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              再次输入
              <input
                type="password"
                autoComplete="new-password"
                required
                value={repeat}
                onChange={(event) => setRepeat(event.target.value)}
              />
            </label>
            {repeat && password !== repeat && <p className="field-hint">两次输入的密码不一致。</p>}
            {step === 'set' && <KeepSelect value={policy} onChange={setPolicy} />}
            <p className="field-hint">
              {step === 'set'
                ? `至少 ${MIN_ENCRYPTION_PASSWORD} 个字符。忘记密码将无法恢复内容。`
                : '其他设备需要用新密码重新解锁。'}
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => setStep('overview')}
              >
                返回
              </button>
              <button className="button primary" disabled={!!busy || !validNew}>
                {step === 'set' ? '设置并加密' : '修改密码'}
              </button>
            </div>
          </form>
        )}
        {busy && <p role="status">{busy}</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {result && !busy && (
          <>
            {!result.locked.length && !result.failed.length && (
              <p role="status">
                {result.done ? `已处理 ${result.done} 项内容。` : '设置已保存，内容已是最新状态。'}
              </p>
            )}
            <SyncReport result={result} path={current.breadcrumbs} onRetry={sync} />
          </>
        )}
        {step === 'overview' && (
          <div className="dialog-actions">
            <button className="button" disabled={!!busy} onClick={onClose}>
              完成
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// Settings: how long keys stay unlocked here, and locking them now.
export function EncryptionSettings() {
  useKeys();
  const [policy, setPolicy] = useState(defaultPolicy);
  const entries = unlockedEntries();
  return (
    <section className="settings-section">
      <h2>
        <LockKeyhole size={19} />
        本地加密
      </h2>
      <p className="field-hint">在条目的 ⋯ 菜单中选择「本地加密」设置密码。</p>
      <div className="form-stack">
        <KeepSelect
          value={policy}
          onChange={(next) => {
            setPolicy(next);
            setDefaultPolicy(next);
          }}
        />
        <p className="field-hint">解锁时的默认选项。</p>
      </div>
      <h3>本设备已解锁 {entries.length}</h3>
      {entries.length ? (
        <ul className="unlocked-keys">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span>
                <code>{entry.id.slice(0, 8)}</code>
                <small>
                  {formatDate(entry.unlockedAt)} 解锁 · {policyLabel(entry.policy)}
                </small>
              </span>
              <button className="button compact" onClick={() => lock(entry.id)}>
                锁定
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">没有已解锁的密码。</p>
      )}
      <button className="button" disabled={!entries.length} onClick={() => lockAll()}>
        全部锁定
      </button>
    </section>
  );
}
