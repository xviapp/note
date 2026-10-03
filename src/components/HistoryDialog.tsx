import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDate } from '../api';
import type { FileInfo, NoteDetail, VersionInfo } from '../../shared/types';
import { Modal, Spinner } from './Primitives';
import { MarkdownView, type Heading } from './MarkdownView';
import { Attachments } from './Attachments';

export function HistoryDialog({
  note,
  onClose,
  onRestore,
  onImage,
  onNavigate,
  onPreviewFile,
}: {
  note: NoteDetail;
  onClose: () => void;
  onRestore: (id: string) => Promise<void>;
  onImage: (src: string, alt: string) => void;
  onNavigate: (id: string) => void;
  onPreviewFile: (file: FileInfo) => void;
}) {
  const [versions, setVersions] = useState<VersionInfo[]>([]),
    [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<{ content: string; attachments: FileInfo[] } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [headings, setHeadings] = useState<Heading[]>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    api<{ versions: VersionInfo[] }>(`/api/nodes/${note.id}/versions`)
      .then((data) => {
        if (live) {
          setVersions(data.versions);
          setSelected(data.versions[0]?.id || '');
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [note.id]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setPreview(null);
    api<{ content: string; attachments: FileInfo[] }>(`/api/nodes/${note.id}/versions/${selected}`)
      .then((data) => {
        if (live) setPreview(data);
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [selected, note.id]);
  const onHeadings = useCallback((value: Heading[]) => setHeadings(value), []);
  return (
    <Modal
      title="版本历史"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <p className="dialog-copy">保留当前版本与最近 5 个历史版本。</p>
      <div className="history-layout">
        <div className="version-list">
          {versions.map((version) => (
            <button
              key={version.id}
              className={selected === version.id ? 'selected' : ''}
              onClick={() => setSelected(version.id)}
            >
              <strong>{version.current ? '当前版本' : `版本 ${version.sequence}`}</strong>
              <time>{formatDate(version.created_at)}</time>
            </button>
          ))}
        </div>
        <div className="version-preview" ref={previewRef}>
          {preview ? (
            <>
              {note.kind === 'markdown' ? (
                <>
                  <div className="history-toc">
                    {headings.map((h) => (
                      <button
                        className="text-button"
                        key={h.id}
                        onClick={() =>
                          previewRef.current
                            ?.querySelector(`#${h.id}`)
                            ?.scrollIntoView({ block: 'start' })
                        }
                      >
                        {h.title}
                      </button>
                    ))}
                  </div>
                  <MarkdownView
                    content={preview.content}
                    onImage={onImage}
                    onNavigate={(target) => {
                      onClose();
                      onNavigate(target);
                    }}
                    onHeadings={onHeadings}
                  />
                </>
              ) : (
                <pre className="plain-text">{preview.content}</pre>
              )}
              <Attachments files={preview.attachments} onPreview={onPreviewFile} />
            </>
          ) : (
            <Spinner />
          )}
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" onClick={onClose} disabled={busy}>
          关闭
        </button>
        <button
          className="button primary"
          disabled={busy || !selected || !!versions.find((v) => v.id === selected)?.current}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onRestore(selected);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '正在恢复…' : '恢复此版本'}
        </button>
      </div>
    </Modal>
  );
}
