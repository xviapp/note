import { incomingShareTitle, isTextFile, sharedUrl, type IncomingShare } from './shared-import';

// What a share holds decides the window it opens in and the note it becomes.
export type ShareKind = 'arxiv' | 'link' | 'markdown' | 'text' | 'pdf' | 'image' | 'files';

export interface ShareClass {
  kind: ShareKind;
  title: string;
  // For links and papers: the address that is saved or imported.
  url?: string;
  arxivId?: string;
}

const ARXIV_ID = String.raw`(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?`;
const ARXIV_URL = new RegExp(
  String.raw`https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/(${ARXIV_ID})(?:\.pdf)?\/?(?=[\s)\]>"']|$)`,
  'i',
);
const ARXIV_TAG = new RegExp(String.raw`\barxiv:\s*(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)\b`, 'i');
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
// Beyond a title or a sentence of context, a shared text is an excerpt to keep.
const CONTEXT = 300;

// A paper link or "arXiv:2501.12948" with at most a short caption around it.
export function arxivOf(text: string): { id: string; url: string; rest: string } | null {
  const match = text.match(ARXIV_URL) ?? text.match(ARXIV_TAG);
  if (!match) return null;
  const rest = text.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
  if (rest.length > CONTEXT) return null;
  return { id: match[1]!, url: `https://arxiv.org/abs/${match[1]}`, rest };
}

// One web address, alone or after a page title as browsers share it.
export function linkOf(text: string): { url: string; rest: string } | null {
  const found = text.match(URL_IN_TEXT);
  if (found?.length !== 1) return null;
  const url = sharedUrl(found[0]);
  if (!url) return null;
  const rest = text.replace(found[0], ' ').replace(/\s+/g, ' ').trim();
  return rest.length > CONTEXT ? null : { url, rest };
}

// Headings, lists, quotes, fences, tables, emphasis and links. One strong sign
// (a heading or code fence) or two weaker ones count as Markdown.
export function looksLikeMarkdown(text: string): boolean {
  if (/^(#{1,6}\s+\S|```|~~~)/m.test(text)) return true;
  const signs = [
    /^\s*[-*+]\s+\S/m,
    /^\s*\d+[.)]\s+\S/m,
    /^>\s?\S/m,
    /^\|.+\|\s*$/m,
    /\*\*[^*\n]+\*\*|__[^_\n]+__/,
    /\[[^\]\n]+\]\([^)\s]+\)/,
    /`[^`\n]+`/,
  ];
  return signs.filter((sign) => sign.test(text)).length >= 2;
}

const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');

export function classifyShare(share: IncomingShare, text = share.text ?? ''): ShareClass {
  const title = incomingShareTitle(share);
  const files = share.files;
  if (files.length) {
    if (files.length === 1 && isTextFile(files[0]!))
      return {
        kind:
          /\.(md|markdown)$/i.test(files[0]!.name) || files[0]!.mime === 'text/markdown'
            ? 'markdown'
            : 'text',
        title,
      };
    if (files.every((file) => file.mime === 'application/pdf') && files.length === 1)
      return { kind: 'pdf', title };
    if (files.every((file) => file.mime.startsWith('image/'))) return { kind: 'image', title };
    return { kind: 'files', title };
  }
  const subject = share.title?.trim();
  const paper = arxivOf(text);
  if (paper) return { kind: 'arxiv', title: subject || '', url: paper.url, arxivId: paper.id };
  const link = linkOf(text);
  if (link)
    return {
      kind: 'link',
      title: (subject || link.rest || host(link.url)).slice(0, 200),
      url: link.url,
    };
  return { kind: looksLikeMarkdown(text) ? 'markdown' : 'text', title };
}
