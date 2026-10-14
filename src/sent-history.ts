import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { DRAFT_PREFIX, draftEpoch } from './note-drafts';

export interface SentItem {
  id: string;
  summary: string;
  detail: string;
  sentAt: number;
}
const PREFIX = `${DRAFT_PREFIX}sent:`;
const AGE = 30 * 24 * 60 * 60 * 1000;
const EVENT = 'note:sent-history';
export const sentExcerpt = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 60);

// One key per operation avoids overwriting other windows' receipts. Never keep
// decrypted content here: encrypted sends supply a neutral summary instead.
export function readSentHistory(): SentItem[] {
  const items: SentItem[] = [];
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      try {
        const item = JSON.parse(localStorage.getItem(key)!);
        if (typeof item.id === 'string' && typeof item.summary === 'string' &&
            typeof item.detail === 'string' && Number.isFinite(item.sentAt) && item.sentAt > Date.now() - AGE)
          items.push(item);
        else localStorage.removeItem(key);
      } catch { localStorage.removeItem(key); }
    }
    items.sort((a, b) => b.sentAt - a.sentAt);
    for (const item of items.slice(500)) localStorage.removeItem(PREFIX + item.id);
  } catch { /* History is optional when local storage is unavailable. */ }
  return items.slice(0, 500);
}
export function recordSent(item: Omit<SentItem, 'sentAt'>, started: string) {
  if (draftEpoch() !== started) return;
  try {
    if (!localStorage.getItem(PREFIX + item.id))
      localStorage.setItem(PREFIX + item.id, JSON.stringify({ ...item, sentAt: Date.now() }));
    readSentHistory();
    window.dispatchEvent(new Event(EVENT));
  } catch { /* A receipt must never turn a successful send into a retry. */ }
}
export function useSentHistory() {
  const [items, setItems] = useState<SentItem[]>([]);
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      const local = readSentHistory();
      let native: SentItem[] = [];
      if (Capacitor.getPlatform() === 'android') {
        try {
          const { device } = await import('./mobile');
          const result = await device.sentWidgetClips();
          native = result.items.map((item) => ({
            id: `widget:${item.id}`, summary: sentExcerpt(item.text), detail: '快捷随手记', sentAt: item.sentAt,
          }));
        } catch { /* Older installed shells do not provide history. */ }
      }
      if (generation === current) setItems([...local, ...native].sort((a, b) => b.sentAt - a.sentAt).slice(0, 500));
    };
    const update = () => void refresh();
    update();
    for (const event of [EVENT, 'storage', 'focus', 'note:widget-clips-sent', 'note:cache-reset'])
      window.addEventListener(event, update);
    return () => {
      generation++;
      for (const event of [EVENT, 'storage', 'focus', 'note:widget-clips-sent', 'note:cache-reset'])
        window.removeEventListener(event, update);
    };
  }, []);
  return items;
}
