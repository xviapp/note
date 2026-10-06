import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';

export const device = registerPlugin<{
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
  finishBoot(): Promise<void>;
  // The server whose origin serves this UI; changing it restarts the app there.
  getServer(): Promise<import('./server').ServerInfo>;
  setServer(options: { url: string }): Promise<{ host: string; restarting: boolean }>;
  saveFile(options: {
    url?: string;
    sha256?: string;
    data?: string;
    name: string;
    mime: string;
  }): Promise<{ cancelled: boolean }>;
}>('NoteDevice');

const isFile = (url: URL) =>
  url.origin === location.origin && /^\/api\/files\/[\w-]+$/.test(url.pathname);
const report = (error: unknown) =>
  device.notify({ message: error instanceof Error ? error.message : '操作未完成，请重试。' });

async function download(url: URL, name = '') {
  if (isFile(url)) {
    const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
    if (!response.ok)
      throw new Error(response.status === 401 ? '登录已失效，请重新登录。' : '文件暂时无法下载。');
    const encoded = response.headers
      .get('content-disposition')
      ?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    await device.saveFile({
      url: url.href,
      name: name || (encoded ? decodeURIComponent(encoded) : '页间文件'),
      mime: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
    });
  } else if (['blob:', 'data:'].includes(url.protocol)) {
    const response = await fetch(url);
    const blob = await response.blob();
    if (blob.size > 6 * 1024 * 1024) throw new Error('此图片或草稿过大，暂时无法保存。');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('无法读取待保存的文件。'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(blob);
    });
    await device.saveFile({
      data,
      name: name || '页间截图.jpg',
      mime: blob.type.split(';')[0] || 'application/octet-stream',
    });
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
