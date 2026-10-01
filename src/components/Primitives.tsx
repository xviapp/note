import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X, FileText, Folder, File, Image, Link, LoaderCircle, BookOpen } from 'lucide-react';
import type { NodeKind } from '../../shared/types';

export function NodeIcon({ kind, size = 17 }: { kind: NodeKind | 'arxiv'; size?: number }) {
  const Icon = {
    folder: Folder,
    markdown: FileText,
    text: File,
    pdf: BookOpen,
    image: Image,
    link: Link,
    arxiv: BookOpen,
  }[kind];
  return (
    <Icon size={size} strokeWidth={1.7} className={`node-icon kind-${kind}`} aria-hidden="true" />
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
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
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
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <X size={20} />
        </button>
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
