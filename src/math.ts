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
