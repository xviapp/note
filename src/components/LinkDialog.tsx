import { useState } from 'react';
import { Modal } from './Primitives';
import { NodePicker } from './Tree';

export type LinkTarget = { id: string; title: string };

// Picks a note to link to from the Markdown being edited.
export function LinkDialog({
  onInsert,
  onClose,
}: {
  onInsert: (target: LinkTarget) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<LinkTarget | null>(null);
  return (
    <Modal title="插入笔记链接" onClose={onClose}>
      <NodePicker
        value={target?.id || null}
        onSelect={(id, title) => {
          if (id) setTarget({ id, title });
        }}
      />
      <div className="dialog-actions">
        <button className="button" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={!target}
          onClick={() => {
            if (target) onInsert(target);
            onClose();
          }}
        >
          插入链接
        </button>
      </div>
    </Modal>
  );
}

export const markdownLink = (target: LinkTarget) =>
  `[${target.title.replace(/[[\]\\]/g, '')}](/n/${target.id})`;
