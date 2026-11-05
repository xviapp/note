import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { stripFrontMatter, stripRepeatedTitle } from '../shared/blog';
import { mathOptions, normalizeMathDelimiters, rehypeMathCompatibility } from '../src/math';

// Same Markdown handling as the app's MarkdownView, minus its interactions.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};

const components: Components = {
  // Mermaid draws in the browser (src/blog/client.ts); its source stays readable until then.
  pre: ({ node, children, ...props }) => {
    const code = node?.children[0];
    if (
      code?.type === 'element' &&
      code.tagName === 'code' &&
      Array.isArray(code.properties.className) &&
      code.properties.className.includes('language-mermaid')
    )
      return createElement(
        'pre',
        { className: 'mermaid' },
        code.children.map((child) => (child.type === 'text' ? child.value : '')).join(''),
      );
    return createElement('pre', props, children);
  },
  // A link to a note that is not public keeps its text but goes nowhere.
  a: ({ href, children }) => {
    if (!href) return createElement('span', null, children as ReactNode);
    return href.startsWith('/') || href.startsWith('#')
      ? createElement('a', { href }, children as ReactNode)
      : createElement('a', { href, rel: 'noopener noreferrer' }, children as ReactNode);
  },
  img: ({ src, alt }) =>
    typeof src === 'string' && src
      ? createElement('img', { src, alt: alt ?? '', loading: 'lazy', decoding: 'async' })
      : null,
  input: (props) => createElement('input', { ...props, disabled: true }),
};

// `postHref` maps a note ID to its public address, or null if it has none.
export function renderPost(
  source: string,
  title: string,
  postHref: (nodeId: string) => string | null,
): string {
  const urlTransform = (url: string) => {
    const safe = defaultUrlTransform(url);
    const file = safe.match(/^\/api\/files\/([a-zA-Z0-9_-]{1,80})(?:[?#].*)?$/);
    if (file) return `/files/${file[1]}`;
    const note = safe.match(/^\/n\/([a-zA-Z0-9_-]+)$/);
    if (note) return postHref(note[1]) ?? '';
    // Nothing else under the app's own paths exists on the blog.
    return safe.startsWith('/api/') ? '' : safe;
  };
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: [
          [rehypeSanitize, schema],
          rehypeMathCompatibility,
          [rehypeKatex, mathOptions],
        ],
        skipHtml: true,
        components,
        urlTransform,
      },
      normalizeMathDelimiters(stripRepeatedTitle(stripFrontMatter(source), title)),
    ),
  );
}
