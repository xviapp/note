import { useEffect, useRef, useState } from 'react';
import { Palette, HardDrive, LogOut, RotateCcw, ShieldCheck, Type } from 'lucide-react';
import { api, formatBytes } from '../api';
import { type AuthStatus, type StorageInfo } from '../../shared/types';
import { Modal, Spinner } from './Primitives';
import { ThemeChoices } from './ThemePicker';
import { setInkMode, useTheme } from '../theme';
import { MIN_PASSWORD_LENGTH, preparePassword } from '../../shared/password';
import { AiSettings } from './AiSettings';
import { EncryptionSettings } from './Encryption';
import { ReadingControls } from './ReadingSettings';
import { BackupSettings } from './BackupSettings';
import { AppUpdates } from './AppUpdates';
import { CacheSettings } from './OfflineCache';
import { ShareSettings } from './ShareSettings';
import { ProxySettings } from './ProxySettings';
import { ServerSettings } from './ServerSettings';
import { settingsTitles, type SettingsSection } from '../navigation';
import { SettingsIndex } from './SettingsIndex';
import type { Confirm } from './Primitives';

export function Settings({
  section,
  onOpen,
  storage,
  confirm,
  onChanged,
  onLogout,
  onError,
}: {
  section: SettingsSection | null;
  onOpen: (section: SettingsSection) => void;
  storage: StorageInfo | null;
  confirm: Confirm;
  onChanged: () => void;
  onLogout: (all?: boolean) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { ink } = useTheme();
  const [quota, setQuota] = useState(String((storage?.quotaBytes || 8e9) / 1e9)),
    [busy, setBusy] = useState(false),
    [passwordOpen, setPasswordOpen] = useState(false);
  // The breakdown loads after the page opens; fill the field once, so a later
  // refresh never replaces what is being typed.
  const loadedQuota = storage?.quotaBytes;
  const quotaFilled = useRef(false);
  useEffect(() => {
    if (!loadedQuota || quotaFilled.current) return;
    quotaFilled.current = true;
    setQuota(String(loadedQuota / 1e9));
  }, [loadedQuota]);
  const [oldPassword, setOldPassword] = useState(''),
    [newPassword, setNewPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [error, setError] = useState('');
  if (!section) return <SettingsIndex onOpen={onOpen} />;
  return (
    <section className="collection-page settings-page settings-detail">
      <h1>{settingsTitles[section]}</h1>
      {section === 'about' && <AppUpdates />}
      {section === 'proxy' && <ProxySettings />}
      {section === 'server' && <ServerSettings />}
      {section === 'theme' && (
        <section className="settings-section">
          <h2>
            <Palette size={19} />
            外观
          </h2>
          <ThemeChoices />
          <label className="setting-row ink-setting">
            <div>
              <strong>墨水屏模式</strong>
              <p>黑白高对比，关闭动效，减少回复刷新。仅在当前设备生效。</p>
            </div>
            <input
              type="checkbox"
              role="switch"
              aria-label="墨水屏模式"
              checked={ink}
              onChange={(event) => setInkMode(event.target.checked)}
            />
          </label>
          {ink && <p className="field-hint">关闭墨水屏模式后恢复原来的主题。</p>}
        </section>
      )}
      {section === 'reading' && (
        <section className="settings-section">
          <h2>
            <Type size={19} />
            阅读
          </h2>
          <ReadingControls />
        </section>
      )}
      {section === 'offline' && <CacheSettings />}
      {section === 'share' && <ShareSettings />}
      {section === 'backup' && <BackupSettings confirm={confirm} onChanged={onChanged} />}
      {section === 'ai' && <AiSettings confirm={confirm} />}
      {section === 'encryption' && <EncryptionSettings />}
      {section === 'storage' && (
        <section className="settings-section">
          <h2>
            <HardDrive size={19} />
            存储空间
          </h2>
          {storage ? (
            <>
              <div className="usage-heading">
                <strong>{formatBytes(storage.allocatedBytes)}</strong>
                <span> / {formatBytes(storage.quotaBytes)}</span>
              </div>
              <progress value={storage.allocatedBytes} max={storage.quotaBytes} />
              <div className="storage-breakdown">
                {[
                  ['当前内容', storage.currentBytes],
                  ['历史版本', storage.historyBytes],
                  ['回收站', storage.trashBytes],
                  ['等待清理', storage.orphanBytes],
                  ['上传预留', storage.reservedBytes],
                ].map(([label, size]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{formatBytes(Number(size))}</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Spinner />
          )}
          <form
            className="quota-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api('/api/settings', 'PATCH', {
                  quotaBytes: Math.round(Number(quota) * 1e9),
                });
                onChanged();
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              全库容量上限{' '}
              <span className="input-unit">
                <input
                  aria-label="容量上限 GB"
                  type="number"
                  min="0.001"
                  max="1000"
                  step="0.001"
                  value={quota}
                  onChange={(e) => setQuota(e.target.value)}
                />
                <span>GB</span>
              </span>
            </label>
            <button className="button" disabled={busy}>
              更新上限
            </button>
          </form>
          <p className="field-hint">
            容量上限包含历史和回收站；Cloudflare 账号的免费额度由所有项目共享。
          </p>
          <button
            className="text-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/api/cleanup', 'POST', {});
                onChanged();
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RotateCcw size={15} />
            立即执行一批清理
          </button>
        </section>
      )}
      {section === 'account' && (
        <section className="settings-section">
          <h2>
            <ShieldCheck size={19} />
            密码与设备
          </h2>
          <div className="setting-row">
            <div>
              <strong>登录密码</strong>
              <p>修改后，所有设备都需要重新登录。</p>
            </div>
            <button className="button" onClick={() => setPasswordOpen(true)}>
              修改密码
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>所有设备</strong>
              <p>同时结束电脑、手机和当前页面的登录。</p>
            </div>
            <button
              className="button"
              onClick={async () => {
                if (
                  await confirm(
                    '退出所有设备？',
                    '所有设备将在下次访问时要求重新输入密码，当前设备也会退出。',
                    '退出所有设备',
                  )
                )
                  await onLogout(true);
              }}
            >
              退出所有设备
            </button>
          </div>
          <button className="text-button" onClick={() => onLogout()}>
            <LogOut size={16} />
            退出当前设备
          </button>
        </section>
      )}
      {passwordOpen && (
        <Modal
          title="修改密码"
          onClose={() => {
            if (!busy) setPasswordOpen(false);
          }}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              if (newPassword !== repeat) {
                setError('两次输入的新密码不一致。');
                return;
              }
              setBusy(true);
              try {
                const status = await api<AuthStatus>('/api/auth/status');
                const [currentPassword, replacement] = await Promise.all([
                  preparePassword(oldPassword, status.password),
                  preparePassword(newPassword),
                ]);
                await api('/api/auth/password', 'POST', {
                  currentPassword,
                  newPassword: replacement,
                });
                window.dispatchEvent(new Event('note:unauthenticated'));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              当前密码
              <input
                type="password"
                required
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </label>
            <label>
              新密码
              <input
                aria-label="新密码"
                aria-describedby="new-password-hint"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={256}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <span id="new-password-hint" className="field-hint">
                至少 {MIN_PASSWORD_LENGTH} 个字符
              </span>
            </label>
            <label>
              再次输入新密码
              <input
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </label>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => setPasswordOpen(false)}
                disabled={busy}
              >
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? '正在修改…' : '修改并重新登录'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
