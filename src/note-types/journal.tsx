import { variantOf } from '../../shared/types';
import { longDate, weekday } from '../../shared/journals';
import { JournalPanel } from '../components/JournalPanel';
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
        />
      ),
    };
  if (note.journal_entry)
    return {
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
