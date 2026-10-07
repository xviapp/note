import { appendRecord } from './records';

export const PROJECT_CATEGORIES = ['todo', 'issue', 'note'] as const;
export interface ProjectContext { id: string; category: ProjectCategory }
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];
export const PROJECT_LABELS: Record<ProjectCategory, string> = {
  todo: '待办',
  issue: '问题',
  note: '笔记',
};
export const PROJECT_STATUSES: Record<ProjectCategory, Record<string, string>> = {
  todo: { todo: '待办', doing: '进行中', done: '已完成' },
  issue: { open: '待处理', closed: '已关闭' },
  note: {},
};
export interface ProjectItem {
  id: string;
  category: ProjectCategory;
  title: string;
  status: string | null;
  summary: string;
  revision: number;
  updated_at: number;
}
export interface ProjectOverview {
  items: ProjectItem[];
  directories: { id: string; category: ProjectCategory; title: string }[];
  warnings: string[];
  indexing: number;
}
export function projectCategory(value: unknown): ProjectCategory | null {
  return typeof value === 'string' && PROJECT_CATEGORIES.includes(value as ProjectCategory)
    ? (value as ProjectCategory)
    : null;
}

// A deliberately small front matter contract: title and status are single-line
// scalars. Other fields are preserved verbatim when a status is changed.
function scalar(value: string): string | null {
  const text = value.trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const match = text.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (!match) return null;
    try {
      const decoded: unknown = JSON.parse(match[1]);
      return typeof decoded === 'string' ? decoded : null;
    } catch {
      return null;
    }
  }
  if (text.startsWith("'")) {
    const match = text.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    return match ? match[1].replace(/''/g, "'") : null;
  }
  if (/^[>|[\]{&*!]/.test(text)) return null;
  return text.replace(/\s+#.*$/, '').trim();
}
export function markdownFrontMatter(content: string) {
  const match = content.match(/^(\uFEFF?---\r?\n)((?:[^\n]*\n)*?)(---(?:\r?\n|$))/);
  return match ? [match[0], match[2]] : null;
}
export function markdownMetadata(content: string) {
  const front = markdownFrontMatter(content);
  const fields = (key: string) => [
    ...(front?.[1] ?? '').matchAll(new RegExp(`^${key}:[ \\t]*(.*)$`, 'gm')),
  ];
  const titles = fields('title'),
    statuses = fields('status');
  const title = titles.length === 1 ? scalar(titles[0][1]) : null;
  const status = statuses.length === 1 ? scalar(statuses[0][1]) : null;
  const body = front ? content.slice(front[0].length) : content;
  // Scan lines once, including unclosed fences. Restrict excerpt processing to
  // a short prefix so large notes or unmatched link syntax cannot stall saves.
  let fence: { character: string; length: number } | null = null;
  let heading: string | null = null;
  let excerptLength = 0;
  const paragraphs: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const firstHeading = line.match(/^[ \t]{0,3}#[ \t]+(.+?)[ \t]*$/);
    if (!heading && firstHeading) heading = firstHeading[1].replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (excerptLength < 2048 && line.trim() && !/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/.test(line)) {
      const snippet = line.slice(0, 2048 - excerptLength);
      paragraphs.push(snippet);
      excerptLength += snippet.length + 1;
    }
    if (excerptLength >= 2048 && (title?.trim() || heading)) break;
  }
  const summary = paragraphs
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return {
    title: (title?.trim() || heading || '').slice(0, 200) || null,
    status: status?.trim().slice(0, 80) || null,
    summary,
    front,
    statuses,
  };
}
export function setMarkdownStatus(content: string, status: string): string {
  const { front, statuses } = markdownMetadata(content);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  if (!front) {
    if (/^\uFEFF?---\r?\n/.test(content))
      throw new Error('文首资料缺少结束分隔线，请先编辑原文件。');
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
    return `${bom}---${newline}status: ${status}${newline}---${newline}${newline}${content.slice(bom.length)}`;
  }
  if (statuses.length > 1 || (statuses.length === 1 && scalar(statuses[0][1]) === null))
    throw new Error('状态需要使用单行文字，且只能填写一次，请先编辑原文件。');
  const fields = statuses.length
    ? front[1].replace(/^status:[^\r\n]*/m, `status: ${status}`)
    : `${front[1]}status: ${status}${newline}`;
  // A continuation under status (e.g. a YAML block) cannot safely be replaced.
  if (/^status:[^\n]*\r?\n[ \t]+\S/m.test(front[1]))
    throw new Error('状态需要使用单行文字，请先编辑原文件。');
  const opening = front[0].slice(0, front[0].indexOf('\n') + 1);
  const closing = front[0].slice(opening.length + front[1].length);
  return opening + fields + closing + content.slice(front[0].length);
}
export function projectMarkdown(category: ProjectCategory, title: string): string {
  const status = category === 'todo' ? 'todo' : category === 'issue' ? 'open' : null;
  return `---\ntitle: ${JSON.stringify(title)}\n${status ? `status: ${status}\n` : ''}---\n\n`;
}

// Statuses that end an item; closing one may carry a conclusion.
export const FINISHED_STATUSES: Partial<Record<ProjectCategory, string>> = { todo: 'done', issue: 'closed' };
export const CONCLUSION_LABELS: Partial<Record<ProjectCategory, string>> = { todo: '完成结果', issue: '结论' };

// The status line in the front matter, plus a record of the change in the
// item's discussion or progress section.
export function projectStatusContent(
  content: string,
  category: ProjectCategory,
  status: string,
  date: Date,
  offset: number,
  conclusion = '',
) {
  const before = markdownMetadata(content).status;
  const updated = setMarkdownStatus(content, status);
  if (before === status || category === 'note') return updated;
  const states = PROJECT_STATUSES[category];
  const change = `${states[before ?? ''] ?? before ?? '未设置'} → ${states[status]}`;
  return appendRecord(updated, category, change, status === FINISHED_STATUSES[category] ? conclusion : '', date, offset);
}
