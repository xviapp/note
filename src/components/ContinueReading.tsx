import { BookOpen, ChevronRight } from 'lucide-react';
import { useNodeListing } from '../use-node-listing';
import type { NoteNode } from '../../shared/types';

// Where reading stopped, as the reading position can say it.
function progress(node: NoteNode): string {
  if (node.book_page_number) return `第 ${node.book_page_number} 页`;
  const position = node.reading_position ?? {};
  if (node.kind === 'pdf' && position.page) return `读到第 ${position.page} 页`;
  if (position.ratio && position.ratio > 0.02)
    return position.ratio > 0.98 ? '已读到末尾' : `读到 ${Math.round(position.ratio * 100)}%`;
  return '上次打开';
}

// The home page's way back into the last thing read (the server leaves out
// folders, images, journal entries and project items).
export function ContinueReading({
  refresh,
  onOpen,
}: {
  refresh: number;
  onOpen: (node: NoteNode) => void;
}) {
  const { listing } = useNodeListing('view=continue', refresh);
  const last = listing?.nodes[0];
  if (!last) return null;
  return (
    <button className="continue-reading" onClick={() => onOpen(last)}>
      <BookOpen size={20} aria-hidden="true" />
      <span className="continue-reading-text">
        <span className="continue-reading-label">继续阅读 · {progress(last)}</span>
        <strong>{last.book_title ?? last.title}</strong>
      </span>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
}
