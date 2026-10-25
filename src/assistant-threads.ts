import { useSyncExternalStore } from 'react';
import type { AssistantThread } from '../shared/assistant';
import { variantOf } from '../shared/types';
import { api } from './api';

// 青藜对话: every note with a conversation, read whole so the tree and lists
// can mark those notes too. Offline, the device's last copy answers.
let threads: AssistantThread[] = [];
let ids = new Set<string>();
const listeners = new Set<() => void>();
let loading: Promise<AssistantThread[]> | null = null;

export function refreshThreads(): Promise<AssistantThread[]> {
  loading ??= api<{ threads: AssistantThread[] }>('/api/assistant/threads')
    .then((data) => {
      threads = data.threads;
      ids = new Set(threads.map((thread) => thread.id));
      listeners.forEach((listener) => listener());
      return threads;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useAssistantThreads = () => useSyncExternalStore(subscribe, () => threads);
export const useHasAssistantThread = (id: string) =>
  useSyncExternalStore(subscribe, () => ids.has(id));

export const openAssistantThreads = () => window.dispatchEvent(new Event('note:assistant-threads'));

// The conversation to open once its note shows: a note's own, or a book page's
// discussion (shown on the page).
let pending: { note: string; discussion?: string } | null = null;
export function requestAssistant(thread: AssistantThread): string {
  const discussion = variantOf(thread) === 'discussion' && thread.parent_id;
  pending = discussion ? { note: discussion, discussion: thread.id } : { note: thread.id };
  window.dispatchEvent(new Event('note:assistant-request'));
  return pending.note;
}
// Takes the request for this note, or this note's discussions, once.
export function takeAssistantRequest(note: string, discussion: boolean): string | null {
  if (pending?.note !== note || !!pending.discussion !== discussion) return null;
  const taken = pending.discussion ?? note;
  pending = null;
  return taken;
}
