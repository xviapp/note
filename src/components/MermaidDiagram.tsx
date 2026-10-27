import { useEffect, useState } from 'react';
import { useTheme } from '../theme';

export function MermaidDiagram({ source, onImage }: {
  source: string;
  onImage: (src: string, alt: string) => void;
}) {
  const { theme } = useTheme();
  const [result, setResult] = useState<{ source: string; theme: string; image?: string; error?: boolean }>();
  useEffect(() => {
    let cancelled = false;
    void import('../mermaid').then(async ({ renderMermaid }) => {
      if (cancelled) return;
      const image = await renderMermaid(source, theme !== 'light');
      if (!cancelled) setResult({ source, theme, image });
    }).catch(() => {
      if (!cancelled) setResult({ source, theme, error: true });
    });
    return () => { cancelled = true; };
  }, [source, theme]);
  const current = result?.source === source && result.theme === theme ? result : undefined;
  return (
    <div className="mermaid-diagram">
      {current?.image ? (
        <img
          src={current.image}
          alt="Mermaid 图表"
          tabIndex={0}
          role="button"
          onClick={() => onImage(current.image!, 'Mermaid 图表')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onImage(current.image!, 'Mermaid 图表');
            }
          }}
        />
      ) : (
        <>
          <p className="mermaid-status" role="status">
            {current?.error ? '图表暂时无法绘制，请检查 Mermaid 语法；若语法无误，请刷新重试。' : '正在绘制图表…'}
          </p>
          <pre><code className="language-mermaid">{source}</code></pre>
        </>
      )}
    </div>
  );
}
