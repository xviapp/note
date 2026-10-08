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
const inkKey = 'note:ink';
let ink = document.documentElement.dataset.ink === 'true';
const system = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
const validPreference = (value: unknown): ThemePreference =>
  themeOptions.some((option) => option.value === value) ? (value as ThemePreference) : 'system';
const resolve = (preference: ThemePreference): Theme =>
  ink ? 'light' : preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
let snapshot = {
  ink,
  preference: validPreference(document.documentElement.dataset.themePreference),
  theme: resolve(validPreference(document.documentElement.dataset.themePreference)),
};

function apply(preference: ThemePreference) {
  const theme = resolve(preference);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.ink = String(ink);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    ink
      ? '#ffffff'
      : {
          light: '#F9EFE2',
          dark: '#191817',
          starry: '#20263b',
        }[theme],
  );
  if (snapshot.preference === preference && snapshot.theme === theme && snapshot.ink === ink)
    return;
  snapshot = { preference, theme, ink };
  for (const notify of listeners) notify();
}

export function setInkMode(enabled: boolean) {
  ink = enabled;
  try {
    localStorage.setItem(inkKey, String(enabled));
  } catch {
    // Keep the choice for this tab when storage is unavailable.
  }
  apply(snapshot.preference);
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
  if (event.key === inkKey || event.key === null) {
    ink = event.key !== null && event.newValue === 'true';
    apply(snapshot.preference);
  }
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
