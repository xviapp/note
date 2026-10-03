import { Download, FolderOpen, Trash2 } from 'lucide-react';
import { fileUrl, formatBytes } from '../api';
import { type FileInfo } from '../../shared/types';
import { NodeIcon } from './Primitives';
import { CachedImage } from './CachedImage';

export function Attachments({
  files,
  editing,
  onRemove,
  onPreview,
  onCreate,
}: {
  files: FileInfo[];
  editing?: boolean;
  onRemove?: (id: string) => void;
  onPreview: (file: FileInfo) => void;
  onCreate?: (file: FileInfo) => void;
}) {
  if (!files.length) return null;
  return (
    <section className="attachments">
      <h3>
        附件 <span>{files.length}</span>
      </h3>
      {files.map((file) => (
        <div key={file.id} className="attachment-row">
          <button className="attachment-name" onClick={() => onPreview(file)}>
            {file.mime.startsWith('image/') ? (
              <span className="attachment-thumb">
                <CachedImage src={fileUrl(file.id)} alt="" loading="lazy" draggable={false} />
              </span>
            ) : (
              <NodeIcon kind={file.mime === 'application/pdf' ? 'pdf' : 'text'} />
            )}
            <span>
              {file.name}
              <small>{formatBytes(file.size)}</small>
            </span>
          </button>
          {onCreate && (file.mime === 'application/pdf' || file.mime.startsWith('image/')) && (
            <button
              className="button compact attachment-create"
              aria-label={`将 ${file.name} 添加到笔记树`}
              onClick={() => onCreate(file)}
            >
              <FolderOpen size={15} />
              放入目录
            </button>
          )}
          <a
            className="icon-button"
            aria-label={`下载 ${file.name}`}
            title="下载"
            href={fileUrl(file.id, true)}
          >
            <Download size={16} />
          </a>
          {editing && (
            <button
              className="icon-button danger-text"
              aria-label={`移除 ${file.name}`}
              onClick={() => onRemove?.(file.id)}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
