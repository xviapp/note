// Renderers are created once per safeImages value in useMemo below.
// oxlint-disable react/no-unstable-nested-components
import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { mathOptions, rehypeMathCompatibility } from '../math';
import 'katex/dist/katex.min.css';
import '../math.css';
import { CachedImage } from './CachedImage';
import { markdownFrontMatter } from '../../shared/projects';
import { rehypeRecords, rehypeRepeatedTitle, type RecordStyle } from '../markdown-records';
import { rehypeSections } from '../markdown-sections';
import { MarkdownSection, type SectionControls } from './MarkdownSection';

// Sanitize Markdown before KaTeX generates its own markup, with trust disabled.
// https://github.com/rehypejs/rehype-sanitize#example-math
const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};
export interface Heading {
  id: string;
  title: string;
  level: number;
}
function prepareMarkdown(content: string) {
  const front = markdownFrontMatter(content);
  // Keep original offsets for heading IDs, links and reading positions.
  if (!front || !/^(title|status):/m.test(front[1])) return { rendered: content, bodyStart: 0 };
  const afterFront = content.slice(front[0].length);
  return {
    rendered: front[0].replace(/[^\r\n]/g, ' ') + afterFront,
    bodyStart: front[0].length + (afterFront.match(/^(?:[ \t]*\r?\n)*/)?.[0].length ?? 0),
  };
}
export const MarkdownView = memo(function MarkdownView({
  content,
  onNavigate,
  onImage,
  onHeadings,
  safeImages = false,
  records,
  hideHeading,
  sections,
}: {
  content: string;
  onNavigate: (id: string) => void;
  onImage: (src: string, alt: string) => void;
  onHeadings?: (headings: Heading[]) => void;
  safeImages?: boolean;
  // Lay out appended records of this kind (issue thread, todo progress, journal day).
  records?: RecordStyle;
  // A leading H1 with this text repeats the page heading and is hidden.
  hideHeading?: string;
  sections?: SectionControls;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sectionMode = !!sections;
  const { rendered, bodyStart } = useMemo(() => prepareMarkdown(content), [content]);
  // Appended records are listed by the page itself, so they stay out of the outline.
  useEffect(() => {
    onHeadings?.(
      Array.from(ref.current?.querySelectorAll(':is(h1,h2,h3,h4,h5,h6):not(.record-heading, .is-repeated-title)') ?? []).map((h) => ({
        id: h.id,
        title: h.textContent ?? '',
        level: Number(h.tagName[1]),
      })),
    );
  }, [content, hideHeading, onHeadings, sectionMode, sections?.activeStart]);
  // Renderers keep a stable identity, so a re-render does not remount images or
  // links; the latest callbacks are read when they run.
  const callbacks = useRef({ onNavigate, onImage, sections });
  callbacks.current = { onNavigate, onImage, sections };
  const components = useMemo<Components>(() => {
    const heading =
      (level: number) =>
      ({
        node,
        children,
        className,
        'data-label': label,
      }: {
        node?: { position?: { start: { offset?: number } } };
        children?: ReactNode;
        className?: string;
        // Set on record headings (see markdown-records.ts).
        'data-label'?: string;
      }) => {
        const id = safeImages ? undefined : `heading-${node?.position?.start.offset ?? 0}`,
          props = { id, children, className, 'data-label': label };
        switch (level) {
          case 1:
            return <h1 {...props} />;
          case 2:
            return <h2 {...props} />;
          case 3:
            return <h3 {...props} />;
          case 4:
            return <h4 {...props} />;
          case 5:
            return <h5 {...props} />;
          default:
            return <h6 {...props} />;
        }
      };
    const onNavigate = (id: string) => callbacks.current.onNavigate(id),
      onImage = (src: string, alt: string) => callbacks.current.onImage(src, alt);
    return {
      section: ({ node, children, ...props }) => {
        const start = node?.properties.dataSectionStart;
        const controls = callbacks.current.sections;
        if (typeof start !== 'number' || !controls) return <section {...props}>{children}</section>;
        return <MarkdownSection section={{
          start,
          end: Number(node!.properties.dataSectionEnd),
          title: String(node!.properties.dataSectionTitle),
          level: Number(node!.properties.dataSectionLevel),
          children: Number(node!.properties.dataSectionChildren),
        }} controls={controls}>{children}</MarkdownSection>;
      },
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
      a: ({ href, children }) => {
        const internal = href?.match(/^\/n\/([a-zA-Z0-9_-]+)$/);
        return (
          <a
            href={href}
            {...(internal
              ? {
                  onClick: (event: React.MouseEvent) => {
                    event.preventDefault();
                    onNavigate(internal[1]);
                  },
                }
              : { target: '_blank', rel: 'noopener noreferrer' })}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt }) =>
        typeof src === 'string' ? (
          safeImages ? (
            <a href={src} target="_blank" rel="noopener noreferrer">
              {alt || '查看图片链接'}
            </a>
          ) : (
            <CachedImage
              src={src}
              alt={alt ?? ''}
              loading="lazy"
              decoding="async"
              tabIndex={0}
              role="button"
              onClick={() => onImage(src, alt ?? '图片')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onImage(src, alt ?? '图片');
                }
              }}
            />
          )
        ) : null,
      input: (props) => <input {...props} disabled />,
    };
  }, [safeImages]);
  return (
    <div ref={ref} className={`markdown-body${records ? ` records-${records}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeSanitize, markdownSchema],
          [rehypeRecords, records],
          [rehypeRepeatedTitle, hideHeading],
          [rehypeSections, { enabled: !!sections, length: content.length, bodyStart }],
          rehypeMathCompatibility,
          [rehypeKatex, mathOptions],
        ]}
        skipHtml
        components={components}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  );
});
