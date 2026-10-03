import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AuthStatus } from '../../shared/types';
import { MIN_PASSWORD_LENGTH, preparePassword } from '../../shared/password';
import { Brand } from './Brand';
import { ThemeSwitcher } from './ThemePicker';

export function AuthScreen({
  status,
  token,
  onSuccess,
}: {
  status: AuthStatus;
  token: string;
  onSuccess: () => Promise<boolean>;
}) {
  const setup = !status.initialized;
  const [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [forgot, setForgot] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (setup && password !== repeat) {
      setError('两次输入的密码不一致。');
      return;
    }
    setBusy(true);
    try {
      const current = await api<AuthStatus>('/api/auth/status');
      await api(`/api/auth/${setup ? 'setup' : 'login'}`, 'POST', {
        password: await preparePassword(password, setup ? undefined : current.password),
        ...(setup ? { token } : {}),
      });
      setPassword('');
      setRepeat('');
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-screen">
      <div className="auth-theme">
        <ThemeSwitcher />
      </div>
      <div className="auth-form-area">
        <form onSubmit={submit} className="auth-form">
          <Brand name={status.name} />
          <h1>{setup ? '设置密码' : '登录'}</h1>
          {setup && !token ? (
            <p className="inline-error">请使用部署时生成的专属设置链接，完成第一次密码设置。</p>
          ) : (
            <>
              <label>
                {setup ? '设置密码' : '密码'}
                <input
                  autoFocus
                  type="password"
                  autoComplete={setup ? 'new-password' : 'current-password'}
                  required
                  minLength={setup ? MIN_PASSWORD_LENGTH : undefined}
                  maxLength={256}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={setup ? `至少 ${MIN_PASSWORD_LENGTH} 个字符` : undefined}
                  disabled={busy}
                />
              </label>
              {setup && (
                <label>
                  确认密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={256}
                    required
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              <button className="button primary auth-submit" disabled={busy}>
                {busy ? '正在验证…' : setup ? '创建笔记库' : '打开笔记库'}
              </button>
            </>
          )}
          {!setup && (
            <button
              type="button"
              className="text-button forgot-button"
              onClick={() => setForgot((value) => !value)}
            >
              忘记密码？
            </button>
          )}
          {forgot && (
            <p className="field-hint">在部署端重置密码，使用新的设置链接登录。笔记和文件会保留。</p>
          )}
        </form>
      </div>
    </main>
  );
}
