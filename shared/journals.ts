// Journals: a folder with one Markdown note per day, filed in year and month
// folders. Templates are the Markdown notes in its `templates` folder.
export const TEMPLATES_FOLDER = 'templates';
export const RECENT_ENTRIES = 10;

export interface JournalEntry {
  id: string;
  date: string;
  title: string;
  // The first paragraph (sealed for an encrypted journal; the device opens it).
  excerpt: string | null;
}
export interface JournalTemplate {
  id: string;
  title: string;
}
export interface JournalMonth {
  // YYYY-MM
  month: string;
  entries: JournalEntry[];
  recent: JournalEntry[];
  templates: JournalTemplate[];
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
export function isJournalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
export const isJournalMonth = (value: unknown): value is string =>
  typeof value === 'string' && isJournalDate(`${value}-01`);
const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
// A day as the device sees it, in its own time zone.
export function localDate(at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
export function weekday(date: string): string {
  const [year, month, day] = parts(date);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}
export function longDate(date: string): string {
  const [year, month, day] = parts(date);
  return `${year}年${month}月${day}日`;
}
// The folders an entry is filed in.
export const yearFolder = (date: string) => `${parts(date)[0]}年`;
export const monthFolder = (date: string) => `${parts(date)[1]}月`;

// A template filled in for a day. Placeholders: {{date}} 2026-10-07,
// {{日期}} 2026年10月7日, {{星期}} 星期三, {{year}} {{month}} {{day}}.
export function fillTemplate(template: string, date: string): string {
  const [year, month, day] = parts(date);
  const values: Record<string, string> = {
    date,
    日期: longDate(date),
    星期: weekday(date),
    year: String(year),
    month: String(month),
    day: String(day),
  };
  return template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, name: string) =>
    Object.hasOwn(values, name) ? values[name] : all,
  );
}
export const defaultEntry = (date: string) => `# ${longDate(date)} ${weekday(date)}\n\n`;
