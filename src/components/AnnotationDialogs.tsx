import { useState } from 'react';
import { FileDown, Pencil, X } from 'lucide-react';
import {
  ANNOTATION_COLORS,
  ANNOTATION_NOTE_CHARS,
  annotationOrder,
  colorOf,
  type Annotation,
  type AnnotationColor,
} from '../../shared/annotations';
import { Modal } from './Primitives';
import { QingliIcon } from './QingliIcon';

export type AnnotationDraft = Pick<Annotation, 'id' | 'quote' | 'note' | 'location' | 'color'> & {
  // False while it exists only on screen, before the first save.
  saved: boolean;
};
const colors = Object.entries(ANNOTATION_COLORS) as [AnnotationColor, string][];

// One highlight: its quote, colour and an editable note.
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
  onSave: (note: string, color: AnnotationColor) => Promise<void>;
  onDelete: () => Promise<void>;
  onAsk: (note: string) => string | undefined;
  onClose: () => void;
}) {
  const [note, setNote] = useState(draft.note),
    [color, setColor] = useState(colorOf(draft)),
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
      <blockquote className={`annotation-quote color-${color}`}>{draft.quote}</blockquote>
      <div className="annotation-colors" role="radiogroup" aria-label="高亮颜色">
        {colors.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={color === value}
            aria-label={label}
            title={label}
            className={`annotation-swatch color-${value}`}
            disabled={offline}
            onClick={() => setColor(value)}
          />
        ))}
      </div>
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
            void run(() => onSave(note, color));
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
          onClick={() => void run(() => onSave(note, color))}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

type ListProps = {
  list: Annotation[];
  missing: Set<string>;
  offline: boolean;
  // The one last opened, marked in the side panel.
  current?: string;
  onLocate: (annotation: Annotation) => void;
  onEdit: (annotation: Annotation) => void;
  onExport: () => Promise<string>;
};

// Every highlight of the file in reading order, filtered by colour; one
// opens its place.
function AnnotationItems({
  list,
  missing,
  offline,
  current,
  onLocate,
  onEdit,
  onExport,
}: ListProps) {
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState<AnnotationColor | 'all'>('all');
  const used = colors.filter(([value]) => list.some((item) => colorOf(item) === value));
  const shown = [...list]
    .filter((item) => filter === 'all' || colorOf(item) === filter)
    .sort(annotationOrder);
  return (
    <>
      <div className="annotation-list-tools">
        {used.length > 1 && (
          <div className="annotation-filter" role="group" aria-label="按颜色筛选">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              全部
            </button>
            {used.map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                aria-label={`只看${label}`}
                title={`只看${label}`}
                onClick={() => setFilter(value)}
              >
                <span className={`annotation-dot color-${value}`} aria-hidden="true" />
                {list.filter((item) => colorOf(item) === value).length}
              </button>
            ))}
          </div>
        )}
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
      {shown.length ? (
        <ul className="annotation-items">
          {shown.map((item) => (
            <li
              key={item.id}
              className={
                [missing.has(item.id) && 'is-missing', current === item.id && 'is-current']
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            >
              <button
                className="annotation-item"
                disabled={missing.has(item.id)}
                aria-current={current === item.id ? 'location' : undefined}
                onClick={() => onLocate(item)}
              >
                <span className={`annotation-item-quote color-${colorOf(item)}`}>{item.quote}</span>
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
    </>
  );
}

// On phones and narrow windows: a dialog that closes when one is opened.
export function AnnotationList({ onClose, ...props }: ListProps & { onClose: () => void }) {
  return (
    <Modal
      title={`批注（${props.list.length}）`}
      className="annotation-list-modal"
      onClose={onClose}
    >
      <AnnotationItems {...props} />
    </Modal>
  );
}

// On wide screens: a panel beside the text that stays open while reading.
export function AnnotationPanel({ onClose, ...props }: ListProps & { onClose: () => void }) {
  return (
    <aside
      className="annotation-panel"
      aria-label={`批注（${props.list.length}）`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="toc-heading">
        <span>批注（{props.list.length}）</span>
        <button className="icon-button" aria-label="关闭批注面板" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <AnnotationItems {...props} />
    </aside>
  );
}
