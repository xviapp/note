import { useSyncExternalStore } from 'react';

// The note being edited, if any, so 随手记 can put a clip at its cursor.
export interface InsertTarget {
  id: string;
  title: string;
  insert: (text: string) => void;
  // Uploads into the note's place (sealed like its own files) and inserts images.
  addFiles: (files: File[]) => Promise<void>;
}
let target: InsertTarget | null = null;
const listeners = new Set<() => void>();
export function setInsertTarget(next: InsertTarget | null) {
  target = next;
  listeners.forEach((listener) => listener());
}
export const insertTarget = () => target;
export function useInsertTarget() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, insertTarget);
}
