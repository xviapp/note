import { useEffect } from 'react';
import { FolderInput, Trash2, X } from 'lucide-react';
import type { NoteNode } from '../../shared/types';
import { clearSelection, topSelected, useSelection } from '../selection';

// What can be done with the notes selected with Ctrl / Shift + click.
// Esc clears the selection.
export function SelectionBar({
  onMove,
  onDelete,
}: {
  onMove: (nodes: NoteNode[]) => void;
  onDelete: (nodes: NoteNode[]) => void;
}) {
  const chosen = useSelection();
  const count = chosen.items.size;
  useEffect(() => {
    if (!count) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      clearSelection();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [count]);
  if (!count) return null;
  const nodes = topSelected(chosen.items);
  return (
    <div className="multi-select-bar" role="toolbar" aria-label="已选条目">
      <span>
        已选 {count} 项{nodes.length < count ? `（含下级，处理 ${nodes.length} 项）` : ''}
      </span>
      <button type="button" className="button" onClick={() => onMove(nodes)}>
        <FolderInput size={15} />
        移动到…
      </button>
      <button type="button" className="button danger-text" onClick={() => onDelete(nodes)}>
        <Trash2 size={15} />
        移到回收站
      </button>
      <button type="button" className="icon-button" aria-label="取消选择" title="取消选择（Esc）" onClick={clearSelection}>
        <X size={16} />
      </button>
    </div>
  );
}
