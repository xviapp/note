import { useState } from 'react';
import { FileDown, Pencil } from 'lucide-react';
import { ANNOTATION_NOTE_CHARS, type Annotation } from '../../shared/annotations';
import { annotationOrder } from '../annotations';
import { Modal } from './Primitives';
import { QingliIcon } from './QingliIcon';

export type AnnotationDraft = Pick<Annotation, 'id' | 'quote' | 'note' | 'location'> & {
  // False while it exists only on screen, before the first save.
  saved: boolean;
};

// One highlight: its quote and an editable note.
export function AnnotationEditor({
  draft,
  offline,
  onSave,
  onDelete,
  onAsk,
  onClose,
}: {
  draft: AnnotationDraft;
  offline: boolean;
  onSave: (note: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onAsk: (note: string) => string | undefined;
  onClose: () => void;
}) {
  const [note, setNote] = useState(draft.note),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={draft.saved ? '批注' : '添加批注'} className="annotation-modal" onClose={onClose}>
      <blockquote className="annotation-quote">{draft.quote}</blockquote>
      <textarea
        className="annotation-note-input"
        aria-label="批注内容"
        placeholder={offline ? '离线时只能查看批注' : '写下你的想法（可留空，仅高亮）'}
        value={note}
        maxLength={ANNOTATION_NOTE_CHARS}
        readOnly={offline}
        autoFocus={!offline}
        rows={5}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !offline) {
            event.preventDefault();
            void run(() => onSave(note));
          }
        }}
      />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions annotation-actions">
        {draft.saved && (
          <button
            className="button danger-text"
            disabled={busy || offline}
            onClick={() => void run(onDelete)}
          >
            删除
          </button>
        )}
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            const failed = onAsk(note);
            if (failed) setError(failed);
            else onClose();
          }}
        >
          <QingliIcon size={18} />
          问青藜
        </button>
        <button
          className="button primary"
          disabled={busy || offline}
          onClick={() => void run(() => onSave(note))}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

// Every highlight of the file in reading order; one opens its place.
export function AnnotationList({
  list,
  missing,
  offline,
  onLocate,
  onEdit,
  onExport,
  onClose,
}: {
  list: Annotation[];
  missing: Set<string>;
  offline: boolean;
  onLocate: (annotation: Annotation) => void;
  onEdit: (annotation: Annotation) => void;
  onExport: () => Promise<string>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null),
    [busy, setBusy] = useState(false);
  const sorted = [...list].sort(annotationOrder);
  return (
    <Modal title={`批注（${list.length}）`} className="annotation-list-modal" onClose={onClose}>
      <div className="annotation-list-tools">
        <button
          className="button compact"
          disabled={busy || offline || !list.length}
          onClick={async () => {
            setBusy(true);
            setStatus({ error: false, text: '正在保存为子笔记…' });
            try {
              setStatus({ error: false, text: await onExport() });
            } catch (e) {
              setStatus({ error: true, text: `未保存为子笔记：${(e as Error).message}` });
            }
            setBusy(false);
          }}
        >
          <FileDown size={15} />
          导出为子笔记
        </button>
      </div>
      {status && (
        <p
          className={status.error ? 'inline-error' : 'annotation-list-status'}
          role={status.error ? 'alert' : 'status'}
        >
          {status.text}
        </p>
      )}
      {sorted.length ? (
        <ul className="annotation-items">
          {sorted.map((item) => (
            <li key={item.id} className={missing.has(item.id) ? 'is-missing' : undefined}>
              <button
                className="annotation-item"
                disabled={missing.has(item.id)}
                onClick={() => onLocate(item)}
              >
                <span className="annotation-item-quote">{item.quote}</span>
                {item.note && <span className="annotation-item-note">{item.note}</span>}
                {missing.has(item.id) && (
                  <span className="annotation-item-missing">原文已修改，无法定位</span>
                )}
              </button>
              <button
                className="icon-button"
                aria-label="编辑批注"
                title="编辑批注"
                onClick={() => onEdit(item)}
              >
                <Pencil size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="annotation-empty">选中正文中的文字，点「高亮」或「批注」即可添加。</p>
      )}
    </Modal>
  );
}
