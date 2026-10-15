import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useSyncExternalStore } from 'react';

/**
 * off: switched off or no address; vpn: a VPN stands in for the proxy; checking: first check of
 * the proxy; proxy: it answered; direct: it did not, so traffic goes direct until it answers again.
 */
export type ProxyRoute = 'off' | 'vpn' | 'checking' | 'proxy' | 'direct';

export type ProxyState = {
  enabled: boolean;
  /** Normalized `socks5://host:port` or `http://host:port`, empty when unset. */
  url: string;
  /** Whether traffic connects directly while a VPN is on. */
  bypassOnVpn: boolean;
  route: ProxyRoute;
  /** Unix milliseconds of the last check, 0 before any. */
  checkedAt: number;
  /** Why the last check failed: refused, timeout, dns, auth or protocol; empty when it answered. */
  error: string;
};

type NativeProxyPlugin = {
  prepare(): Promise<ProxyState>;
  getStatus(): Promise<ProxyState>;
  check(options: { force: boolean }): Promise<ProxyState>;
  setEnabled(options: { enabled: boolean }): Promise<ProxyState>;
  setUrl(options: { url: string }): Promise<ProxyState>;
  setBypassOnVpn(options: { enabled: boolean }): Promise<ProxyState>;
  addListener(event: 'status', callback: (state: ProxyState) => void): Promise<PluginListenerHandle>;
};

export const nativeProxy = registerPlugin<NativeProxyPlugin>('NoteProxy');
export const hasNativeProxy = () => Capacitor.getPlatform() === 'android';

/** Matches the native reuse of a check: a minute after success, 15 seconds after failure. */
const HEALTHY_FOR_MS = 60_000;
const FAILED_FOR_MS = 15_000;

let state: ProxyState = { enabled: false, url: '', bypassOnVpn: false, route: 'off', checkedAt: 0, error: '' };
const listeners = new Set<() => void>();

// Read through a call: TypeScript keeps a narrowed `state` across awaits.
const routeNow = () => state.route;
const proxyName = (url: string) => url.replace(/^[a-z0-9]+:\/\//, '');

function receive(next: ProxyState) {
  const before = state.route;
  state = next;
  if (next.route === 'direct' && before !== 'direct')
    toast(`代理 ${proxyName(next.url)} 无法连接，已改用直连`);
  else if (next.route === 'proxy' && before === 'direct') toast('代理已恢复');
  for (const listener of listeners) listener();
}

function toast(message: string) {
  void import('./mobile').then(({ notice }) => notice(message, 'toast')).catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useProxyState() {
  return useSyncExternalStore(subscribe, () => state);
}

export function proxyLabel(value: ProxyState) {
  switch (value.route) {
    case 'off': return value.enabled ? '尚未填写代理地址，使用直连' : '已关闭，使用直连';
    case 'vpn': return '已连接 VPN，代理已暂停';
    case 'checking': return '正在检测代理…';
    case 'proxy': return `已连接 ${proxyName(value.url)}`;
    case 'direct': return '代理无法连接，当前使用直连';
  }
}

export function proxyError(code: string) {
  const messages: Record<string, string> = {
    refused: '代理拒绝连接，请确认代理软件正在运行、端口正确。',
    timeout: '连接代理超时，请检查地址和网络。',
    dns: '无法解析代理地址。',
    auth: '代理要求用户名和密码，目前不支持带认证的代理。',
    protocol: '该端口不是 SOCKS5 代理，请检查协议和端口。',
  };
  return messages[code] ?? '';
}

export function addressError(code: string) {
  const messages: Record<string, string> = {
    SCHEME: '仅支持 socks5:// 或 http:// 代理。',
    AUTH: '不支持带用户名和密码的代理地址。',
    PORT: '请填写 1–65535 之间的端口。',
  };
  return messages[code] ?? '代理地址无效，请按 socks5://127.0.0.1:7890 的格式填写。';
}

let ready: Promise<void> = Promise.resolve();
let checking: Promise<void> | undefined;
let observation: Promise<PluginListenerHandle> | undefined;

// The UI renders at once; requests wait until the WebView route is applied.
export function prepareProxy(): Promise<void> {
  if (hasNativeProxy()) ready = startProxy();
  return ready;
}

/**
 * Resolves once requests may go out: at once while the last check is recent, otherwise after the
 * proxy has been checked again and the route updated.
 */
export function proxyReady(): Promise<void> {
  if (!hasNativeProxy()) return ready;
  return ready.then(() => {
    if (state.route !== 'proxy' && state.route !== 'direct') return;
    const age = Date.now() - state.checkedAt;
    if (age <= (state.route === 'proxy' ? HEALTHY_FOR_MS : FAILED_FOR_MS)) return;
    return checkProxy(false);
  });
}

/** After a request could not reach the network: if the proxy is down, traffic moves to direct. */
export async function reportNetworkFailure(): Promise<boolean> {
  if (!hasNativeProxy() || state.route !== 'proxy') return false;
  await checkProxy(true);
  return routeNow() === 'direct';
}

function checkProxy(force: boolean): Promise<void> {
  checking ??= nativeProxy.check({ force }).then(receive).catch(() => {}).finally(() => { checking = undefined; });
  return checking;
}

async function startProxy() {
  try {
    if (!observation) {
      observation = nativeProxy.addListener('status', receive).catch((error: unknown) => {
        observation = undefined;
        throw error;
      });
      window.addEventListener('focus', () => { if (state.enabled) void checkProxy(true); });
    }
    await observation;
    receive(await nativeProxy.prepare());
  } catch {
    // Without the bridge nothing is routed, so requests go direct.
  }
}

export async function retryProxy() { receive(await nativeProxy.check({ force: true })); }
export async function enableProxy(enabled: boolean) { receive(await nativeProxy.setEnabled({ enabled })); }
export async function setProxyUrl(url: string) { receive(await nativeProxy.setUrl({ url })); }
export async function setProxyBypassOnVpn(enabled: boolean) { receive(await nativeProxy.setBypassOnVpn({ enabled })); }
