// Links in imported Markdown (src/vault-import.ts): relative paths and
// Obsidian wikilinks become links into the library. `resolve` names where a
// target went: `link` for a link to it, `image` when it can be shown inline.
// Code (fenced blocks and inline spans) and web links are left as they are.
export type ResolveLink = (target: string, wiki: boolean) => { link: string; image?: string } | null;

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
// ![alt](target "title") and [text](target); the target may be <wrapped>.
const MARKDOWN = /(!?)\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
// ![[target#heading|alias]] and [[target|alias]].
const WIKI = /(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;
// An embed size such as |300 or |300x200 is not a caption.
const SIZE = /^\d+(?:x\d+)?$/;

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
// The file a Markdown link points at, without its #anchor or ?query.
const markdownTarget = (raw: string) =>
  decoded((raw.startsWith('<') ? raw.slice(1, -1) : raw).replace(/[?#].*$/, '')).trim();
// The note or file a wikilink names, without #heading or ^block.
const wikiTarget = (raw: string) => raw.replace(/#.*$/, '').trim();

function rewriteText(text: string, resolve: ResolveLink, missing: string[]) {
  return text
    .replace(MARKDOWN, (all, bang: string, label: string, raw: string) => {
      if (EXTERNAL.test(raw.replace(/^</, ''))) return all;
      const target = markdownTarget(raw);
      if (!target) return all;
      const found = resolve(target, false);
      if (!found) {
        missing.push(target);
        return all;
      }
      if (bang && found.image) return `![${label}](${found.image})`;
      return `[${label || target}](${found.link})`;
    })
    .replace(WIKI, (all, bang: string, raw: string, alias: string | undefined) => {
      const target = wikiTarget(raw);
      if (!target) return all;
      const found = resolve(target, true);
      if (!found) {
        missing.push(target);
        return all;
      }
      const caption = alias !== undefined && !SIZE.test(alias.trim()) ? alias.trim() : '';
      if (bang && found.image) return `![${caption}](${found.image})`;
      return `[${caption || target}](${found.link})`;
    });
}

// The content with every resolvable link rewritten, and the targets that
// could not be resolved (in order, repeated as often as they occur).
export function rewriteLinks(content: string, resolve: ResolveLink): { content: string; missing: string[] } {
  const missing: string[] = [];
  let fence: string | null = null;
  const lines = content.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim())
        fence = null;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    // Inline code spans stay as written; the text around them is rewritten.
    return line
      .split(/(`+[^`]*?`+)/)
      .map((part, index) => (index % 2 ? part : rewriteText(part, resolve, missing)))
      .join('');
  });
  return { content: lines.join('\n'), missing };
}
