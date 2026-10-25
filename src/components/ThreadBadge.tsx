import { MessagesSquare } from 'lucide-react';
import { useHasAssistantThread } from '../assistant-threads';

// Marks a note with a 青藜 conversation, found again in 青藜对话.
export function ThreadBadge({ id, size = 13 }: { id: string; size?: number }) {
  if (!useHasAssistantThread(id)) return null;
  return <MessagesSquare size={size} className="thread-badge" aria-label="有青藜对话" role="img" />;
}
