import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Send } from 'lucide-react';
import { createNoteAppender } from '../append-note';
import { readDraft, removeDraft, writeDraft } from '../note-drafts';

// A reusable composer for adding a block to a text note without opening its editor.
export function QuickAppend({ id, keyId, disabled, blocked = false, onSaved, onAppend, actions, onBusy, timestamp = false, label = '追加', placeholder = '记下此刻，追加到正文…' }: {
  id: string;
  keyId?: string | null;
  disabled: boolean;
  blocked?: boolean;
  onSaved: () => void;
  onAppend?: (title: string, text: string, operationKey: string) => Promise<void>;
  actions?: ReactNode;
  onBusy?: (busy: boolean) => void;
  timestamp?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [focused, setFocused] = useState(false);
  const running = useRef(false);
  const operation = useRef(crypto.randomUUID());
  const field = useRef<HTMLTextAreaElement>(null);
  const append = useMemo(() => createNoteAppender(id, timestamp), [id, timestamp]);
  const customAppend = !!onAppend;
  const draftId = `append:${id}`;
  useEffect(() => {
    let live = true;
    void readDraft(draftId).then((draft) => {
      if (!live) return;
      if (draft) {
        try {
          const saved = JSON.parse(draft.content);
          if (typeof saved.title === 'string' && typeof saved.text === 'string') {
            setTitle(saved.title);
            setText(saved.text);
            if (customAppend && typeof saved.operationKey === 'string') {
              operation.current = saved.operationKey;
              setRetrying(saved.retrying === true);
            }
          }
        } catch { /* Ignore an invalid draft. */ }
      }
      setReady(true);
    });
    return () => { live = false; };
  }, [draftId, customAppend]);
  useEffect(() => {
    if (!ready) return;
    if (!title && !text) removeDraft(draftId);
    else writeDraft(draftId, {
      content: JSON.stringify({ title, text, ...(customAppend ? { operationKey: operation.current, retrying } : {}) }), attachments: [], revision: 0, savedAt: Date.now(),
    }, keyId);
  }, [draftId, keyId, ready, title, text, retrying, customAppend]);
  const save = async () => {
    if (running.current || disabled || blocked || !ready || !text.trim()) return;
    running.current = true;
    onBusy?.(true);
    setBusy(true);
    setError('');
    try {
      if (onAppend) {
        setRetrying(true);
        // Preserve the operation before sending, including across a reload.
        writeDraft(draftId, {
          content: JSON.stringify({ title, text, operationKey: operation.current, retrying: true }),
          attachments: [], revision: 0, savedAt: Date.now(),
        }, keyId);
        await onAppend(title, text, operation.current);
      } else await append(title, text);
      operation.current = crypto.randomUUID();
      setTitle('');
      setText('');
      setRetrying(false);
      removeDraft(draftId);
      onSaved();
      field.current?.focus();
    } catch (reason) {
      setError((reason as Error).message);
      // Keep the submitted input intact until the uncertain request is resolved.
      setRetrying(!(reason as Error).message.includes('正文已在其他页面更新'));
    } finally {
      running.current = false;
      onBusy?.(false);
      setBusy(false);
    }
  };
  return (
    <div className="quick-append-footer">
    <form className="quick-append" aria-label="快捷记录"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="quick-append-heading">
      <input aria-label="记录标题" placeholder="标题（可选）" value={title}
        disabled={busy || !ready || retrying} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="quick-append-body">
        <textarea ref={field} aria-label="记录内容" placeholder={placeholder} rows={4} value={text}
          disabled={busy || !ready || retrying} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
              event.preventDefault(); void save();
            }
          }} />
      {(focused || !!title || !!text || busy) && <div className="quick-append-actions">
        {actions}
        <button className="button primary compact" type="submit" disabled={disabled || blocked || busy || !ready || !text.trim()}>
          <Send size={15} />{busy ? '正在追加…' : retrying ? '重试追加' : label}
        </button>
      </div>}
      </div>
      {disabled && <small>联网后可追加内容</small>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </form>
    </div>
  );
}
