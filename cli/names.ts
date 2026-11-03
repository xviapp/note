import type { NoteNode } from '../shared/types.ts';

const MAX_NAME_BYTES = 200;
// Coding agents load these on their own, so a note must never take such a name.
const AGENT_FILE = /^(agents|claude|gemini)(\..*)?$/i;
const TEXT_SUFFIX = /\.(md|markdown|txt)$/i;
const FILE_SUFFIX = /\.(pdf|png|jpe?g|gif|webp|avif|svg)$/i;
const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const MIME_SUFFIX: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

function truncated(value: string): string {
  let bytes = 0,
    result = '';
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    if (bytes > MAX_NAME_BYTES) break;
    result += char;
  }
  return result;
}
// A title made safe as one path component. It cannot be hidden, or leave its directory.
export function safeStem(title: string): string {
  const cleaned = title
    .normalize('NFC')
    // oxlint-disable-next-line no-control-regex -- control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .trim()
    .replace(/^\.+/, (dots) => '_'.repeat(dots.length));
  const stem = truncated(cleaned).replace(/[. ]+$/, '');
  if (!stem) return '未命名';
  return AGENT_FILE.test(stem) ? `${stem}_` : stem;
}
const titleStem = (node: NoteNode): string =>
  node.title.replace(node.kind === 'markdown' || node.kind === 'text' ? TEXT_SUFFIX : FILE_SUFFIX, '');
// Siblings sharing a name all carry their ID, so a name does not depend on the
// listing order and stays put when one of them moves away.
export function assignNames(nodes: NoteNode[]): Map<string, string> {
  const stems = new Map(nodes.map((node) => [node.id, safeStem(titleStem(node))]));
  const uses = new Map<string, number>();
  const key = (stem: string) => stem.toLowerCase();
  for (const stem of stems.values()) uses.set(key(stem), (uses.get(key(stem)) ?? 0) + 1);
  return new Map(
    nodes.map((node) => {
      const stem = stems.get(node.id)!;
      return [node.id, uses.get(key(stem))! > 1 ? `${stem}~${node.id}` : stem];
    }),
  );
}
export const imageSuffixOfTitle = (title: string): string | null =>
  title.match(IMAGE_SUFFIX)?.[0].toLowerCase() ?? null;
// A file's suffix: from its type when known, else from a plain suffix on its name.
export function fileSuffix(name: string, mime: string): string {
  return MIME_SUFFIX[mime] ?? name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? '.bin';
}
