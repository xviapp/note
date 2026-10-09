import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { variantOf } from '../../shared/types';
import { longDate, weekday } from '../../shared/journals';
import { JournalPanel } from '../components/JournalPanel';
import { QuickAppend } from '../components/QuickAppend';
import { createJournalRecorder } from '../journal-record';
import type { NoteNode } from '../../shared/types';
import type { TypeContext, TypeView } from './view';

// A journal: its calendar instead of a plain list. An entry tells 青藜 its
// day (see worker/journals.ts).
export function useJournalView(ctx: TypeContext): TypeView | null {
  const [headingActions, setHeadingActions] = useState<HTMLSpanElement | null>(null);
  const [pending, setPending] = useState<{ journalId: string; date: string } | null>(null);
  const result = useRef<{ node: NoteNode; created: boolean } | null>(null);
  const recorder = useMemo(() => pending && createJournalRecorder(pending.journalId, pending.date), [pending]);
  const [saved, setSaved] = useState<NoteNode | null>(null);
  const { note, appending, onChanged, onNavigate } = ctx;
  // Navigation must wait for the append leave guard to be released.
  useEffect(() => {
    if (!saved || appending) return;
    setSaved(null);
    setPending(null);
    onChanged();
    onNavigate(saved.id);
  }, [saved, appending, onChanged, onNavigate]);
  const draft = pending?.journalId === note?.id ? pending : null;
  if (!note) return null;
  const kind = { icon: <CalendarDays size={14} className="kind-journal" />, label: '日记' };
  if (variantOf(note) === 'journal') {
    const day = draft && `${longDate(draft.date)} ${weekday(draft.date)}`;
    return {
      ...(day ? { title: day, kind } : {}),
      headingActions: !ctx.editing && !draft && <span className="journal-heading-actions" ref={setHeadingActions} />,
      footer: !ctx.editing && draft && (
        <QuickAppend key={`journal:${note.id}:${draft.date}`} id={`journal:${note.id}:${draft.date}`}
          keyId={note.key_id} uploadScope={draft.journalId} disabled={ctx.offline} onBusy={ctx.setAppending} autoFocus
          onAppend={async (title, text, key, attachmentIds) => { result.current = await recorder!(title, text, key, attachmentIds); }}
          onSaved={() => setSaved(result.current!.node)} />
      ),
      children: !ctx.editing && (draft ? (
        <section className="journal-draft" aria-label="待记录的日记">
          <button className="text-button" disabled={ctx.appending} onClick={() => setPending(null)}><ChevronLeft size={15} />返回日历</button>
          <p className="muted">写下第一条记录后保存这篇日记。</p>
        </section>
      ) : <JournalPanel
          id={note.id}
          headingActions={headingActions}
          refresh={ctx.refreshKey}
          onNavigate={ctx.onNavigate}
          onPrepare={(date) => setPending({ journalId: note.id, date })}
        />
      ),
    };
  }
  if (note.journal_entry) {
    const { date, previous, next } = note.journal_entry;
    const day = `${longDate(date)} ${weekday(date)}`;
    const step = (entry: { id: string; date: string } | null | undefined, label: string, icon: ReactNode) => (
      <button className="icon-button" aria-label={label} title={entry ? `${longDate(entry.date)} ${weekday(entry.date)}` : undefined}
        disabled={!entry} onClick={() => entry && ctx.onNavigate(entry.id)}>{icon}</button>
    );
    return {
      title: day,
      kind,
      hideHeading: day,
      headingActions: !ctx.editing && (
        <span className="journal-steps">
          {step(previous, '前一篇日记', <ChevronLeft size={18} />)}
          {step(next, '后一篇日记', <ChevronRight size={18} />)}
        </span>
      ),
      records: 'journal',
      footer: !ctx.editing && (
        <QuickAppend id={note.id} keyId={note.key_id} kind="journal" disabled={ctx.offline}
          onBusy={ctx.setAppending}
          onSaved={() => { ctx.onAppended(); ctx.onNotice?.('已追加到正文'); }} />
      ),
      assistant: {
        context: (
          <span>
            已带上：{longDate(note.journal_entry.date)} {weekday(note.journal_entry.date)}的日记
          </span>
        ),
      },
    };
  }
  return null;
}
