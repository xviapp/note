import { Capacitor } from '@capacitor/core';
import { useEffect, useSyncExternalStore } from 'react';

// What an open note asks of the Android window: the screen stays on while the
// reader is active, encrypted notes block screenshots and the recents preview,
// and the volume keys can page through the text.
export interface ReadingWindowPreferences {
  keepAwake: boolean;
  volumeKeys: boolean;
}
export const readingWindowDefaults: ReadingWindowPreferences = { keepAwake: true, volumeKeys: false };
// The screen may sleep again after this long without touches, keys or scrolling.
export const KEEP_AWAKE_IDLE_MS = 10 * 60 * 1000;

const key = 'note:reading-window';
function read(): ReadingWindowPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      keepAwake: typeof value?.keepAwake === 'boolean' ? value.keepAwake : readingWindowDefaults.keepAwake,
      volumeKeys: typeof value?.volumeKeys === 'boolean' ? value.volumeKeys : readingWindowDefaults.volumeKeys,
    };
  } catch {
    return { ...readingWindowDefaults };
  }
}
let preferences = read();
const listeners = new Set<() => void>();
export function setReadingWindowPreferences(value: Partial<ReadingWindowPreferences>) {
  preferences = { ...preferences, ...value };
  try {
    localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    /* Device preference. */
  }
  listeners.forEach((listener) => listener());
  sync();
}
export function useReadingWindowPreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preferences,
  );
}

type Page = { secure: boolean; paging: boolean };
let page: Page | null = null,
  active = false,
  idleTimer: ReturnType<typeof setTimeout> | undefined,
  sent = '';
type WindowState = { keepAwake: boolean; secure: boolean; volumeKeys: boolean };
let apply: (state: WindowState) => Promise<void> = async (state) => {
  const { device } = await import('./mobile');
  await device.setWindowState(state);
};
export const setWindowStateForTest = (next: typeof apply) => {
  apply = next;
  sent = '';
};

function sync() {
  const state = {
    keepAwake: !!page && active && preferences.keepAwake,
    secure: !!page?.secure,
    volumeKeys: !!page?.paging && preferences.volumeKeys,
  };
  const value = JSON.stringify(state);
  if (value === sent) return;
  sent = value;
  void apply(state).catch(() => {
    sent = '';
  });
}
function touch() {
  clearTimeout(idleTimer);
  if (!page) return;
  idleTimer = setTimeout(() => {
    active = false;
    sync();
  }, KEEP_AWAKE_IDLE_MS);
  if (!active) {
    active = true;
    sync();
  }
}

// The text the volume keys move: the PDF or note in the topmost dialog, else on the page.
export function pageVolume(direction: number) {
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  const area = (dialog ?? document).querySelector<HTMLElement>('.pdf-scroll, .note-scroll');
  if (!area) return;
  area.scrollBy({ top: direction * Math.max(80, area.clientHeight - 48), behavior: 'smooth' });
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll'])
    window.addEventListener(type, touch, { capture: true, passive: true });
  window.addEventListener('note:volume-key', (event) => {
    touch();
    pageVolume(Number((event as CustomEvent<number>).detail) || 0);
  });
}

// Called by the open note; Android only. Reading pages may use the volume keys,
// editing keeps them for volume.
export function useReadingWindow(open: boolean, secure: boolean, paging: boolean) {
  useEffect(() => {
    if (!open || Capacitor.getPlatform() !== 'android') return;
    install();
    const current = { secure, paging };
    page = current;
    active = false;
    touch();
    return () => {
      if (page !== current) return;
      page = null;
      clearTimeout(idleTimer);
      sync();
    };
  }, [open, secure, paging]);
}
