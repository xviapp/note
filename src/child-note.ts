import { api, lockNote, unlockNote } from './api';
import type { NoteDetail, NoteNode } from '../shared/types';

// Writes generated Markdown (a translation, exported records) as a child note.
// A child with the same title is updated as a new version instead of adding
// another, so earlier text stays in its history. Returns whether it updated.
export async function saveChildNote(parentId: string, title: string, content: string) {
  const { nodes } = await api<{ nodes: NoteNode[] }>(`/api/nodes?parent=${parentId}`);
  const existing = nodes.find((child) => child.kind === 'markdown' && child.title === title);
  if (!existing) {
    await api('/api/nodes', 'POST', { kind: 'markdown', title, parentId, content });
    return false;
  }
  await unlockNote(existing.id);
  try {
    const detail = await api<NoteDetail>(`/api/nodes/${existing.id}`);
    await api(`/api/nodes/${existing.id}/content`, 'PUT', {
      revision: detail.revision,
      content,
      attachments: [],
    });
  } finally {
    lockNote(existing.id);
  }
  return true;
}
