import { variantOf } from '../../shared/types';
import { longDate, weekday } from '../../shared/journals';
import { JournalPanel } from '../components/JournalPanel';
import { QuickAppend } from '../components/QuickAppend';
import type { TypeContext, TypeView } from './view';

// A journal: its calendar instead of a plain list. An entry tells 青藜 its
// day (see worker/journals.ts).
export function useJournalView(ctx: TypeContext): TypeView | null {
  const { note } = ctx;
  if (!note) return null;
  if (variantOf(note) === 'journal')
    return {
      children: !ctx.editing && (
        <JournalPanel
          id={note.id}
          refresh={ctx.refreshKey}
          offline={ctx.offline}
          onNavigate={ctx.onNavigate}
          onCreated={ctx.onCreated}
          onChanged={ctx.onChanged}
        />
      ),
    };
  if (note.journal_entry)
    return {
      footer: !ctx.editing && (
        <QuickAppend id={note.id} keyId={note.key_id} disabled={ctx.offline}
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
