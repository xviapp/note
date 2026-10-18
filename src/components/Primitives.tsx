import { useEffect, useId, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { X, LoaderCircle, CornerUpRight } from 'lucide-react';
import { variantOf, type NoteNode, type NoteVariant } from '../../shared/types';
import type { ProjectCategory } from '../../shared/projects';
import { NOTE_TYPES, PROJECT_ICONS } from '../note-types/registry';
import { CachedImage } from './CachedImage';
import { fileUrl } from '../api';

export type IconType = NoteVariant | ProjectCategory;
// A node's icon from its type; pass `kind` alone for a type without a node.
export function NodeIcon({
  kind,
  size = 17,
  node,
}: {
  kind?: IconType;
  size?: number;
  node?: Partial<
    Pick<
      NoteNode,
      | 'kind'
      | 'variant'
      | 'arxiv_id'
      | 'icon_glyph'
      | 'icon_file_id'
      | 'reference_kind'
      | 'project_category'
    >
  >;
}) {
  const variant =
    kind ?? (node?.kind ? variantOf(node as Parameters<typeof variantOf>[0]) : 'markdown');
  // A custom icon (any kind of entry) comes first.
  if (node?.icon_glyph || node?.icon_file_id)
    return (
      <span
        className="node-icon custom-folder-icon"
        style={{ '--node-icon-size': `${size}px` } as CSSProperties}
        aria-hidden="true"
      >
        {node.icon_glyph || (
          <CachedImage icon src={fileUrl(node.icon_file_id!)} alt="" draggable={false} />
        )}
      </span>
    );
  if (node && variant === 'reference')
    return (
      <span className="node-reference-icon" aria-hidden="true">
        <NodeIcon kind={node.project_category || node.reference_kind || 'reference'} size={size} />
        <CornerUpRight size={Math.max(10, size * 0.65)} className="reference-arrow" />
      </span>
    );
  const shown: IconType =
    node?.project_category && (variant === 'folder' || variant === 'markdown')
      ? node.project_category
      : variant;
  const Icon =
    shown in PROJECT_ICONS
      ? PROJECT_ICONS[shown as ProjectCategory]
      : NOTE_TYPES[shown as NoteVariant].icon;
  return (
    <Icon size={size} strokeWidth={1.8} className={`node-icon kind-${shown}`} aria-hidden="true" />
  );
}
export function Spinner({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={22} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function ActivityDots() {
  return (
    <span className="activity-dots" role="status" aria-label="正在思考">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = '',
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  // Extra header buttons, before Close.
  actions?: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? 'modal-wide' : ''} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const r = ref.current!.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            close.current();
        }
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        {actions ? (
          <div className="modal-heading-actions">
            {actions}
            <button className="icon-button" aria-label="关闭" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        ) : (
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
type Question = {
  title: string;
  message: string;
  choices: { value: string; label: string; danger?: boolean }[];
  resolve: (answer: string) => void;
};
export function useQuestion() {
  const [question, setQuestion] = useState<Question | null>(null);
  const ask = (title: string, message: string, choices: Question['choices']) =>
    new Promise<string>((resolve) => setQuestion({ title, message, choices, resolve }));
  const answer = (value: string) => {
    question?.resolve(value);
    setQuestion(null);
  };
  const dialog = question ? (
    <Modal title={question.title} onClose={() => answer('cancel')}>
      <p className="dialog-copy">{question.message}</p>
      <div className="dialog-actions">
        {question.choices.map((choice, index) => (
          <button
            key={choice.value}
            className={
              choice.danger
                ? 'button danger'
                : index === question.choices.length - 1
                  ? 'button primary'
                  : 'button'
            }
            onClick={() => answer(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </Modal>
  ) : null;
  return {
    ask,
    dialog,
    confirm: async (title: string, message: string, ok = '确认', danger = false) =>
      (await ask(title, message, [
        { value: 'cancel', label: '取消' },
        { value: 'yes', label: ok, danger },
      ])) === 'yes',
  };
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function EmptyDirectory({ onNew }: { onNew: () => void }) {
  return (
    <div className="directory-empty">
      <p>此目录还没有内容</p>
      <button className="button primary" onClick={onNew}>创建笔记</button>
    </div>
  );
}

export type Confirm = (
  title: string,
  message: string,
  ok?: string,
  danger?: boolean,
) => Promise<boolean>;
