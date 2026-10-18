import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { sealedFile } from './encryption';
import { fileBlob } from './offline-cache';
import { sealedFileId } from './sealed-download';

export const device = registerPlugin<{
  pendingWidgetClips(): Promise<{ items: { id: string; text: string; createdAt: number }[] }>;
  sentWidgetClips(): Promise<{ items: { id: string; text: string; sentAt: number }[] }>;
  markWidgetClipSent(options: { id: string; encrypted: boolean }): Promise<void>;
  removeWidgetClip(options: { id: string }): Promise<void>;
  clearWidgetClips(): Promise<void>;
  getPendingShare(): Promise<{ share: import('./shared-import').IncomingShare | null }>;
  discardShare(options: { id: string }): Promise<void>;
  // The share window only: discard its share and close, with a toast once saved,
  // or hand over to the full app.
  closeShare(options: { saved?: boolean; openApp?: boolean }): Promise<void>;
  getBuildInfo(): Promise<{ version: string; build: number; certificate: string }>;
  openExternal(options: { url: string }): Promise<void>;
  setBackground(options: { color: string; preference: string }): Promise<void>;
  notify(options: { message: string }): Promise<void>;
  haptic(): Promise<void>;
  setSelectionToolbar(options: { owner: string; enabled: boolean }): Promise<void>;
  shareText(options: { text: string }): Promise<void>;
  // The open note's window needs: screen kept on, no screenshots, volume-key paging.
  setWindowState(options: { keepAwake: boolean; secure: boolean; volumeKeys: boolean }): Promise<void>;
  // What this page was opened for: a floating window's tool, or a page the
  // notebook should open (returned once).
  takeLaunch(): Promise<{ action: LaunchAction | null; path?: string }>;
  // Floating windows (今日记, 青藜): step out of sight, or close with a toast
  // and/or the notebook opened at a page.
  hideWindow(): Promise<void>;
  closeWindow(options: { message?: string; path?: string }): Promise<void>;
  finishBoot(): Promise<void>;
  // The server whose origin serves this UI; changing it restarts the app there.
  getServer(): Promise<import('./server').ServerInfo>;
  setServer(options: { url: string }): Promise<{ host: string; restarting: boolean }>;
  // The app lock over the notebook: PIN, fingerprint and when it locks again.
  appLockState(): Promise<AppLockState>;
  appLockSetPin(options: { pin: string; current?: string }): Promise<void>;
  appLockDisable(options: { current: string }): Promise<void>;
  appLockSetBiometric(options: { enabled: boolean }): Promise<void>;
  appLockSetTimeout(options: { timeout: number }): Promise<void>;
  // 忘记 PIN, once this page has signed out: drops the session cookie and the lock.
  appLockReset(): Promise<void>;
  // Content keys of encrypted notes kept for fingerprint unlocking (base64 raw
  // keys), each with the wrapped key it was saved from.
  fingerprintKeys(): Promise<{ available: boolean; keys: { id: string; wrapped: string }[] }>;
  fingerprintKeySave(options: { id: string; wrapped: string; key: string }): Promise<{ cancelled: boolean }>;
  fingerprintKeyOpen(options: { id: string }): Promise<{ cancelled: boolean; key?: string }>;
  fingerprintKeyRemove(options: { id?: string }): Promise<void>;
  saveFile(options: {
    url?: string;
    sha256?: string;
    data?: string;
    name: string;
    mime: string;
  }): Promise<{ cancelled: boolean }>;
}>('NoteDevice');

export type LaunchAction = 'open' | 'journal' | 'assistant';
export interface AppLockState {
  enabled: boolean;
  pinLength: number;
  biometric: boolean;
  biometricAvailable: boolean;
  // Milliseconds out of sight before it locks again.
  timeout: number;
}

// Messages go to the notebook's notice line or status toast; outside the
// notebook nothing listens and Android shows its own toast instead.
export function notice(message: string, kind: 'notice' | 'toast' = 'notice') {
  if (window.dispatchEvent(new CustomEvent(`note:${kind}`, { detail: message, cancelable: true })))
    void device.notify({ message }).catch(() => {});
}

const isFile = (url: URL) =>
  url.origin === location.origin && /^\/api\/files\/[\w-]+$/.test(url.pathname);
