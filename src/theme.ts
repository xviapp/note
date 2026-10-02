import { useSyncExternalStore } from 'react';

export const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '白天' },
  { value: 'dark', label: '夜间' },
  { value: 'starry', label: '星空' },
] as const;
export type ThemePreference = (typeof themeOptions)[number]['value'];
type Theme = Exclude<ThemePreference, 'system'>;
const key = 'note:theme';
const system = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
const validPreference = (value: unknown): ThemePreference =>
  themeOptions.some((option) => option.value === value) ? (value as ThemePreference) : 'system';
const resolve = (preference: ThemePreference): Theme =>
  preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
let snapshot = {
  preference: validPreference(document.documentElement.dataset.themePreference),
  theme: resolve(validPreference(document.documentElement.dataset.themePreference)),
};

function apply(preference: ThemePreference) {
  const theme = resolve(preference);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    {
      light: '#F9EFE2',
      dark: '#191817',
      starry: '#20263b',
    }[theme],
  );
  if (snapshot.preference === preference && snapshot.theme === theme) return;
  snapshot = { preference, theme };
  for (const notify of listeners) notify();
}

export function setTheme(preference: ThemePreference) {
  try {
    localStorage.setItem(key, preference);
  } catch {
    // Keep the choice for this tab when storage is unavailable.
  }
  apply(preference);
}

system.addEventListener('change', () => apply(snapshot.preference));
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null) apply(validPreference(event.newValue));
});
apply(snapshot.preference);

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

export function useTheme() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
