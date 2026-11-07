import { markdownFrontMatter } from './projects';

export const BLOG_TITLE_LIMIT = 80;
export const BLOG_DESCRIPTION_LIMIT = 300;
export const BLOG_SLUG_LIMIT = 80;
export const BLOG_SUMMARY_LIMIT = 160;
// Letters and digits of any script, joined by single hyphens.
export const BLOG_SLUG = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

export function blogSlug(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, BLOG_SLUG_LIMIT)
    .replace(/^-+|-+$/g, '');
}

export function stripFrontMatter(content: string): string {
  const front = markdownFrontMatter(content);
  return front ? content.slice(front[0].length) : content;
}

// A leading H1 with the post's title repeats the page heading.
export function stripRepeatedTitle(content: string, title: string): string {
  const first = content.match(/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  return first && first[1].trim() === title.trim() ? content.slice(first[0].length) : content;
}

// The blog renders Markdown with raw HTML skipped, so comments and tags never
// reach visitors; nothing derived from the body (excerpt, summary) may either.
export const stripHtml = (content: string) =>
  content.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

// At most BLOG_SUMMARY_LIMIT UTF-16 units including the ellipsis, the unit the
// editor's maxLength and the API count. Latin text is cut at a word boundary.
export function clipSummary(text: string): string {
  if (text.length <= BLOG_SUMMARY_LIMIT) return text;
  let cut = '';
  for (const character of text) {
    if (cut.length + character.length > BLOG_SUMMARY_LIMIT - 1) break;
    cut += character;
  }
  if (/\w$/.test(cut) && /^\w/.test(text.slice(cut.length))) {
    const space = cut.lastIndexOf(' ');
    if (space > cut.length - 40) cut = cut.slice(0, space);
  }
  return `${cut.trimEnd()}…`;
}

export function blogExcerpt(content: string, title = ''): string {
  const text = stripHtml(
    stripRepeatedTitle(stripFrontMatter(content), title).replace(
      /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?:\n|$)|$)/gm,
      ' ',
    ),
  )
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, ' ')
    // Headings and tables read as noise in running text.
    .replace(/^[ \t]*#{1,6}[ \t].*$/gm, ' ')
    .replace(/^[ \t]*\|.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipSummary(text);
}

// Every file a body names; only these are served with the post.
export const blogFiles = (content: string): string[] => [
  ...new Set([...content.matchAll(/\/api\/files\/([a-zA-Z0-9_-]{1,80})/g)].map((match) => match[1])),
];

// `scheme` is the page's color-scheme; `colors` are the settings page's swatches
// (background, panel, link) and repeat src/blog/blog.css.
export const BLOG_THEMES = [
  { value: 'paper', label: '页间', scheme: 'light dark', colors: ['#f9efe2', '#fff8ef', '#895332'] },
  { value: 'typing', label: '打字机', scheme: 'light', colors: ['#e4ca91', '#ffe6b0', '#b80d19'] },
  { value: 'whiteglass', label: '素白', scheme: 'light', colors: ['#ffffff', '#ffffff', '#5c5c5c'] },
  { value: 'littlegirl', label: '粉紫', scheme: 'light', colors: ['#ef9ec7', '#fab5e4', '#5e1f8a'] },
  { value: 'hacking', label: '终端', scheme: 'dark', colors: ['#000000', '#0a0a0a', '#1ad62a'] },
  { value: 'cloudysky', label: '晴空', scheme: 'light', colors: ['#f7f7f7', '#f3f3f3', '#2f5bd0'] },
] as const;
export const DEFAULT_BLOG_THEME = 'paper';

// The blog's sections: a first-level folder of the blog listed as posts, or a
// note shown at a fixed address. The one chosen as home is shown at /.
export const BLOG_PAGES = [
  { key: 'articles', label: '文章', path: '/blog', kind: 'folder' },
  { key: 'projects', label: '项目', path: '/projects', kind: 'folder' },
  { key: 'resume', label: '简历', path: '/resume', kind: 'note' },
  { key: 'contact', label: '联系', path: '/contact', kind: 'note' },
  { key: 'about', label: '关于', path: '/about', kind: 'note' },
] as const;
export type BlogPageKey = (typeof BLOG_PAGES)[number]['key'];
export const DEFAULT_BLOG_HOME: BlogPageKey = 'articles';
// The pages a note is chosen for (blog_posts.page).
export const NOTE_PAGES: readonly string[] = BLOG_PAGES.filter((page) => page.kind === 'note').map((page) => page.key);
export const isBlogPage = (key: unknown): key is BlogPageKey => BLOG_PAGES.some((page) => page.key === key);
export const blogPagePath = (key: string, home: string = DEFAULT_BLOG_HOME) =>
  key === home ? '/' : (BLOG_PAGES.find((page) => page.key === key)?.path ?? null);