const report = (error: unknown) =>
  notice(error instanceof Error ? error.message : '操作未完成，请重试。');
const saved = ({ cancelled }: { cancelled: boolean }) => {
  if (!cancelled) notice('已保存到所选位置', 'toast');
};

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取待保存的文件。'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
async function download(url: URL, name = '') {
  const sealed = isFile(url) ? sealedFileId(url.href) : null;
  if (sealed) {
    // Decrypted here and handed over as data, so it has a size limit.
    const blob = await fileBlob(sealed);
    if (blob.size > 25 * 1024 * 1024)
      throw new Error('加密文件超过 25 MiB，请在桌面浏览器中下载。');
    saved(await device.saveFile({
      data: await base64(blob),
      name: name || sealedFile(sealed)?.name || '页间文件',
      mime: blob.type.split(';')[0] || 'application/octet-stream',
    }));
  } else if (isFile(url)) {
    const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
    if (!response.ok)
      throw new Error(response.status === 401 ? '登录已失效，请重新登录。' : '文件暂时无法下载。');
    const encoded = response.headers
      .get('content-disposition')
      ?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    saved(await device.saveFile({
      url: url.href,
      name: name || (encoded ? decodeURIComponent(encoded) : '页间文件'),
      mime: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
    }));
  } else if (['blob:', 'data:'].includes(url.protocol)) {
    const response = await fetch(url);
    const blob = await response.blob();
    if (blob.size > 6 * 1024 * 1024) throw new Error('此图片或草稿过大，暂时无法保存。');
    saved(await device.saveFile({
      data: await base64(blob),
      name: name || '页间截图.jpg',
      mime: blob.type.split(';')[0] || 'application/octet-stream',
    }));
  }
}

export function finishBoot() {
  if (Capacitor.isNativePlatform()) void device.finishBoot().catch(() => {});
}

export function installMobile() {
  if (!Capacitor.isNativePlatform()) return;
  void App.addListener('backButton', ({ canGoBack }) => {
    const event = new CustomEvent('note:native-back', { detail: { canGoBack }, cancelable: true });
    if (window.dispatchEvent(event)) void App.minimizeApp();
  });
  // 忘记 PIN on the app lock: sign out here (even offline), then let Android
  // drop the session cookie and the lock before the sign-in screen shows.
  // Locking every key (全部锁定, signing out) also drops those kept for the fingerprint.
  window.addEventListener('note:keys-locked', () => {
    void import('./fingerprint-keys').then(({ removeFingerprint }) => removeFingerprint()).catch(() => {});
  });
  window.addEventListener('note:app-lock-forgot', () => {
    void (async () => {
      const { signOutHere } = await import('./api');
      await signOutHere().catch(() => {});
      await device.appLockReset();
      window.dispatchEvent(new Event('note:unauthenticated'));
    })();
  });
  void App.addListener('appStateChange', ({ isActive }) => {
    window.dispatchEvent(new Event(isActive ? 'focus' : 'pagehide'));
    if (isActive) theme();
  });
  const theme = () =>
    void device
      .setBackground({
        color: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
        preference: document.documentElement.dataset.themePreference || 'system',
      })
      .catch(() => {});
  theme();
  // Insets and the keyboard resize the WebView without changing its theme.
  // Reapplying native appearance on resize can feed back into window layout.
  new MutationObserver(theme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-preference'],
  });
  const open = (url: URL) => (isFile(url) ? download(url) : device.openExternal({ url: url.href }));
  window.addEventListener('note:open-link', (event) => {
    event.preventDefault();
    void open(new URL((event as CustomEvent<string>).detail, location.href)).catch(report);
  });
  window.addEventListener('note:download', (event) => {
    void download(new URL((event as CustomEvent<string>).detail, location.href)).catch(report);
  });
  document.addEventListener('click', (event) => {
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || event.defaultPrevented) return;
    const url = new URL(anchor.href);
    if (anchor.hasAttribute('download') || (isFile(url) && url.searchParams.has('download'))) {
      event.preventDefault();
      void download(url, anchor.download).catch(report);
    } else if (
      ['https:', 'http:', 'mailto:'].includes(url.protocol) &&
      (url.origin !== location.origin || anchor.target === '_blank')
    ) {
      event.preventDefault();
      void open(url).catch(report);
    }
  });
}
