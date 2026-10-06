import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useSyncExternalStore } from 'react';

export type ProxyState = {
  enabled: boolean;
  phase: 'off' | 'starting' | 'running' | 'failed';
  message: string;
  hasProfile: boolean;
};
export const nativeProxy = registerPlugin<{
  prepare(): Promise<ProxyState>;
  getStatus(): Promise<ProxyState>;
  setEnabled(options: { enabled: boolean }): Promise<ProxyState>;
  retry(): Promise<ProxyState>;
  openConfiguration(): Promise<void>;
  getInfo(): Promise<{ sourceVersion: string; sourceCommit: string; coreVersion: string }>;
  openLicenses(): Promise<void>;
  addListener(
    event: 'status',
    callback: (state: ProxyState) => void,
  ): Promise<PluginListenerHandle>;
}>('NoteProxy');
export const hasNativeProxy = () => Capacitor.getPlatform() === 'android';
let state: ProxyState = { enabled: false, phase: 'off', message: '', hasProfile: false };
const listeners = new Set<() => void>();
function receive(next: ProxyState) {
  state = next;
  for (const listener of listeners) listener();
}
export function useProxyState() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
let ready: Promise<void> = Promise.resolve();
// The UI renders at once; requests wait (see proxyReady) until the WebView's
// proxy choice is applied, so none of them bypass the chosen route.
export function prepareProxy(): Promise<void> {
  if (hasNativeProxy()) ready = startProxy();
  return ready;
}
export const proxyReady = () => ready;
async function startProxy() {
  try {
    await nativeProxy.addListener('status', receive);
    receive(await nativeProxy.prepare());
  } catch {
    receive({
      enabled: false,
      phase: 'failed',
      message: '代理初始化未完成，当前使用默认网络。',
      hasProfile: false,
    });
  }
  window.addEventListener('focus', () => {
    void refreshProxy().catch(() => {});
  });
}
export async function refreshProxy() {
  receive(await nativeProxy.getStatus());
}
export async function enableProxy(enabled: boolean) {
  receive(await nativeProxy.setEnabled({ enabled }));
}
export async function retryProxy() {
  receive(await nativeProxy.retry());
}
