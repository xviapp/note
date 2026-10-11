import { useState } from 'react';
import { MIN_ENCRYPTION_PASSWORD } from '../../shared/encryption';
import { api } from '../api';
import { createKey, defaultPolicy, isUnlocked, rewrap } from '../keyring';
import { setClipEncryption } from '../clips';
import { UnlockForm, useKeys } from './Encryption';

// Sets, changes or removes the password of all clips. Existing clips are
// re-sealed here.
export function ClipEncryption({ keyId, onDone }: { keyId: string | null; onDone: () => void }) {
  useKeys();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>, done = true) => {
    setBusy('正在处理…');
    setError('');
    try {
      await action();
      if (done) onDone();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };
  const progress = (count: number) => setBusy(`已处理 ${count} 项…`);
  const valid = password.length >= MIN_ENCRYPTION_PASSWORD && password === repeat;
  const passwordFields = (
    <>
      <label>
        {changing ? '新密码' : '密码'}
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={!!busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <label>
        再次输入
        <input
          type="password"
          autoComplete="new-password"
          value={repeat}
          disabled={!!busy}
          onChange={(event) => setRepeat(event.target.value)}
        />
      </label>
      <p className="field-hint">至少 {MIN_ENCRYPTION_PASSWORD} 位。</p>
    </>
  );
  let content;
  if (!keyId)
    content = (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          void run(async () => {
            const created = await createKey(password, defaultPolicy());
            await api('/api/encryption/keys', 'POST', created.record);
            created.commit();
            await setClipEncryption(created.record.id, progress);
          });
        }}
      >
        <p>设置密码后，随手记在本设备上加密再上传，密码不会上传。忘记密码将无法恢复内容。</p>
        {passwordFields}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={!!busy} onClick={onDone}>
            返回
          </button>
          <button className="button primary" disabled={!!busy || !valid}>
            {busy || '设置密码'}
          </button>
        </div>
      </form>
    );
  else if (!isUnlocked(keyId))
    content = (
      <>
        <p>请先解锁随手记的密码。</p>
        <UnlockForm keyId={keyId} />
        <button className="text-button" onClick={onDone}>
          返回
        </button>
      </>
    );
  else if (changing)
    content = (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          // The same content key under a new password: nothing is re-encrypted.
          void run(async () => {
            const next = await rewrap(keyId, null, password);
            await api(`/api/encryption/keys/${keyId}`, 'PUT', next.fields);
            next.commit();
          });
        }}
      >
        <p>修改密码不需要重新加密内容。其他设备上记住的密码会在下次联网时失效。</p>
        {passwordFields}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            disabled={!!busy}
            onClick={() => setChanging(false)}
          >
            返回
          </button>
          <button className="button primary" disabled={!!busy || !valid}>
            {busy || '修改密码'}
          </button>
        </div>
      </form>
    );
  else
    content = (
      <>
        <p>随手记已加密：内容在本设备上加密后再上传，密码不会上传。</p>
        <p className="field-hint">取消加密后，全部随手记会以明文保存在服务器上。</p>
        <div className="clips-encryption-actions">
          <button className="text-button" disabled={!!busy} onClick={() => setChanging(true)}>
            修改密码
          </button>
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() => void run(() => setClipEncryption(keyId, progress))}
          >
            检查并同步
          </button>
        </div>
        <div className="dialog-actions">
          <button className="button" disabled={!!busy} onClick={onDone}>
            返回
          </button>
          <button
            className="button danger"
            disabled={!!busy}
            onClick={() => void run(() => setClipEncryption(null, progress))}
          >
            {busy || '取消加密'}
          </button>
        </div>
      </>
    );
  return (
    <div className="form-stack clips-encryption">
      {content}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
