import type { Element, Root, RootContent } from 'hast';
import type { VFile } from 'vfile';
import { renderToString, type KatexOptions } from 'katex';

export const mathOptions: KatexOptions = {
  trust: false,
  strict: 'ignore',
  maxExpand: 1000,
  maxSize: 20,
};

function compatibleDelimiters(value: string, displayMode: boolean): string {
  // Match escaped backslashes first, so a TeX row break is never rewritten.
  const candidate = value.replace(
    /\\(?:\\|(?:(?:bigg?|Bigg?)[lmr]?|left|right|middle)\s*([{}]))/g,
    (match, brace: string | undefined) => (brace ? `${match.slice(0, -1)}\\${brace}` : match),
  );
  if (candidate === value) return value;
  const options = { ...mathOptions, displayMode, throwOnError: true };
  try {
    renderToString(value, options);
    return value;
  } catch {
    try {
      renderToString(candidate, options);
      return candidate;
    } catch {
      // Preserve the original source when the narrow repair cannot render it.
      return value;
    }
  }
}

export function rehypeMathCompatibility() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    const walk = (node: Root | RootContent, parent?: Root | Element) => {
      if (node.type !== 'element' && node.type !== 'root') return;
      if (node.type === 'element' && node.tagName === 'code') {
        const classes = node.properties.className;
        if (
          Array.isArray(classes) &&
          classes.some(
            (name) => name === 'language-math' || name === 'math-inline' || name === 'math-display',
          )
        ) {
          const offset = node.position?.start.offset;
          // remark-math treats same-line $$...$$ as inline math. Keep the usual
          // display convention, including formulas inside a chat paragraph.
          if (
            classes.includes('math-inline') &&
            offset !== undefined &&
            source.startsWith('$$', offset)
          ) {
            node.properties.className = classes
              .filter((name) => name !== 'math-inline')
              .concat('math-display');
          }
          const display =
            node.properties.className?.includes('math-display') ||
            (parent?.type === 'element' && parent.tagName === 'pre');
          const text = node.children
            .map((child) => (child.type === 'text' ? child.value : ''))
            .join('');
          node.children = [{ type: 'text', value: compatibleDelimiters(text, !!display) }];
        }
      }
      for (const child of node.children) walk(child, node);
    };
    walk(tree);
  };
}

// Display math must look like TeX, so escaped brackets such as \[1\] stay text.
const TEX_HINT = /[\\^_{}=]/;
const MATH_DELIMITERS =
  /(\\*)\\\(((?:(?!\n[ \t]*\n)[^])+?)\\\)|(\\*)\\\[((?:(?!\n[ \t]*\n)[^])+?)\\\]/g;

function texDelimiters(text: string): string {
  return text.replace(
    MATH_DELIMITERS,
    (
      match,
      inlineSlashes: string | undefined,
      inline: string | undefined,
      displaySlashes: string | undefined,
      display: string | undefined,
      offset: number,
    ) => {
      const slashes = inlineSlashes ?? displaySlashes ?? '';
      // An odd run means the opening backslash is itself escaped, as in \\[2pt].
      if (slashes.length % 2) return match;
      // Keep the same length so source offsets for headings and sections hold.
      if (inline !== undefined) {
        // Pad outside when another formula follows, or the dollars would merge.
        return /^[\\$]/.test(text.slice(offset + match.length))
          ? `${slashes}$${inline}$  `
          : `${slashes}$ ${inline} $`;
      }
      return TEX_HINT.test(display ?? '') ? `${slashes}$$${display}$$` : match;
    },
  );
}

// remark-math only reads $ delimiters, but models often write \(...\) and \[...\],
// which Markdown would unescape into plain brackets. Code is left untouched.
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) return markdown;
  const lines = markdown.split(/(?<=\n)/);
  let out = '';
  let prose = '';
  let fence: string | undefined;
  const flush = () => {
    out += prose
      .split(/((`+)[^]*?(?<!`)\2(?!`))/)
      // Each split yields text, the code span, then its backtick run.
      .map((part, i) => [texDelimiters(part), part, ''][i % 3])
      .join('');
    prose = '';
  };
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      out += line;
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length)
      ) {
        fence = undefined;
      }
    } else if (marker) {
      flush();
      fence = marker;
      out += line;
    } else {
      prose += line;
    }
  }
  flush();
  return out;
}
