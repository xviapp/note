import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useSyncExternalStore } from 'react';

export type ProxyState = {
  enabled: boolean;
  phase: 'off' | 'starting' | 'running' | 'reconnecting' | 'failed';
  errorCode: string;
  retryAtMillis: number;
  hasProfile: boolean;
  subscription: ProxySubscription;
};

export type ProxyNode = {
  id: string;
  name: string;
  type: string;
  delayMillis: number;
  selected: boolean;
};

export type ProxySubscription = {
  updating: boolean;
  error: string;
  url: string;
  lastUpdated: number;
  updateIntervalMinutes: number;
  testIntervalMinutes: number;
  testing: boolean;
  lastTested: number;
  testError: string;
  manualIndex: number;
  fallback: boolean;
  nodes: ProxyNode[];
};

type NativeProxyPlugin = {
  prepare(): Promise<ProxyState>;
  getStatus(): Promise<ProxyState>;
  setEnabled(options: { enabled: boolean }): Promise<ProxyState>;
  retry(): Promise<ProxyState>;
  saveSubscription(options: { url: string; updateIntervalMinutes: number; testIntervalMinutes: number }): Promise<ProxyState>;
  updateSubscription(): Promise<ProxyState>;
  selectNextNode(): Promise<ProxyState>;
  selectNode(options: { index: number }): Promise<ProxyState>;
  selectAutomatically(): Promise<ProxyState>;
  getInfo(): Promise<{ sourceVersion: string; sourceCommit: string; coreVersion: string }>;
  addListener(event: 'status', callback: (state: ProxyState) => void): Promise<PluginListenerHandle>;
};

export const nativeProxy = registerPlugin<NativeProxyPlugin>('NoteProxy');
export const hasNativeProxy = () => Capacitor.getPlatform() === 'android';

let state: ProxyState = {
  enabled: false, phase: 'off', errorCode: '', retryAtMillis: 0, hasProfile: false,
  subscription: { updating: false, error: '', url: '', lastUpdated: -1, manualIndex: -1, fallback: false, nodes: [], updateIntervalMinutes: 1440, testIntervalMinutes: 5, testing: false, lastTested: 0, testError: '' },
};
const listeners = new Set<() => void>();

function receive(next: ProxyState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useProxyState() {
  return useSyncExternalStore(subscribe, () => state);
}

export function useProxySubscription() {
  return useSyncExternalStore(subscribe, () => state.subscription);
}

export function proxyMessage(value: ProxyState) {
  if (value.phase === 'reconnecting') {
    const seconds = Math.max(0, Math.ceil((value.retryAtMillis - Date.now()) / 1000));
    return seconds > 0 ? `代理连接异常，${seconds} 秒后重连。` : '代理连接异常，正在重连…';
  }
  if (value.errorCode === 'WEBVIEW_UNSUPPORTED') return '当前 WebView 不支持应用内代理，当前使用直连。';
  if (value.errorCode === 'NO_PROFILE') return '尚无可用节点，请保存订阅地址并更新订阅。';
  if (value.errorCode === 'RECONNECT_FAILED') return '代理连接失败，当前使用直连。';
  if (value.errorCode === 'initialization_failed') return '代理初始化未完成，当前使用默认网络。';
  if (value.phase === 'failed') return '代理启动失败，当前使用直连。';
  return '';
}

export function subscriptionError(code: string) {
  if (!code) return '';
  const messages: Record<string, string> = {
    INVALID_INTERVAL: '更新间隔至少为 15 分钟，连通性测试间隔至少为 1 分钟，请输入整数。',
    INVALID_URL: '订阅地址无效，请输入有效的 HTTP 或 HTTPS 地址。',
    NO_SUBSCRIPTION: '请先保存订阅地址。',
    DOWNLOAD_FAILED: '订阅下载失败，请检查地址和网络后重试。',
    UPDATE_FAILED: '订阅更新失败，请检查地址和网络后重试。',
    INVALID_NODE: '节点已不存在，请重新选择。',
    NO_NODES: '订阅中没有节点，请检查订阅地址。',
    NO_USABLE_NODES: '订阅中没有可用节点，请检查网络后更新订阅。',
    BUSY: '订阅更新或节点检测正在进行，请稍后重试。',
    STORAGE_FAILED: '订阅保存失败，请检查设备存储空间后重试。',
    TIMEOUT: '订阅更新超时，请稍后重试。',
    CANCELLED: '订阅更新已取消，请重试。',
  };
  return messages[code] || '订阅操作未完成，请检查地址和网络后重试。';
}

let ready: Promise<void> = Promise.resolve();
let observation: Promise<PluginListenerHandle> | undefined;
// The UI renders at once; requests wait until the WebView proxy choice is applied.
export function prepareProxy(): Promise<void> {
  if (hasNativeProxy()) ready = startProxy();
  return ready;
}
export const proxyReady = () => ready;

async function startProxy() {
  try {
    if (!observation) {
      observation = nativeProxy.addListener('status', receive).catch((error: unknown) => {
        observation = undefined;
        throw error;
      });
      window.addEventListener('focus', () => { void refreshProxy().catch(() => {}); });
    }
    await observation;
    receive(await nativeProxy.prepare());
  } catch {
    receive({ ...state, enabled: false, phase: 'failed', errorCode: 'initialization_failed', retryAtMillis: 0 });
  }
}

export async function refreshProxy() { receive(await nativeProxy.getStatus()); }
export async function enableProxy(enabled: boolean) { receive(await nativeProxy.setEnabled({ enabled })); }
export async function retryProxy() { receive(await nativeProxy.retry()); }
export async function saveProxySubscription(input: { url: string; updateIntervalMinutes: number; testIntervalMinutes: number }) {
  const next = await nativeProxy.saveSubscription(input);
  receive(next);
  return next;
}
export async function updateProxySubscription() { receive(await nativeProxy.updateSubscription()); }
export async function selectNextProxyNode() { receive(await nativeProxy.selectNextNode()); }

export async function selectProxyNode(index: number) { receive(await nativeProxy.selectNode({ index })); }
export async function selectProxyAutomatically() { receive(await nativeProxy.selectAutomatically()); }
