import { memo, useEffect, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
export interface Heading {
  id: string;
  title: string;
  level: number;
}
export const MarkdownView = memo(function MarkdownView({
  content,
  onNavigate,
  onImage,
  onHeadings,
  safeImages = false,
}: {
  content: string;
  onNavigate: (id: string) => void;
  onImage: (src: string, alt: string) => void;
  onHeadings?: (headings: Heading[]) => void;
  safeImages?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onHeadings?.(
      Array.from(ref.current?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? []).map((h) => ({
        id: h.id,
        title: h.textContent ?? '',
        level: Number(h.tagName[1]),
      })),
    );
  }, [content, onHeadings]);
  const heading =
    (level: number) =>
    ({
      node,
      children,
    }: {
      node?: { position?: { start: { offset?: number } } };
      children?: ReactNode;
    }) => {
      const id = safeImages ? undefined : `heading-${node?.position?.start.offset ?? 0}`,
        props = { id, children };
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
  return (
    <div ref={ref} className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={{
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
                <img
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
