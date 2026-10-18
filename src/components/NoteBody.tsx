import { ArrowUpRight } from 'lucide-react';
import { fileUrl } from '../api';
import type { NoteDetail } from '../../shared/types';
import { CachedImage } from './CachedImage';
import { MarkdownView } from './LazyMarkdown';
import type { Heading } from './MarkdownView';
import { PaperView } from './PaperView';
import type { RecordStyle } from '../markdown-records';
import type { SectionControls } from './MarkdownSection';

// The readable body of a note, by kind. While editing, `content` is the draft.
export function NoteBody({
  note,
  editing,
  content,
  onNavigate,
  onImage,
  onHeadings,
  records,
  hideHeading,
  sections,
}: {
  note: NoteDetail;
  editing: boolean;
  content: string;
  onNavigate: (id: string) => void;
  onImage: (src: string, alt: string) => void;
  onHeadings: (headings: Heading[]) => void;
  records?: RecordStyle;
  hideHeading?: string;
  sections?: SectionControls;
}) {
  return (
    <div className="read-content" data-version-id={note.current_version_id}>
      {note.arxiv_id ? (
        <PaperView note={note} onHeadings={onHeadings} onImage={onImage} />
      ) : note.kind === 'markdown' ? (
        content ? (
          <MarkdownView
            content={editing ? content : note.content}
            onNavigate={onNavigate}
            onImage={onImage}
            onHeadings={onHeadings}
            records={records}
            hideHeading={editing ? undefined : hideHeading}
            sections={editing ? undefined : sections}
          />
        ) : (
          <p className="empty-body">暂无内容。点击「编辑正文」开始编辑。</p>
        )
      ) : note.kind === 'text' ? (
        <div className="plain-text">
          {((editing ? content : note.content) || '暂无内容')
            .split(/\r?\n\r?\n/)
            .map((paragraph, index) => (
              <p key={index}>{paragraph || ' '}</p>
            ))}
        </div>
      ) : note.kind === 'image' && note.file ? (
        <button
          className="image-node"
          aria-label="放大查看图片"
          onClick={() => onImage(fileUrl(note.file!.id), note.title)}
        >
          <CachedImage src={fileUrl(note.file.id)} alt={note.title} />
        </button>
      ) : note.kind === 'link' ? (
        <a
          className="external-link"
          href={note.url || '#'}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ArrowUpRight size={22} />
          <strong>打开网页</strong>
          <span>{note.url}</span>
        </a>
      ) : null}
    </div>
  );
}
