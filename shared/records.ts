// Records appended below a note without opening its editor. Each kind keeps a
// plain Markdown shape that reads well in any editor; the app recognizes the
// record headings and styles them by kind (see src/records.ts).
//
//   issue / todo  ## 讨论 | ## 进展, then "### 2026-10-07 14:05 · 标题"
//   journal       "### 14:05 · 标题" (the entry already carries its day)
//   note          "## 标题" and text, no time
export type RecordKind = 'journal' | 'issue' | 'todo' | 'note';
export const RECORD_SECTIONS: Partial<Record<RecordKind, string>> = { issue: '讨论', todo: '进展' };
export const RECORD_SEPARATOR = ' · ';

// Local time to the minute: "2026-10-07 14:05", or "14:05" without the date.
export function recordStamp(date = new Date(), offset = -date.getTimezoneOffset(), withDate = true) {
  const local = new Date(date.getTime() + offset * 60_000).toISOString();
  return withDate ? `${local.slice(0, 10)} ${local.slice(11, 16)}` : local.slice(11, 16);
}

// The format written before records had kinds; still recognized when reading.
export function recordTime(date = new Date(), offset = -date.getTimezoneOffset()) {
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const value = Math.abs(offset);
  return `${local} ${offset < 0 ? '-' : '+'}${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

const separated = (content: string) =>
  content ? (content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n') : '';
const oneLine = (value: string) => value.trim().replace(/[\r\n]+/g, ' ');

export function appendContent(content: string, title: string, text: string, markdown = true, time?: string) {
  const heading = oneLine(title);
  const block = `${heading ? `${markdown ? '## ' : ''}${heading}\n\n` : ''}${time ? `> ${time}\n\n` : ''}${text.trim()}`;
  return `${content}${separated(content)}${block}\n`;
}

// Adds a block at the end of a "## name" section, creating the section at the
// end of the note when it is missing. Headings inside code fences are ignored.
function appendToSection(content: string, section: string, block: string) {
  const lines = content.split('\n');
  let fence = '';
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || marker[0] === fence[0])) {
      fence = fence ? '' : marker;
      continue;
    }
    if (fence) continue;
    if (start < 0) {
      if (line.trim() === `## ${section}`) start = index;
    } else if (/^#{1,2}\s/.test(line)) {
      end = index;
      break;
    }
  }
  if (start < 0) return `${content}${separated(content)}## ${section}\n\n${block}\n`;
  if (end === lines.length) return `${content}${separated(content)}${block}\n`;
  const before = lines.slice(0, end).join('\n').replace(/\s+$/, '');
  return `${before}\n\n${block}\n\n${lines.slice(end).join('\n')}`;
}

export function recordBlock(stamp: string, title: string, text: string) {
  const heading = oneLine(title);
  return `### ${stamp}${heading ? `${RECORD_SEPARATOR}${heading}` : ''}${text.trim() ? `\n\n${text.trim()}` : ''}`;
}

export function appendRecord(
  content: string,
  kind: RecordKind,
  title: string,
  text: string,
  date = new Date(),
  offset = -date.getTimezoneOffset(),
) {
  if (kind === 'note') return appendContent(content, title, text);
  if (kind === 'journal')
    return `${content}${separated(content)}${recordBlock(recordStamp(date, offset, false), title, text)}\n`;
  return appendToSection(content, RECORD_SECTIONS[kind]!, recordBlock(recordStamp(date, offset), title, text));
}
