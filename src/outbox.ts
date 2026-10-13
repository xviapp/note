import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { cachedApi } from './api';
import { discardPending, flushClips, pendingClips, revealPending, subscribePendingClips } from './clips';
import { isOffline } from './connectivity';
import { flushJournalOutbox, listOutbox, removeOutboxRecord, subscribeOutbox } from './journal-outbox';
import { isUnlocked, subscribeKeys } from './keyring';
import { discardQuickRecord, flushQuickRecords, queuedQuickRecords, subscribeQuickRecords } from './quick-journal';
import { discardSave, flushSaves, pendingSaves, subscribeSaves } from './save-outbox';
import { isSealedText } from '../shared/encryption';
import { longDate } from '../shared/journals';
import type { NoteNode } from '../shared/types';

// Everything saved on this device but not on the server yet, for 设置 → 待发送.
// Each outbox is a source; a new one only needs adding to SOURCES.
export interface OutboxItem {
  id: string;
  // The record itself: a title, or the first words.
  summary: string;
  // What and where: e.g. 今日记 · 10月12日 · 生活日记 · 2 张照片.
  detail: string;
  createdAt: number;
  // Why it waits, or why it was refused.
  status: string;
  failed: boolean;
  // A page that lets it go (unlocking its journal).
  open?: { label: string; id: string };
}
export interface OutboxSource {
  key: string;
  label: string;
  list(): Promise<OutboxItem[]>;
  subscribe(listener: () => void): () => void;
  retry(): Promise<unknown>;
  remove(id: string): Promise<void>;
}

const excerpt = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};
const waiting = () => (isOffline() ? '等待联网' : '等待发送');

const journals: OutboxSource = {
  key: 'journal',
  label: '今日记',
  async list() {
    const titles = new Map(
      ((await cachedApi<{ nodes: NoteNode[] }>('/api/nodes?view=journals'))?.nodes ?? []).map((node) => [node.id, node.title]),
    );
    return (await listOutbox()).map((record) => {
      const journal = titles.get(record.journalId) ?? '日记本';
      const locked = !isUnlocked(record.keyId);
      return {
        id: record.id,
        summary: record.title || excerpt(record.text) || '（只有照片）',
        detail: [longDate(record.date), journal, record.photos ? `${record.photos} 张照片` : ''].filter(Boolean).join(' · '),
        createdAt: record.createdAt,
        status: locked ? `等待解锁「${journal}」` : record.error ? `没能记入：${record.error}` : waiting(),
        failed: !locked && !!record.error,
        open: locked ? { label: '去解锁', id: record.journalId } : undefined,
      };
    });
  },
  subscribe(listener) {
    const stopOutbox = subscribeOutbox(listener);
    const stopKeys = subscribeKeys(listener);
    return () => {
      stopOutbox();
      stopKeys();
    };
  },
  retry: flushJournalOutbox,
  remove: removeOutboxRecord,
};

// 今日记 saved in the window that Android ended, or that was refused.
const quickRecords: OutboxSource = {
  key: 'quick-journal',
  label: '今日记补记',
  async list() {
    const titles = new Map(
      ((await cachedApi<{ nodes: NoteNode[] }>('/api/nodes?view=journals'))?.nodes ?? []).map((node) => [node.id, node.title]),
    );
    return (await queuedQuickRecords()).map((record) => {
      const journal = titles.get(record.journalId) ?? '日记本';
      const photos = record.images.length + record.photos;
      return {
        id: record.draftId,
        summary: record.locked ? '（加密内容）' : record.title || excerpt(record.text) || '（只有照片）',
        detail: [longDate(record.date), journal, photos ? `${photos} 张照片` : ''].filter(Boolean).join(' · '),
        createdAt: record.savedAt,
        status: record.locked ? `等待解锁「${journal}」` : record.error ? `没能记入：${record.error}` : waiting(),
        failed: !record.locked && !!record.error,
        open: record.locked ? { label: '去解锁', id: record.journalId } : undefined,
      };
    });
  },
  subscribe(listener) {
    const stopRecords = subscribeQuickRecords(listener);
    const stopKeys = subscribeKeys(listener);
    return () => {
      stopRecords();
      stopKeys();
    };
  },
  retry: () => flushQuickRecords(),
  remove: discardQuickRecord,
};

