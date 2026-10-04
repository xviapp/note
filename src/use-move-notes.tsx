import { useEffect, useState } from 'react';
import { api } from './api';
import type { NoteNode } from '../shared/types';
import type { MovedNode } from './components/Tree';

// Moving notes by drag or dialog: each completed move is revealed in the tree
// once and announced with a toast that can undo it.
export function useMoveNotes({
  canLeave,
  onMoved,
  onError,
  toast,
}: {
  // Resolves false when the open note has unsaved edits the reader keeps.
  canLeave: () => Promise<boolean>;
  onMoved: () => void;
  onError: (error: unknown) => void;
  toast: (message: string, undo?: () => Promise<void>) => void;
}) {
  const [moved, setMoved] = useState<MovedNode | null>(null);
  const relocate = async (id: string, parent: string | null) => {
    const node = await api<NoteNode>(`/api/nodes/${id}`);
    if (node.parent_id === parent) return null;
    await api(`/api/nodes/${id}`, 'PATCH', { parentId: parent, revision: node.revision });
    onMoved();
    return node;
  };
  const announce = (
    id: string,
    from: string | null,
    to: string | null,
    title: string,
    path?: string[],
  ) => {
    const key = Date.now();
    setMoved({ id, parent: to, key, path });
    toast(to ? `已移到「${title || '目标文件夹'}」` : '已移到根目录', async () => {
      try {
        if (!(await relocate(id, from))) return;
        setMoved({ id, parent: from, key: Date.now() });
        toast('已撤销移动');
      } catch (e) {
        onError(e);
      }
    });
  };
  // A move is revealed once; clearing it keeps a remounted tree from replaying it.
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => setMoved(null), 3500);
    return () => clearTimeout(timer);
  }, [moved]);
  const drop = async (id: string, parent: string | null, title: string) => {
    if (!id || id === parent || !(await canLeave())) return false;
    try {
      const node = await relocate(id, parent);
      if (!node) return false;
      announce(id, node.parent_id, parent, title);
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  };
  return { moved, drop, announce };
}
