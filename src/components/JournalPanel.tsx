import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, PenLine } from 'lucide-react';
import { api } from '../api';
import type { NoteDetail, NoteNode } from '../../shared/types';
import {
  defaultEntry,
  fillTemplate,
  localDate,
  longDate,
  weekday,
  type JournalEntry,
  type JournalMonth,
} from '../../shared/journals';
import { Spinner } from './Primitives';

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
const templateKey = (id: string) => `journal-template:${id}`;
function savedTemplate(id: string) {
  try {
    return localStorage.getItem(templateKey(id)) || '';
  } catch {
    return '';
  }
}

// A journal's calendar: a day with an entry opens it, an empty day (up to
// today) starts one from the chosen template.
export function JournalPanel({
  id,
  refresh,
  offline,
  onNavigate,
  onCreated,
}: {
  id: string;
  refresh: number;
  offline: boolean;
  onNavigate: (id: string) => void;
  onCreated: (node: NoteNode) => void;
}) {
  const today = localDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState<JournalMonth | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [template, setTemplate] = useState(() => savedTemplate(id));
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
    if (known) return onNavigate(known.id);
    setBusy(date);
    setError('');
    try {
      let content = defaultEntry(date);
      if (chosen) {
        const source = await api<NoteDetail>(`/api/nodes/${chosen.id}`);
        if (source.locked) throw new Error('模板已加密，请先解锁。');
        content = fillTemplate(source.content, date);
      }
      const result = await api<{ node: NoteNode; created: boolean }>(
        `/api/nodes/${id}/journal/entries`,
        'POST',
        { date, content },
      );
      if (result.created) onCreated(result.node);
      else onNavigate(result.node.id);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };
  const label = (date: string, entry?: JournalEntry) =>
    `${longDate(date)} ${weekday(date)}${entry ? '，已写' : date > today ? '' : '，未写'}`;
  return (
    <section className="journal-panel">
      <div className="journal-header">
        <button
          className="button primary compact"
          disabled={offline || !!busy}
          onClick={() => void write(today)}
        >
          <PenLine size={15} />
          {entries.has(today) ? '打开今天的日记' : '写今天的日记'}
        </button>
        {!!data?.templates.length && (
          <label className="journal-template">
            模板
            <select
              value={chosen?.id ?? ''}
              onChange={(event) => {
                setTemplate(event.target.value);
                try {
                  localStorage.setItem(templateKey(id), event.target.value);
                } catch {
                  /* Optional preference. */
                }
              }}
            >
              <option value="">默认</option>
              {data.templates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title.replace(/\.md$/i, '')}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
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
                      className={[entries.has(date) && 'has-entry', date === today && 'is-today']
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={label(date, entries.get(date))}
                      title={entries.get(date)?.title}
                      disabled={date > today || (offline && !entries.has(date)) || !!busy}
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
      {busy && <Spinner label="正在新建日记…" />}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <Spinner />}
      {!!data?.recent.length && (
        <>
          <h3 className="journal-recent-title">最近的日记</h3>
          <div className="project-items">
            {data.recent.map((entry) => (
              <div className="project-item" key={entry.id}>
                <button className="project-item-main" onClick={() => onNavigate(entry.id)}>
                  <span>
                    <strong>
                      {longDate(entry.date)} {weekday(entry.date)}
                    </strong>
                    {entry.excerpt && <small>{entry.excerpt}</small>}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
