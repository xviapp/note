import { FILES_DIR } from './workspace.ts';

// A site-relative file link. Absolute URLs and links with a query stay as they are.
const FILE_LINK = /(?<![\w.:/%-])\/api\/files\/([a-zA-Z0-9_-]{1,80})(?![a-zA-Z0-9_?-])/g;
const LOCAL_LINK = new RegExp(
  `(?<![\\w./%-])(?:\\.{1,2}/)*${FILES_DIR.replace('.', '\\.')}/([a-zA-Z0-9_-]{1,80})\\.[a-zA-Z0-9]{1,10}(?![\\w.-])`,
  'g',
);
// Server text as it reads in the workspace: file links point at .xvi/files.
export function localizeLinks(content: string, names: Map<string, string>, notePath: string): string {
  const up = '../'.repeat(notePath.split('/').length - 1);
  return content.replace(FILE_LINK, (link, id: string) => {
    const name = names.get(id);
    return name ? `${up}${FILES_DIR}/${name}` : link;
  });
}
// Workspace text as the server keeps it; where the note sits no longer matters.
export const normalizeLinks = (content: string): string =>
  content.replace(LOCAL_LINK, (_link, id: string) => `/api/files/${id}`);
// The same text for a note moved to another depth, from the names in .xvi/files it uses.
export function relocateLinks(text: string, assets: string[] | undefined, path: string): string {
  const names = new Map((assets ?? []).map((name) => [name.replace(/\.[^.]+$/, ''), name]));
  return localizeLinks(normalizeLinks(text), names, path);
}
export const fileIdsIn = (content: string): string[] => [
  ...new Set([...content.matchAll(/\/api\/files\/([a-zA-Z0-9_-]{1,80})/g)].map((match) => match[1])),
];
export function replaceFileIds(content: string, copies: Record<string, string>): string {
  return content.replace(/\/api\/files\/([a-zA-Z0-9_-]{1,80})/g, (link, id: string) =>
    copies[id] ? `/api/files/${copies[id]}` : link,
  );
}
