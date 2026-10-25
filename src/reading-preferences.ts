import { useSyncExternalStore } from 'react';

// Each font's @font-face rules (one per CJK subset) are over 100K of CSS, so they
// load only when the font is chosen or shown in the settings preview.
const fonts = {
  serif: () => import('@fontsource/noto-serif-sc/400.css'),
  sans: () => import('@fontsource/noto-sans-sc/400.css'),
};
const loaded = new Set<keyof typeof fonts>();
export function loadReadingFont(font: ReadingPreferences['font']) {
  if (font === 'system' || loaded.has(font)) return;
  loaded.add(font);
  void fonts[font]().catch(() => loaded.delete(font));
}

export interface ReadingPreferences {
  font: 'system' | 'serif' | 'sans';
  size: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  width: number;
}
export const readingDefaults: ReadingPreferences = {
  font: 'system',
  size: 16,
  lineHeight: 1.9,
  letterSpacing: 0,
  paragraphSpacing: 1.3,
  width: 760,
};
export const readingPresets = {
  紧凑: { lineHeight: 1.6, letterSpacing: 0, paragraphSpacing: 0.8, width: 800 },
  舒适: { lineHeight: 1.9, letterSpacing: 0, paragraphSpacing: 1.3, width: 760 },
  宽松: { lineHeight: 2.2, letterSpacing: 0.04, paragraphSpacing: 1.6, width: 680 },
};
const key = 'note:reading-preferences';
function read(): ReadingPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    const bounded = (name: keyof ReadingPreferences, min: number, max: number) =>
      typeof value?.[name] === 'number' && Number.isFinite(value[name])
        ? Math.max(min, Math.min(max, value[name]))
        : (readingDefaults[name] as number);
    return {
      font: ['system', 'serif', 'sans'].includes(value?.font) ? value.font : 'system',
      size: bounded('size', 14, 28),
      lineHeight: bounded('lineHeight', 1.4, 2.6),
      letterSpacing: bounded('letterSpacing', 0, 0.16),
      paragraphSpacing: bounded('paragraphSpacing', 0.5, 2),
      width: bounded('width', 520, 1040),
    };
  } catch {
    return { ...readingDefaults };
  }
}
let current = read();
const listeners = new Set<() => void>();
function apply() {
  const root = document.documentElement;
  loadReadingFont(current.font);
  root.dataset.readingFont = current.font;
  for (const [name, value] of Object.entries({
    size: `${current.size}px`,
    'line-height': current.lineHeight,
    'letter-spacing': `${current.letterSpacing}em`,
    'paragraph-spacing': `${current.paragraphSpacing}em`,
    width: `${current.width}px`,
  }))
    root.style.setProperty(`--reading-${name}`, String(value));
  listeners.forEach((listener) => listener());
}
apply();
window.addEventListener('storage', (event) => {
  if (event.key === key) {
    current = read();
    apply();
  }
});
export function setReadingPreferences(value: Partial<ReadingPreferences>) {
  window.dispatchEvent(new Event('note:before-reading-change'));
  current = { ...current, ...value };
  try {
    localStorage.setItem(key, JSON.stringify(current));
  } catch {
    /* Device preference. */
  }
  apply();
}
export function useReadingPreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
