import { useState } from 'react';
import { api } from '../api';
import { type NoteNode } from '../../shared/types';
import { Modal } from './Primitives';
import { NodePicker } from './Tree';

export function MoveDialog({
  nodes,
  onClose,
  onSaved,
  onMoveMany,
}: {
  nodes: NoteNode[];
  onClose: () => void;
  // One note was moved.
  onSaved: (parent: string | null, title: string, ancestors: string[]) => void;
  // Several selected notes: the caller moves them (see useMoveNotes' dropMany).
  onMoveMany: (parent: string | null, title: string, ancestors: string[]) => Promise<unknown>;
}) {
  const [node] = nodes;
  const [parent, setParent] = useState<string | null>(node.parent_id),
    [title, setTitle] = useState('原位置'),
    [ancestors, setAncestors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={nodes.length > 1 ? `移动 ${nodes.length} 项` : `移动「${node.title}」`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <NodePicker
        value={parent}
        parentsOnly
        exclude={nodes.map((item) => item.id)}
        onSelect={(id, name, path) => {
          setParent(id);
          setTitle(name);
          setAncestors(path);
        }}
      />
      <p className="small muted">移动到：{title}</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || nodes.every((item) => item.parent_id === parent)}
          onClick={async () => {
            setBusy(true);
            try {
              if (nodes.length > 1) {
                await onMoveMany(parent, title, ancestors);
                onClose();
                return;
              }
              await api(`/api/nodes/${node.id}`, 'PATCH', {
                parentId: parent,
                revision: node.revision,
              });
              onSaved(parent, title, ancestors);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          确认移动
        </button>
      </div>
    </Modal>
  );
}
