import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { variantOf } from '../../shared/types';
import { longDate, weekday } from '../../shared/journals';
import { JournalPanel } from '../components/JournalPanel';
import { QuickAppend } from '../components/QuickAppend';
import { MarkdownView } from '../components/LazyMarkdown';
import { createJournalRecorder } from '../journal-record';
import type { NoteNode } from '../../shared/types';
import type { TypeContext, TypeView } from './view';

// A journal: its calendar instead of a plain list. An entry tells 青藜 its
// day (see worker/journals.ts).
export function useJournalView(ctx: TypeContext): TypeView | null {
  const [headingActions, setHeadingActions] = useState<HTMLSpanElement | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [pending, setPending] = useState<{ journalId: string; date: string; content: string } | null>(null);
  const result = useRef<{ node: NoteNode; created: boolean } | null>(null);
  const recorder = useMemo(() => pending && createJournalRecorder(pending.journalId, pending.date, pending.content), [pending]);
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
  if (variantOf(note) === 'journal')
    return {
      headingActions: !ctx.editing && !draft && <span className="journal-heading-actions" ref={setHeadingActions} />,
      menu: !draft && <button onClick={() => setManaging(note.id)}>管理模板</button>,
      footer: !ctx.editing && draft && (
        <QuickAppend key={`journal:${note.id}:${draft.date}`} id={`journal:${note.id}:${draft.date}`}
          keyId={note.key_id} disabled={ctx.offline} onBusy={ctx.setAppending}
          onAppend={async (title, text, key) => { result.current = await recorder!(title, text, key); }}
          onSaved={() => setSaved(result.current!.node)} />
      ),
      children: !ctx.editing && (draft ? (
        <section className="journal-draft" aria-label="待记录的日记">
          <button className="text-button" disabled={ctx.appending} onClick={() => setPending(null)}><ChevronLeft size={15} />返回日历</button>
          <p className="muted">{longDate(draft.date)}的日记尚未保存：在下方写下第一条记录后才会创建，未提交的输入保留在本设备。</p>
          <div className="journal-draft-preview">
            <MarkdownView content={draft.content} onNavigate={ctx.onNavigate} onImage={() => {}} safeImages />
          </div>
        </section>
      ) : <JournalPanel
          id={note.id}
          headingActions={headingActions}
          managing={managing === note.id}
          onCloseTemplates={() => setManaging(null)}
          refresh={ctx.refreshKey}
          offline={ctx.offline}
          onNavigate={ctx.onNavigate}
          onPrepare={(date, content) => setPending({ journalId: note.id, date, content })}
          onChanged={ctx.onChanged}
        />
      ),
    };
  if (note.journal_entry)
    return {
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
  return null;
}
