import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Download, Info, RefreshCw } from 'lucide-react';
import { version } from '../../package.json';
import { api, formatBytes } from '../api';
import { useOffline } from '../connectivity';
import { releasePath, validRelease, type AndroidRelease } from '../../shared/release';

export function AppUpdates() {
  const android = Capacitor.getPlatform() === 'android';
  const offline = useOffline();
  const [installed, setInstalled] = useState<{
    version: string;
    build: number;
    certificate: string;
  }>();
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (android)
      void import('../mobile')
        .then(({ device }) => device.getBuildInfo())
        .then(setInstalled)
        .catch(() => setMessage('无法读取安装版本，请重新打开应用。'));
  }, [android]);
  const newer = android && release && installed && release.build > installed.build;
  const compatible = !release || installed?.certificate === release.certificate;
  return (
    <section className="settings-section">
      <h2>
        <Info size={19} />
        关于页间
      </h2>
      <div className="setting-row">
        <div>
          <strong>
            {android ? 'Android' : '网页版'} {installed?.version || version}
          </strong>
          {installed && <p>构建 {installed.build}</p>}
        </div>
        {android && (
          <button
            className="button"
            disabled={busy || offline || !installed}
            onClick={async () => {
              setBusy(true);
              setMessage('');
              try {
                const result = await api<{ release: AndroidRelease | null }>(
                  '/api/app/android-release',
                );
                if (result.release && !validRelease(result.release))
                  throw new Error('更新信息不完整，请稍后重试。');
                setRelease(result.release);
                setChecked(true);
              } catch (error) {
                setMessage((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={15} />
            {busy ? '正在处理…' : '检查 Android 更新'}
          </button>
        )}
      </div>
      {checked && !release && <p className="field-hint">暂未发布安装包。</p>}
      {checked && release && !newer && <p role="status">当前已是最新版本。</p>}
      {newer && (
        <div className="update-details">
          <strong>
            页间 {release.version} · {formatBytes(release.size)}
          </strong>
          <p className="update-notes">{release.notes}</p>
          {!compatible && <p role="alert">此安装包使用另一签名，无法直接覆盖当前版本。</p>}
          <button
            className="button"
            disabled={busy || offline || !compatible}
            onClick={async () => {
              setBusy(true);
              setMessage('');
              try {
                const path = releasePath(release);
                const { device } = await import('../mobile');
                const result = await device.saveFile({
                  url: new URL(path, location.href).href,
                  name: `页间-${release.version}.apk`,
                  mime: 'application/vnd.android.package-archive',
                  sha256: release.sha256,
                });
                if (!result.cancelled) setMessage('安装包已校验并保存，打开文件即可安装。');
              } catch (error) {
                setMessage((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Download size={15} />
            下载安装包
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="field-hint">
          {message}
        </p>
      )}
    </section>
  );
}