const clips: OutboxSource = {
  key: 'clips',
  label: '随手记',
  async list() {
    return (await revealPending(pendingClips())).map((clip) => ({
      id: clip.id,
      summary: isSealedText(clip.text) ? '（加密内容）' : excerpt(clip.text) || '（只有图片）',
      detail: clip.file ? '含图片' : '',
      createdAt: clip.created_at,
      status: clip.pending.error ? `没能发送：${clip.pending.error}` : waiting(),
      failed: !!clip.pending.error,
    }));
  },
  subscribe: subscribePendingClips,
  retry: flushClips,
  remove: async (id) => discardPending(id),
};

// Android's 随手记 widget writes natively; what it could not send yet waits there.
const widget: OutboxSource = {
  key: 'widget',
  label: '桌面小组件',
  async list() {
    if (Capacitor.getPlatform() !== 'android') return [];
    const { device } = await import('./mobile');
    const { items } = await device.pendingWidgetClips().catch(() => ({ items: [] }));
    return items.map((item) => ({
      id: item.id,
      summary: excerpt(item.text),
      detail: '随手记',
      createdAt: item.createdAt,
      status: waiting(),
      failed: false,
    }));
  },
  subscribe(listener) {
    window.addEventListener('note:widget-clips-sent', listener);
    window.addEventListener('focus', listener);
    return () => {
      window.removeEventListener('note:widget-clips-sent', listener);
      window.removeEventListener('focus', listener);
    };
  },
  retry: async () => (await import('./widget-clips')).flushWidgetClips(),
  async remove(id) {
    const { device } = await import('./mobile');
    await device.removeWidgetClip({ id });
    window.dispatchEvent(new Event('note:widget-clips-sent'));
  },
};

// Note bodies whose 保存 returned at once and are still on their way.
const saves: OutboxSource = {
  key: 'saves',
  label: '笔记修改',
  async list() {
    return pendingSaves().map((item) => {
      const locked = !!item.keyId && !isUnlocked(item.keyId);
      return {
        id: item.id,
        summary: item.title || '无标题笔记',
        detail: '',
        createdAt: item.savedAt,
        status: item.error ? `没能保存：${item.error}` : locked ? '等待解锁这篇笔记' : waiting(),
        failed: !!item.error,
        // The note offers its draft again, where it can be compared and kept.
        open: item.error || locked ? { label: item.error ? '打开' : '去解锁', id: item.id } : undefined,
      };
    });
  },
  subscribe(listener) {
    const stopSaves = subscribeSaves(listener);
    const stopKeys = subscribeKeys(listener);
    return () => {
      stopSaves();
      stopKeys();
    };
  },
  retry: () => flushSaves(),
  remove: discardSave,
};

export const SOURCES: OutboxSource[] = [saves, journals, quickRecords, clips, widget];

export interface OutboxGroup {
  source: OutboxSource;
  items: OutboxItem[];
}
// Every source's items, kept current while mounted.
export function useOutbox() {
  const [groups, setGroups] = useState<OutboxGroup[] | null>(null);
  const refresh = useCallback(async () => {
    const lists = await Promise.all(SOURCES.map((source) => source.list().catch(() => [])));
    setGroups(SOURCES.map((source, index) => ({ source, items: lists[index]! })));
  }, []);
  useEffect(() => {
    void refresh();
    const update = () => void refresh();
    const stops = SOURCES.map((source) => source.subscribe(update));
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      stops.forEach((stop) => stop());
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [refresh]);
  return { groups, refresh };
}
export function useOutboxCount() {
  return useOutboxSummary().count;
}
// How much waits, and how much of it was refused and needs the reader.
export function useOutboxSummary() {
  const { groups } = useOutbox();
  const items = groups?.flatMap((group) => group.items) ?? [];
  return { count: items.length, failed: items.filter((item) => item.failed).length };
}
