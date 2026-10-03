import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Spinner } from './Primitives';

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  count?: number;
  items: OutlineItem[];
}
export interface OutlinePosition {
  page: number;
  pageRatio: number;
  aspect: number;
}

async function destination(
  pdf: PDFDocumentProxy,
  target: OutlineItem['dest'],
): Promise<OutlinePosition> {
  const value = typeof target === 'string' ? await pdf.getDestination(target) : target;
  if (!Array.isArray(value) || !value.length) throw new Error('missing destination');
  const ref = value[0];
  const index =
    typeof ref === 'number' && Number.isInteger(ref)
      ? ref
      : ref &&
          typeof ref === 'object' &&
          'num' in ref &&
          'gen' in ref &&
          typeof ref.num === 'number' &&
          typeof ref.gen === 'number'
        ? await pdf.getPageIndex({ num: ref.num, gen: ref.gen })
        : -1;
  if (index < 0 || index >= pdf.numPages) throw new Error('invalid page');
  const page = await pdf.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  const mode = value[1] && typeof value[1] === 'object' && 'name' in value[1] ? value[1].name : '';
  const top =
    mode === 'XYZ'
      ? value[3]
      : mode === 'FitH' || mode === 'FitBH'
        ? value[2]
        : mode === 'FitR'
          ? value[5]
          : null;
  const left = mode === 'XYZ' || mode === 'FitR' ? value[2] : null;
  // Keep the user's zoom; convert the bookmark's PDF coordinates to a stable
  // page-relative reading position, including cropped or rotated pages.
  const y =
    typeof top === 'number' && Number.isFinite(top)
      ? viewport.convertToViewportPoint(
          typeof left === 'number' && Number.isFinite(left) ? left : page.view[0],
          top,
        )[1]
      : 0;
  return {
    page: index + 1,
    pageRatio: Math.max(0, Math.min(1, y / viewport.height)),
    aspect: viewport.height / viewport.width,
  };
}

function Entry({
  item,
  path,
  active,
  onSelect,
}: {
  item: OutlineItem;
  path: string;
  active: string;
  onSelect: (item: OutlineItem, path: string) => void;
}) {
  const [expanded, setExpanded] = useState((item.count ?? 0) >= 0);
  const title = item.title.trim() || '未命名章节';
  const children = item.items?.length > 0;
  return (
    <li>
      <div className="pdf-outline-row">
        {children ? (
          <button
            type="button"
            className="pdf-outline-expand"
            aria-label={`${expanded ? '收起' : '展开'} ${title}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="pdf-outline-indent" />
        )}
        {item.dest !== null ? (
          <button
            type="button"
            className="pdf-outline-link"
            aria-current={active === path ? 'location' : undefined}
            onClick={() => onSelect(item, path)}
          >
            {title}
          </button>
        ) : (
          <span className="pdf-outline-label">{title}</span>
        )}
      </div>
      {children && (
        <ul hidden={!expanded}>
          {item.items.map((child, index) => (
            <Entry
              key={index}
              item={child}
              path={`${path}.${index}`}
              active={active}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PdfOutline({
  pdf,
  onNavigate,
}: {
  pdf: PDFDocumentProxy;
  onNavigate: (position: OutlinePosition) => void;
}) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const request = useRef(0);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  useEffect(() => {
    let live = true;
    void pdf
      .getOutline()
      .then((outline) => {
        if (live) setItems(outline ?? []);
      })
      .catch(() => {
        if (live) setError('目录暂时无法读取，请重新打开 PDF。');
      });
    return () => {
      live = false;
      // request is a generation counter, not an element; bumping it is intended.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      request.current++;
    };
  }, [pdf]);
  const select = async (item: OutlineItem, path: string) => {
    const current = ++request.current;
    setError('');
    try {
      const position = await destination(pdf, item.dest);
      if (current !== request.current) return;
      onNavigateRef.current(position);
      setActive(path);
    } catch {
      if (current === request.current) setError('这一目录项无法定位，请使用页码跳转。');
    }
  };
  return (
    <nav className="pdf-outline-content" aria-label="PDF 目录">
      {error && (
        <p className="pdf-outline-message" role="alert">
          {error}
        </p>
      )}
      {!items ? (
        !error && <Spinner label="正在读取目录…" />
      ) : items.length ? (
        <ul>
          {items.map((item, index) => (
            <Entry
              key={index}
              item={item}
              path={String(index)}
              active={active}
              onSelect={(value, path) => {
                void select(value, path);
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="pdf-outline-message">此 PDF 没有内置目录。</p>
      )}
    </nav>
  );
}
