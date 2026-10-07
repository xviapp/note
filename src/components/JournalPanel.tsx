import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, PenLine, Plus } from 'lucide-react';
import { api } from '../api';
import type { NoteDetail } from '../../shared/types';
import {
  defaultEntry,
  fillTemplate,
  localDate,
  longDate,
  weekday,
  type JournalEntry,
  type JournalMonth,
} from '../../shared/journals';
import { hasDraft, readDraft } from '../note-drafts';
import { Spinner } from './Primitives';
import { JournalTemplates } from './JournalTemplates';

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const shift = (month: string, by: number) => {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 1 + by, 1));
  return date.toISOString().slice(0, 7);
};
// The month's days in weeks starting on Monday; null pads the first week.
function weeks(month: string): (string | null)[][] {
  const [year, value] = month.split('-').map(Number);
  const first = (new Date(Date.UTC(year, value - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, value, 0)).getUTCDate();
  const days: (string | null)[] = Array(first).fill(null);
  for (let day = 1; day <= count; day++) days.push(`${month}-${String(day).padStart(2, '0')}`);
  while (days.length % 7) days.push(null);
  return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
}
// A recent entry's day, with its year only when it is not this year's.
function shortDate(date: string, today: string) {
  const [year, month, day] = date.split('-').map(Number);
  return `${date.slice(0, 4) === today.slice(0, 4) ? '' : `${year}年`}${month}月${day}日`;
}
const templateKey = (id: string) => `journal-template:${id}`;
function savedTemplate(id: string) {
  try {
    return localStorage.getItem(templateKey(id)) || '';
  } catch {
    return '';
  }
}

// A journal's calendar: a day with an entry opens it, an empty day (up to
// today) previews the chosen template without creating a note.
export function JournalPanel({
  id,
  refresh,
  headingActions,
  managing,
  onManageTemplates,
  onCloseTemplates,
  offline,
  onNavigate,
  onPrepare,
  onChanged,
}: {
  id: string;
  refresh: number;
  headingActions: HTMLElement | null;
  managing: boolean;
  onManageTemplates: () => void;
  onCloseTemplates: () => void;
  offline: boolean;
  onNavigate: (id: string) => void;
  onPrepare: (date: string, content: string) => void;
  onChanged: () => void;
}) {
  const today = localDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState<JournalMonth | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [template, setTemplate] = useState(() => savedTemplate(id));
  const selectTemplate = (value: string) => {
    setTemplate(value);
    try { localStorage.setItem(templateKey(id), value); }
    catch { /* Optional preference. */ }
  };
  useEffect(() => {
    let live = true;
    setError('');
    api<JournalMonth>(`/api/nodes/${id}/journal?month=${month}`)
      .then((result) => {
        if (live) setData(result);
      })
      .catch((reason: Error) => {
        if (live) setError(reason.message);
      });
    return () => {
      live = false;
    };
  }, [id, month, refresh]);
  const entries = useMemo(
    () => new Map((data?.month === month ? data.entries : []).map((entry) => [entry.date, entry])),
    [data, month],
  );
  const chosen = data?.templates.find((item) => item.id === template) ?? null;
  const write = async (date: string) => {
    const known = entries.get(date) ?? data?.recent.find((entry) => entry.date === date);
    setBusy(date);
    setError('');
    try {
      const draft = await readDraft(`append:journal:${id}:${date}`);
      if (known && !draft) return onNavigate(known.id);
      let content = defaultEntry(date);
      if (chosen) {
        const source = await api<NoteDetail>(`/api/nodes/${chosen.id}`);
        if (source.locked) throw new Error('模板已加密，请先解锁。');
        content = fillTemplate(source.content, date);
      }
      onPrepare(date, content);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };
  // Unsent input kept on this device, before or after the day's entry exists.
  const drafted = (date: string) => {
    const entry = entries.get(date);
    return hasDraft(`append:journal:${id}:${date}`) || (!!entry && hasDraft(`append:${entry.id}`));
  };
  const label = (date: string, entry?: JournalEntry) =>
    `${longDate(date)} ${weekday(date)}${entry ? '，已写' : date > today ? '' : '，未写'}${drafted(date) ? '，有未提交的记录' : ''}`;
  return (
    <section className="journal-panel">
      {headingActions && createPortal(
        <button
          className="button primary compact"
          disabled={!data || !!busy}
          onClick={() => void write(today)}
        >
          {entries.has(today) ? <><PenLine size={15} />续写今天</> : <><Plus size={15} />写今天</>}
        </button>,
        headingActions,
      )}
      <div className="journal-layout">
        <div className="journal-calendar-column">
          <div className="journal-month">
            <button
              className="icon-button"
              aria-label="上个月"
              onClick={() => setMonth((value) => shift(value, -1))}
            >
              <ChevronLeft size={18} />
            </button>
            <h2>{`${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`}</h2>
            <button
              className="icon-button"
              aria-label="下个月"
              disabled={month >= today.slice(0, 7)}
              onClick={() => setMonth((value) => shift(value, 1))}
            >
              <ChevronRight size={18} />
            </button>
            {month !== today.slice(0, 7) && (
              <button className="text-button" onClick={() => setMonth(today.slice(0, 7))}>
                今天
              </button>
            )}
          </div>
          <table className="journal-calendar">
            <thead>
              <tr>
                {WEEK.map((day) => (
                  <th key={day} scope="col">
                    {day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks(month).map((week, index) => (
                <tr key={index}>
                  {week.map((date, day) =>
                    date ? (
                      <td key={date}>
                        <button
                          className={[entries.has(date) && 'has-entry', drafted(date) && 'has-draft', date === today && 'is-today']
                            .filter(Boolean)
                            .join(' ')}
                          aria-label={label(date, entries.get(date))}
                          title={entries.get(date)?.title}
                          disabled={date > today || !data || !!busy}
                          onClick={() => void write(date)}
                        >
                          {Number(date.slice(8))}
                        </button>
                      </td>
                    ) : (
                      <td key={`empty-${day}`} />
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {data && (
            <button className="text-button journal-template" onClick={onManageTemplates}>
              模板：{chosen ? chosen.title.replace(/\.md$/i, '') : '仅日期标题'}
            </button>
          )}
          {busy && <Spinner label="正在打开日记…" />}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {!data && !error && <Spinner />}
        </div>
        {!!data?.recent.length && (
          <section className="journal-recent" aria-labelledby="journal-recent-title">
            <h3 id="journal-recent-title">最近的日记</h3>
            <ol>
              {data.recent.map((entry) => (
                <li key={entry.id}>
                  <button aria-label={`${longDate(entry.date)} ${weekday(entry.date)}`} onClick={() => onNavigate(entry.id)}>
                    <span className="journal-recent-date">
                      <strong>{shortDate(entry.date, today)}</strong>
                      <small>{weekday(entry.date)}</small>
                    </span>
                    <span className="journal-recent-excerpt">{entry.excerpt || '（无摘要）'}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
      {managing && data && <JournalTemplates journalId={id} data={data} selected={chosen?.id ?? ''}
        offline={offline} onSelect={selectTemplate} onClose={onCloseTemplates}
        onChanged={async () => {
          setData(await api<JournalMonth>(`/api/nodes/${id}/journal?month=${month}`));
          onChanged();
        }} />}
    </section>
  );
}
