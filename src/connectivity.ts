import { useSyncExternalStore } from 'react';
let offline = !navigator.onLine;
const listeners = new Set<() => void>();
export const isOffline = () => offline;
export function setOffline(value: boolean) {
  if (value === offline) return;
  offline = value;
  listeners.forEach((listener) => listener());
  if (!value) window.dispatchEvent(new Event('note:reconnected'));
}
window.addEventListener('offline', () => setOffline(true));
// The auth probe verifies connectivity/session before the library refreshes.
window.addEventListener('online', () => window.dispatchEvent(new Event('focus')));
export function useOffline() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, isOffline);
}
