import { useEffect, useState } from 'react';
import { api } from './api';
import type { NoteNode } from '../shared/types';
import type { MovedNode } from './components/Tree';
import { knownNode, settleChange, showChange } from './optimistic';

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
  const relocate = async (id: string, parent: string | null, refresh = true) => {
    const node = await api<NoteNode>(`/api/nodes/${id}`);
    if (node.parent_id === parent) return null;
    await api(`/api/nodes/${id}`, 'PATCH', { parentId: parent, revision: node.revision });
    if (refresh) onMoved();
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
  // The note shows in its new folder at once; a refused move puts it back.
  const drop = async (id: string, parent: string | null, title: string) => {
    if (!id || id === parent || !(await canLeave())) return false;
    if ((knownNode(id)?.parent_id ?? undefined) === parent) return false;
    const withdraw = showChange(id, { fields: { parent_id: parent } });
    try {
      const node = await relocate(id, parent);
      if (!node) {
        withdraw();
        return false;
      }
      settleChange(withdraw);
      announce(id, node.parent_id, parent, title);
      return true;
    } catch (e) {
      withdraw();
      onError(e);
      return false;
    }
  };
  // Several selected notes, one after another; one toast undoes them all.
  // Those that cannot move (e.g. into themselves) are reported; the rest stay moved.
  const dropMany = async (nodes: NoteNode[], parent: string | null, title: string, path?: string[]) => {
    if (!(await canLeave())) return false;
    const done: { id: string; from: string | null }[] = [],
      failed: string[] = [];
    for (const node of nodes) {
      if (node.id === parent || (knownNode(node.id)?.parent_id ?? node.parent_id) === parent) continue;
      const withdraw = showChange(node.id, { fields: { parent_id: parent } });
      try {
        const before = await relocate(node.id, parent, false);
        if (!before) withdraw();
        else {
          settleChange(withdraw);
          done.push({ id: node.id, from: before.parent_id });
        }
      } catch (e) {
        withdraw();
        failed.push(`「${node.title}」：${(e as Error).message}`);
      }
    }
    if (done.length) {
      onMoved();
      setMoved({ id: done[0].id, parent, key: Date.now(), path });
      toast(`已将 ${done.length} 项移到${parent ? `「${title || '目标文件夹'}」` : '根目录'}`, async () => {
        try {
          for (const { id, from } of done) await relocate(id, from, false);
          onMoved();
          toast('已撤销移动');
        } catch (e) {
          onMoved();
          onError(e);
        }
      });
    }
    if (failed.length) onError(new Error(`${failed.length} 项未能移动：${failed.join('；')}`));
    return done.length > 0;
  };
  return { moved, drop, dropMany, announce };
}
